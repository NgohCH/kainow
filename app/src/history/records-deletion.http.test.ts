import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AssistRunner } from '../assist/assist-runner';
import { findMaterial } from '../assist/material';
import { loadReportRecords } from '../assist/reports.service';
import { uuidv7 } from '../common/uuid7';
import { buildDigest } from '../digests/digest';
import type { JsonSchemaModel, ModelRequest } from '../extraction/model';
import { ProjectAccess } from '../projects/access.service';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { aiDeps, aiReady, byAttempt } from '../testing/ai-runners';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const KEY = `sk-${'a1B2c3D4e5'.repeat(3)}`;
const REASON_REFUSAL = 'Give a reason (up to 1,000 characters).';
const DELETED_LINK = 'a deleted record';

/** Answers citing one marker. */
class AnswerModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  constructor(private readonly marker: string) {}
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ answer_markdown: `The pump service is booked [${this.marker}].`, not_found: false, cited: [this.marker] }), usage: USAGE };
  }
}

interface Source {
  marker: string;
  location: string | null;
}

describe('deleting and restoring authorised records', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let own: Client;
  let spo: Client;
  let ada: Client;
  let ben: Client;
  let auditor: Client;

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const del = (c: Client, kind: string, id: string, reason: unknown = 'Duplicate of an earlier record') => c.request('POST', `/records/${kind}/${id}/delete`, { reason });
  const restore = (c: Client, kind: string, id: string, reason: unknown = 'It was not a duplicate after all') => c.request('POST', `/records/${kind}/${id}/restore`, { reason });
  const deleted = async (c: Client, kind: string, id: string) => {
    const r = await del(c, kind, id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const restored = async (c: Client, kind: string, id: string) => {
    const r = await restore(c, kind, id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const deletedAt = async (table: string, id: string) =>
    (await t.pool.query(`SELECT deleted_at AS "at", deleted_by AS "by", delete_reason AS reason${table === 'tasks' ? ', deleted_with AS "with"' : ''} FROM ${table} WHERE id = $1`, [id])).rows[0];

  /** A task inserted as authorising would leave it. */
  const task = async (o: { title?: string; status?: string; parent?: string; depth?: number; assignee?: string; due?: string; follows?: string } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, completed_at, follows_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11)`,
      [id, project, o.parent ?? null, o.depth ?? 0, o.title ?? 'Task', o.assignee ?? ids.ada, o.due ?? '2026-11-20', o.status ?? 'not_started', ids.own,
        o.status === 'completed' ? new Date() : null, o.follows ?? null],
    );
    return id;
  };
  const proposal = async (kind: string, text: string) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at) VALUES ($1, $2, $3, $4, $5, now(), 'approved', $5, now())`,
      [id, project, kind, text, ids.own],
    );
    return id;
  };
  const decision = async (o: { statement?: string; status?: string; replaces?: string } = {}) => {
    const id = uuidv7();
    const statement = o.statement ?? 'Use the north entrance';
    await t.pool.query(
      `INSERT INTO decisions (id, project_id, statement, status, origin_proposal_id, replaces_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [id, project, statement, o.status ?? 'active', await proposal('decision', statement), o.replaces ?? null, ids.own],
    );
    return id;
  };
  const question = async (status = 'resolved', text = 'Who signs the permit?') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, status, requester_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [id, project, text, status, ids.ada, await proposal('question', text), ids.own],
    );
    return id;
  };
  const risk = async (status: string, reviewOn: string | null, description = 'Supplier may be late') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, status, responsible_id, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, 'medium', $4, $5, $6, $7, $8, now())`,
      [id, project, description, status, ids.ada, reviewOn, await proposal('risk', description), ids.own],
    );
    return id;
  };
  const records = async (c: Client = own) => {
    const r = await c.request('GET', `/projects/${project}/records`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  beforeEach(async () => {
    t = await startTestApp(undefined, { assistQueue: { enqueue: async () => undefined } });
    for (const k of ['pm', 'own', 'spo', 'dep', 'ada', 'ben', 'auditor', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.own, role: 'owner' },
        { userId: ids.spo, role: 'sponsor' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    await aiReady(t.pool, project);
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), project, ids.auditor, ids.pm, ids.admin],
    );
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, own, spo, ada, ben, auditor] = [
      await t.signIn('pm@example.org'),
      await t.signIn('own@example.org'),
      await t.signIn('spo@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('auditor@example.org'),
    ];
  });
  afterEach(async () => {
    await t.close();
  });

  test('Owner deletes a cancelled task; PM refused without delegation', async () => {
    const id = await task({ status: 'cancelled', title: 'Order kestrel valves' });
    // The PM (no delegation yet), a Member and a grant holder may not delete; outside the project it does not exist.
    for (const c of [pm, ada, auditor]) assert.equal((await del(c, 'task', id)).status, 403);
    assert.equal((await del(await t.signIn('outsider@example.org'), 'task', id)).status, 404);
    assert.equal((await del(own, 'task', uuidv7())).status, 404);
    assert.equal((await del(own, 'task', 'not-a-uuid')).status, 404);
    assert.equal((await del(own, 'widgets', id)).status, 404);
    for (const reason of [null, '', '   ', 'x'.repeat(1001), 42]) {
      const r = await del(own, 'task', id, reason);
      assert.deepEqual([r.status, r.body.message], [400, REASON_REFUSAL]);
    }
    const secret = await del(own, 'task', id, `the key was ${KEY}`);
    assert.equal(secret.status, 400);
    assert.ok(!JSON.stringify(secret.body).includes(KEY));
    // Not in a final state: the refusal names the state needed.
    const open = await task({ status: 'in_progress' });
    const refused = await del(own, 'task', open);
    assert.deepEqual([refused.status, refused.body.message], [409, 'Cancel this task before deleting it.']);
    assert.equal(await count(`SELECT count(*) AS n FROM task_events`), 0);

    t.clock.advanceSeconds(5);
    const r = await del(own, 'task', id, '  Duplicate of an earlier task  ');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { kind: 'task', id, deleted: true });
    assert.deepEqual(await deletedAt('tasks', id), { at: t.clock.now(), by: ids.own, reason: 'Duplicate of an earlier task', with: null });
    assert.equal((await t.pool.query(`SELECT status FROM tasks WHERE id = $1`, [id])).rows[0].status, 'cancelled', 'the status is kept');
    const ev = (await t.pool.query(`SELECT kind, from_status, to_status, note, actor_id FROM task_events WHERE task_id = $1`, [id])).rows;
    assert.deepEqual(ev, [{ kind: 'deleted', from_status: 'cancelled', to_status: 'cancelled', note: 'Duplicate of an earlier task', actor_id: ids.own }]);
    const audit = (await t.pool.query(`SELECT actor_user_id, subject_type, subject_id, detail FROM audit_events WHERE action = 'record.deleted'`)).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].actor_user_id, audit[0].subject_type, audit[0].subject_id], [ids.own, 'task', id]);
    assert.ok(!JSON.stringify(audit[0].detail).includes('Duplicate') && !JSON.stringify(audit[0].detail).includes('kestrel'));

    // Gone for everyone; a second delete and any change to it answer as for a missing record.
    assert.equal((await own.request('GET', `/records/tasks/${id}`)).status, 404);
    assert.equal((await del(own, 'task', id)).status, 409);
    assert.equal((await pm.request('POST', `/records/tasks/${id}/reopen`, { note: 'Again' })).status, 404);
    const amend = await own.request('POST', `/projects/${project}/changes`, { kind: 'amend_task', targetKind: 'task', targetId: id, terms: { title: 'New' }, reason: 'x' });
    assert.equal(amend.status, 404);

    // A Sponsor deletes the other kinds from their final states.
    await deleted(spo, 'task', await task({ status: 'completed' }));
    await deleted(spo, 'decision', await decision({ status: 'withdrawn' }));
    await deleted(spo, 'decision', await decision({ status: 'superseded' }));
    const q = await question('resolved');
    await deleted(spo, 'question', q);
    await deleted(spo, 'question', await question('withdrawn'));
    await deleted(spo, 'risk', await risk('resolved', null));
    await deleted(spo, 'risk', await risk('accepted', null));
    const events = (await t.pool.query(`SELECT kind, note FROM record_events WHERE record_id = $1`, [q])).rows;
    assert.deepEqual(events, [{ kind: 'deleted', note: 'Duplicate of an earlier record' }]);
    // Answering a Deleted question is refused like a missing one.
    assert.equal((await ada.request('POST', `/records/questions/${q}/answer`, { text: 'The PM' })).status, 404);
    for (const [kind, id2, message] of [
      ['decision', await decision(), 'Withdraw or supersede this decision before deleting it.'],
      ['question', await question('answered'), 'Resolve or withdraw this question before deleting it.'],
      ['risk', await risk('accepted', '2026-12-01'), 'Resolve this risk, or accept it with no further review, before deleting it.'],
    ] as const) {
      const x = await del(own, kind, id2);
      assert.deepEqual([x.status, x.body.message], [409, message]);
    }

    // Deferred: deleting is refused, restoring still works (Q04).
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    assert.equal((await del(own, 'task', await task({ status: 'cancelled' }))).status, 403);
    assert.deepEqual(await restored(own, 'task', id), { kind: 'task', id, deleted: false, status: 'cancelled' });
  });

  test('deleting a task deletes its final subtasks and records deleted_with', async () => {
    const parent = await task({ status: 'cancelled' });
    const a = await task({ status: 'completed', parent, depth: 1 });
    const b = await task({ status: 'cancelled', parent, depth: 1 });
    const aa = await task({ status: 'cancelled', parent: a, depth: 2 });
    await deleted(own, 'task', parent);
    for (const id of [a, b, aa]) assert.deepEqual(await deletedAt('tasks', id), { at: t.clock.now(), by: ids.own, reason: 'Duplicate of an earlier record', with: parent });
    assert.equal((await deletedAt('tasks', parent)).with, null);
    assert.equal(await count(`SELECT count(*) AS n FROM task_events WHERE kind = 'deleted'`), 4);
    assert.deepEqual((await records()).tasks, []);
  });

  test('deleting a parent with an open subtask is refused', async () => {
    const parent = await task({ status: 'completed' });
    const open = await task({ status: 'in_progress', parent, depth: 1 });
    await task({ status: 'cancelled', parent, depth: 1 });
    const r = await del(own, 'task', parent);
    assert.deepEqual([r.status, r.body.message], [409, 'Cancel or complete every subtask before deleting this task.']);
    assert.equal(await count(`SELECT count(*) AS n FROM tasks WHERE deleted_at IS NOT NULL`), 0);
    assert.equal((await deletedAt('tasks', open)).at, null);
  });

  test('restoring a parent brings back only the subtasks deleted with it', async () => {
    const parent = await task({ status: 'cancelled' });
    const a = await task({ status: 'cancelled', parent, depth: 1 });
    const b = await task({ status: 'cancelled', parent, depth: 1 });
    await deleted(own, 'task', b);
    t.clock.advanceSeconds(60);
    await deleted(own, 'task', parent);
    assert.equal((await deletedAt('tasks', a)).with, parent);
    assert.equal((await deletedAt('tasks', b)).with, null, 'deleted on its own earlier');

    // The preview names every current participant and Active grant holder; the PM, a Member and a grant holder may not.
    for (const c of [pm, ada, auditor]) assert.equal((await c.request('GET', `/records/task/${parent}/restore-preview`)).status, 403);
    const preview = await own.request('GET', `/records/task/${parent}/restore-preview`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body, { names: ['ada', 'auditor', 'ben', 'dep', 'own', 'pm', 'spo'] });
    assert.equal((await own.request('GET', `/records/task/${await task({ status: 'cancelled' })}/restore-preview`)).status, 409);

    t.clock.advanceSeconds(60);
    await restored(own, 'task', parent);
    assert.deepEqual(await deletedAt('tasks', parent), { at: null, by: null, reason: null, with: null });
    assert.deepEqual(await deletedAt('tasks', a), { at: null, by: null, reason: null, with: null });
    assert.notEqual((await deletedAt('tasks', b)).at, null, 'b stays Deleted');
    const kinds = (await t.pool.query(`SELECT task_id, kind FROM task_events WHERE kind = 'restored' ORDER BY task_id`)).rows;
    assert.deepEqual(kinds.map((k) => k.task_id).sort(), [parent, a].sort());
    const listed = (await records()).tasks.map((x: { id: string }) => x.id);
    assert.ok(listed.includes(parent) && listed.includes(a) && !listed.includes(b));
    assert.equal((await restore(own, 'task', parent)).status, 409, 'not deleted');
  });

  test('a subtask cannot be restored while its parent is deleted', async () => {
    const parent = await task({ status: 'cancelled' });
    const a = await task({ status: 'cancelled', parent, depth: 1 });
    const b = await task({ status: 'cancelled', parent, depth: 1 });
    await deleted(own, 'task', b);
    await deleted(own, 'task', parent);
    for (const id of [a, b]) {
      const r = await restore(own, 'task', id);
      assert.deepEqual([r.status, r.body.message], [409, 'Restore the parent task first.']);
    }
    await restored(own, 'task', parent);
    await restored(own, 'task', b);
    assert.equal((await deletedAt('tasks', b)).at, null);
  });

  test('deleted task leaves lists, progress, search, digest and Ask material', async () => {
    const gone = await task({ status: 'completed', title: 'Order kestrel valves', due: '2026-11-05' });
    const kept = await task({ status: 'in_progress', title: 'Check kestrel pumps' });
    const parent = await task({ status: 'in_progress', title: 'Parent work' });
    const sub = await task({ status: 'cancelled', parent, depth: 1, title: 'Sub kestrel' });
    const q = await question('resolved', 'Which kestrel supplier?');
    await t.pool.query(`INSERT INTO question_answers (id, question_id, answer, author_id, at) VALUES ($1, $2, 'The kestrel answer', $3, now())`, [uuidv7(), q, ids.ada]);
    const d = await decision({ status: 'withdrawn', statement: 'Buy kestrel spares' });
    await t.pool.query(
      `INSERT INTO review_flags (id, project_id, record_kind, record_id, cause, decision_id, raised_by, raised_at) VALUES ($1, $2, 'task', $3, 'decision_changed', $4, $5, now())`,
      [uuidv7(), project, gone, d, ids.own],
    );
    for (const [kind, id] of [['task', gone], ['task', sub], ['question', q]] as const) await deleted(own, kind, id);

    // Lists, flags and counts.
    const list = await records();
    assert.deepEqual(list.tasks.map((x: { id: string }) => x.id).sort(), [kept, parent].sort());
    assert.deepEqual(list.questions, []);
    assert.equal((await own.request('GET', `/projects/${project}`)).body.project.openReviewFlags, 0);
    // Progress: report material counts only live tasks.
    const facts = await loadReportRecords(t.pool, project);
    assert.deepEqual(facts.tasks.map((x: { id: string }) => x.id).sort(), [kept, parent].sort());
    assert.deepEqual(facts.questions, []);
    // A deleted subtask no longer holds its parent back.
    assert.equal((await ada.request('POST', `/records/tasks/${parent}/complete`, { note: 'Done' })).status, 200);
    // Search.
    const s = await own.request('GET', `/search?q=kestrel`);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const found = s.body.projects[0].results.map((x: { id: string }) => x.id);
    for (const id of [gone, sub, q]) assert.ok(!found.includes(id), `search found ${id}`);
    assert.ok(found.includes(kept), JSON.stringify(s.body));
    // Digest.
    const digest = await buildDigest(t.pool, project, ids.ada, t.clock.now());
    assert.ok(!digest.body.includes('Order kestrel valves'));
    // Ask material.
    const ctx = (await t.app.get(ProjectAccess).load(project, { id: ids.ada, email: 'ada@example.org', displayName: 'ada', role: 'member' }))!;
    const material = await findMaterial(t.pool, { kind: 'personal', ctx }, ['kestrel']);
    const recordIds = material.map((m) => m.recordId);
    for (const id of [gone, sub, q]) assert.ok(!recordIds.includes(id), `material held ${id}`);
    assert.ok(recordIds.includes(kept));
  });

  test('a decision replacing a deleted one shows a deleted record', async () => {
    const old = await decision({ status: 'superseded', statement: 'Use the north entrance' });
    const now = await decision({ replaces: old, statement: 'Use the south entrance' });
    const first = await task({ status: 'cancelled', title: 'First attempt' });
    const next = await task({ status: 'not_started', title: 'Second attempt', follows: first });
    await deleted(own, 'decision', old);
    await deleted(own, 'task', first);
    const list = await records(ada);
    assert.deepEqual(list.decisions.map((x: { id: string }) => x.id), [now]);
    assert.deepEqual(list.decisions[0].replaces, { id: null, statement: DELETED_LINK });
    const t2 = list.tasks.find((x: { id: string }) => x.id === next);
    assert.deepEqual(t2.follows, { id: null, title: DELETED_LINK });
    assert.ok(!JSON.stringify(list).includes('north entrance') && !JSON.stringify(list).includes('First attempt'));
    // Restored, the links read as before.
    await restored(own, 'decision', old);
    assert.deepEqual((await records(ada)).decisions.find((x: { id: string }) => x.id === now).replaces, { id: old, statement: 'Use the north entrance' });
  });

  test('a shared answer whose material held the record snapshot goes to review', async () => {
    const id = await task({ status: 'completed', title: 'Pump service booking' });
    const threadReply = await pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plant' });
    assert.equal(threadReply.status, 201, JSON.stringify(threadReply.body));
    const ask = async (c: Client) => {
      const r = await c.request('POST', `/projects/${project}/questions`, { question: 'When is the pump service booking?' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const rec = (r.body.sources as Source[]).find((s) => s.location?.includes('Pump service booking')) as Source;
      assert.ok(rec, JSON.stringify(r.body.sources));
      const runner = byAttempt(t.pool, 'ai_requests', new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(new AnswerModel(rec.marker)), clock: t.clock.now }));
      assert.equal(await runner.process(r.body.id, 1, false), 'succeeded');
      t.clock.advanceSeconds(1);
      return r.body.id as string;
    };
    const shared = await ask(ada);
    const share = await ada.request('POST', `/questions/${shared}/share`, { threadId: threadReply.body.id });
    assert.equal(share.status, 200, JSON.stringify(share.body));
    const privateOne = await ask(ben);
    await deleted(own, 'task', id);
    const state = async (rid: string) => (await t.pool.query(`SELECT review_state FROM ai_answers WHERE request_id = $1`, [rid])).rows[0].review_state;
    assert.equal(await state(shared), 'review_required');
    assert.equal(await state(privateOne), 'withdrawn');
    const causes = (await t.pool.query(`SELECT detail->>'cause' AS cause FROM ai_assist_events WHERE action IN ('withdrawn', 'review_required') AND target_kind = 'answer'`)).rows;
    assert.deepEqual(causes.map((c) => c.cause), ['record_deleted', 'record_deleted']);
    // Restoring brings nothing back.
    await restored(own, 'task', id);
    assert.deepEqual([await state(shared), await state(privateOne)], ['review_required', 'withdrawn']);
  });

  test('restored task keeps its status and history, no reminder is created', async () => {
    const id = await task({ status: 'cancelled', due: '2026-11-02' });
    await t.pool.query(
      `INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at) VALUES ($1, $2, 'started', 'not_started', 'in_progress', $3, $4)`,
      [uuidv7(), id, ids.ada, new Date(t.clock.now().getTime() - 2 * 86_400_000)],
    );
    const r = await risk('accepted', null);
    await deleted(own, 'task', id);
    await deleted(own, 'risk', r);
    const before = {
      notifications: await count(`SELECT count(*) AS n FROM notifications`),
      triggers: await count(`SELECT count(*) AS n FROM notification_triggers`),
      outbox: (await t.outbox()).length,
    };
    t.clock.advanceSeconds(60);
    assert.deepEqual(await restored(own, 'task', id), { kind: 'task', id, deleted: false, status: 'cancelled' });
    assert.deepEqual(await restored(own, 'risk', r), { kind: 'risk', id: r, deleted: false, status: 'accepted' });
    const view = await ada.request('GET', `/records/tasks/${id}`);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.task.status, 'cancelled');
    assert.deepEqual(view.body.history.map((h: { kind: string }) => h.kind), ['started', 'deleted', 'restored']);
    assert.equal((await t.pool.query(`SELECT review_on FROM risks WHERE id = $1`, [r])).rows[0].review_on, null);
    assert.deepEqual(
      {
        notifications: await count(`SELECT count(*) AS n FROM notifications`),
        triggers: await count(`SELECT count(*) AS n FROM notification_triggers`),
        outbox: (await t.outbox()).length,
      },
      before,
    );
    const ev = (await t.pool.query(`SELECT kind, note FROM record_events WHERE record_id = $1 ORDER BY at`, [r])).rows;
    assert.deepEqual(ev, [{ kind: 'deleted', note: 'Duplicate of an earlier record' }, { kind: 'restored', note: 'It was not a duplicate after all' }]);
  });
});
