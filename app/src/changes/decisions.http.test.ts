import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const NOT_ALLOWED = 'Only an Owner or Sponsor can replace or withdraw a decision.';
const NOT_ACTIVE = 'Only an active decision can be replaced or withdrawn.';

describe('replacing and withdrawing decisions', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let deputy: Client;
  let owner: Client;
  let sponsor: Client;
  let ann: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'deputy', 'owner', 'sponsor', 'ann']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    deputy = await t.signIn('deputy@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    ann = await t.signIn('ann@example.org');
    await (await t.signIn('admin@example.org')).request('POST', '/domains', { domain: 'example.org' });
  });
  afterEach(async () => {
    await t?.close();
  });

  const decision = async (statement = 'Move to the new system') => {
    const id = uuidv7();
    const proposal = uuidv7();
    await t.pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'decision', 'D', $3, now())`, [proposal, projectId, ids.owner]);
    await t.pool.query(
      `INSERT INTO decisions (id, project_id, statement, rationale, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, 'Cheaper', $4, $5, now())`,
      [id, projectId, statement, proposal, ids.owner],
    );
    return id;
  };
  const task = async (status = 'not_started') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) VALUES ($1, $2, 0, 'Task', $3, '2026-11-20', $4, $5, now())`,
      [id, projectId, ids.ann, status, ids.owner],
    );
    return id;
  };
  const question = async (status = 'open') => {
    const id = uuidv7();
    const proposal = uuidv7();
    await t.pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'question', 'Q', $3, now())`, [proposal, projectId, ids.owner]);
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'Which vendor?', $3, $4, $5, $3, now())`,
      [id, projectId, ids.owner, status, proposal],
    );
    return id;
  };
  const risk = async () => {
    const id = uuidv7();
    const proposal = uuidv7();
    await t.pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', 'R', $3, now())`, [proposal, projectId, ids.owner]);
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, status, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'Delay', 'high', 'open', $3, $4, now())`,
      [id, projectId, proposal, ids.owner],
    );
    return id;
  };
  const submit = (c: Client, kind: 'supersede_decision' | 'withdraw_decision', id: string, terms: object, approve = false) =>
    c.request('POST', `/projects/${projectId}/changes`, { kind, targetKind: 'decision', targetId: id, terms, approve });
  const records = async (c: Client) => (await c.request('GET', `/projects/${projectId}/records`)).body;
  const flags = async () => (await t.pool.query(`SELECT * FROM review_flags ORDER BY record_kind, raised_at, id`)).rows;

  test('replacing a decision links the two and flags the chosen work', async () => {
    const old = await decision();
    const a = await task();
    const other = await task();
    const q = await question();
    const k = await risk();
    const r = await submit(owner, 'supersede_decision', old, {
      statement: 'Stay on the old system',
      rationale: 'Migration is too risky',
      reason: 'The vendor withdrew',
      affected: [{ kind: 'task', id: a }, { kind: 'question', id: q }, { kind: 'risk', id: k }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await flags()).length, 0, 'nothing is flagged until it is authorised');
    t.clock.advanceSeconds(60);
    const ok = await owner.request('POST', `/changes/${r.body.request.id}/approve`, { version: 1 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const newId = ok.body.applied.record.id;
    const list = await records(ann);
    const oldView = list.decisions.find((d: { id: string }) => d.id === old);
    const newView = list.decisions.find((d: { id: string }) => d.id === newId);
    assert.equal(oldView.status, 'superseded');
    assert.equal(newView.status, 'active');
    assert.equal(newView.statement, 'Stay on the old system');
    assert.equal(newView.rationale, 'Migration is too risky');
    assert.equal(newView.replaces.id, old);
    assert.equal(oldView.replacedBy.id, newId);
    assert.deepEqual(oldView.mayAct, []);
    assert.deepEqual(newView.mayAct, [], 'a Member sees no actions');
    assert.deepEqual((await records(owner)).decisions.find((d: { id: string }) => d.id === newId).mayAct, ['supersede', 'withdraw']);
    assert.deepEqual((await records(owner)).decisions.find((d: { id: string }) => d.id === old).mayAct, []);
    const rows = await flags();
    assert.deepEqual(rows.map((f) => f.record_kind), ['question', 'risk', 'task']);
    assert.ok(rows.every((f) => f.cause === 'decision_changed' && f.cleared_at === null && f.raised_by === ids.owner));
    assert.equal(list.tasks.find((x: { id: string }) => x.id === a).reviewFlags.length, 1);
    assert.deepEqual(list.tasks.find((x: { id: string }) => x.id === other).reviewFlags, []);
    assert.equal(list.questions[0].reviewFlags.length, 1);
    assert.equal(list.risks[0].reviewFlags.length, 1);
    const events = (await t.pool.query(`SELECT record_id, kind, from_status, to_status, note FROM record_events WHERE record_kind = 'decision' ORDER BY kind`)).rows;
    assert.deepEqual(events.map((e) => [e.record_id, e.kind, e.note]), [
      [newId, 'replaces', 'The vendor withdrew'],
      [old, 'superseded', 'The vendor withdrew'],
    ]);
  });

  test('withdrawing flags without replacing', async () => {
    const old = await decision();
    const a = await task();
    const r = await submit(sponsor, 'withdraw_decision', old, { reason: 'No longer needed', affected: [{ kind: 'task', id: a }] }, true);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.applied.record.id, old);
    const list = await records(ann);
    assert.equal(list.decisions.length, 1);
    assert.equal(list.decisions[0].status, 'withdrawn');
    assert.equal(list.decisions[0].replacedBy, null);
    assert.equal((await flags()).length, 1);
    const events = (await t.pool.query(`SELECT kind, from_status, to_status, note FROM record_events WHERE record_id = $1`, [old])).rows;
    assert.deepEqual(events, [{ kind: 'withdrawn', from_status: 'active', to_status: 'withdrawn', note: 'No longer needed' }]);
  });

  test('a superseded decision cannot be replaced again', async () => {
    const old = await decision();
    const first = await submit(owner, 'supersede_decision', old, { statement: 'New', reason: 'Because', affected: [] }, true);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await submit(owner, 'supersede_decision', old, { statement: 'Newer', reason: 'Because', affected: [] });
    assert.deepEqual([again.status, again.body.message], [409, NOT_ACTIVE]);
    const withdraw = await submit(owner, 'withdraw_decision', old, { reason: 'x', affected: [] });
    assert.deepEqual([withdraw.status, withdraw.body.message], [409, NOT_ACTIVE]);
    // The replacement can itself be replaced.
    const replacement = first.body.applied.record.id;
    const next = await submit(sponsor, 'supersede_decision', replacement, { statement: 'Newest', reason: 'Again', affected: [] }, true);
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.equal((await records(owner)).decisions.filter((d: { status: string }) => d.status === 'active').length, 1);
  });

  test('a Member, the PM and a Deputy cannot propose', async () => {
    const old = await decision();
    for (const c of [ann, pm, deputy]) {
      const r = await submit(c, 'supersede_decision', old, { statement: 'New', reason: 'x', affected: [] });
      assert.deepEqual([r.status, r.body.message], [403, NOT_ALLOWED]);
    }
    const w = await submit(ann, 'withdraw_decision', old, { reason: 'x', affected: [] });
    assert.deepEqual([w.status, w.body.message], [403, NOT_ALLOWED]);
  });

  test('the terms are checked', async () => {
    const old = await decision();
    const noReason = await submit(owner, 'supersede_decision', old, { statement: 'New', affected: [] });
    assert.deepEqual([noReason.status, noReason.body.message], [400, 'A reason is required.']);
    const noStatement = await submit(owner, 'supersede_decision', old, { reason: 'x', affected: [] });
    assert.equal(noStatement.status, 400);
    const stranger = await submit(owner, 'withdraw_decision', old, { reason: 'x', affected: [{ kind: 'task', id: uuidv7() }] });
    assert.equal(stranger.status, 400);
  });

  test('work that is no longer open at approval is dropped, and the request says so', async () => {
    const old = await decision();
    const a = await task();
    const b = await task();
    const r = await submit(owner, 'withdraw_decision', old, { reason: 'x', affected: [{ kind: 'task', id: a }, { kind: 'task', id: b }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await t.pool.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [b]);
    t.clock.advanceSeconds(60);
    const ok = await sponsor.request('POST', `/changes/${r.body.request.id}/approve`, { version: 1 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((await flags()).map((f) => f.record_id), [a]);
    const stored = (await owner.request('GET', `/projects/${projectId}/changes`)).body.requests.find((x: { id: string }) => x.id === r.body.request.id);
    assert.equal(stored.status, 'authorised');
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'decision.withdrawn'`)).rows[0].detail;
    assert.deepEqual(audit.dropped, [{ kind: 'task', id: b }]);
  });

  test('flags never block work', async () => {
    const old = await decision();
    const a = await task();
    await submit(owner, 'withdraw_decision', old, { reason: 'x', affected: [{ kind: 'task', id: a }] }, true);
    assert.equal((await flags()).length, 1);
    const start = await ann.request('POST', `/records/tasks/${a}/start`, {});
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const done = await ann.request('POST', `/records/tasks/${a}/complete`, { note: 'Done' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
  });

  test('the PM clears a flag with a note', async () => {
    const old = await decision();
    const a = await task();
    await submit(owner, 'withdraw_decision', old, { reason: 'x', affected: [{ kind: 'task', id: a }] }, true);
    const flag = (await flags())[0].id;
    const denied = await ann.request('POST', `/review-flags/${flag}/clear`, { note: 'Looked' });
    assert.deepEqual([denied.status, denied.body.message], [403, 'Only the Project Manager or a Deputy can clear a review flag.']);
    const ownerDenied = await owner.request('POST', `/review-flags/${flag}/clear`, { note: 'Looked' });
    assert.equal(ownerDenied.status, 403);
    const blank = await pm.request('POST', `/review-flags/${flag}/clear`, { note: '  ' });
    assert.deepEqual([blank.status, blank.body.message], [400, 'Write a note about what was reviewed.']);
    const ok = await pm.request('POST', `/review-flags/${flag}/clear`, { note: 'Still valid under the new decision' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const row = (await flags())[0];
    assert.deepEqual([row.cleared_by, row.note], [ids.pm, 'Still valid under the new decision']);
    assert.deepEqual((await records(ann)).tasks[0].reviewFlags, []);
    const again = await deputy.request('POST', `/review-flags/${flag}/clear`, { note: 'Again' });
    assert.deepEqual([again.status, again.body.message], [409, 'This flag is already cleared.']);
    const missing = await pm.request('POST', `/review-flags/${uuidv7()}/clear`, { note: 'x' });
    assert.equal(missing.status, 404);
  });

  test('a flag cannot be cleared unless the project is Active', async () => {
    const old = await decision();
    const a = await task();
    await submit(owner, 'withdraw_decision', old, { reason: 'x', affected: [{ kind: 'task', id: a }] }, true);
    const flag = (await flags())[0].id;
    for (const status of ['deferred', 'closed', 'planned']) {
      await t.pool.query(`UPDATE projects SET status = $2 WHERE id = $1`, [projectId, status]);
      const r = await pm.request('POST', `/review-flags/${flag}/clear`, { note: 'Looked' });
      assert.deepEqual([status, r.status, r.body.message], [status, 409, 'Records change only while the project is Active.']);
    }
    assert.equal((await flags())[0].cleared_at, null);
    await t.pool.query(`UPDATE projects SET status = 'active' WHERE id = $1`, [projectId]);
    assert.equal((await pm.request('POST', `/review-flags/${flag}/clear`, { note: 'Looked' })).status, 200);
  });

  test('a Deputy can clear a flag', async () => {
    const old = await decision();
    const a = await task();
    await submit(owner, 'withdraw_decision', old, { reason: 'x', affected: [{ kind: 'task', id: a }] }, true);
    const ok = await deputy.request('POST', `/review-flags/${(await flags())[0].id}/clear`, { note: 'Fine' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test('the overview counts open flags', async () => {
    const old = await decision();
    const a = await task();
    const q = await question();
    const project = async () => (await pm.request('GET', `/projects/${projectId}`)).body.project;
    assert.equal((await project()).openReviewFlags, 0);
    await submit(owner, 'withdraw_decision', old, { reason: 'x', affected: [{ kind: 'task', id: a }, { kind: 'question', id: q }] }, true);
    assert.equal((await project()).openReviewFlags, 2);
    await pm.request('POST', `/review-flags/${(await flags())[0].id}/clear`, { note: 'Reviewed' });
    assert.equal((await project()).openReviewFlags, 1);
  });
});
