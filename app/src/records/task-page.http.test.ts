import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const TEXT = 'Ann will export the records by 20 November 2026.';
const TOO_LONG = 'Write a description of up to 4,000 characters.';
const CREDENTIAL = `the key is sk-${'a1B2c3D4e5'.repeat(3)}`;
const LOOKS_LIKE = /this looks like it contains/;

/** The task page's reply and the task description (11a.1, D133). */
describe('the task page', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let owner: Client;
  let ann: Client;
  let ben: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'ann', 'ben', 'outsider', 'auditor']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    [pm, owner, ann, ben] = [await t.signIn('pm@example.org'), await t.signIn('owner@example.org'), await t.signIn('ann@example.org'), await t.signIn('ben@example.org')];
  });
  afterEach(async () => {
    await t?.close();
  });

  const task = async (over: { parent?: string; depth?: number; status?: string; title?: string; due?: string; description?: string } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-11-02T02:00:00Z', $10)`,
      [id, projectId, over.parent ?? null, over.depth ?? 0, over.title ?? 'Task', ids.ann, over.due ?? '2026-11-20', over.status ?? 'not_started', ids.owner, over.description ?? null],
    );
    return id;
  };
  const get = (c: Client, id: string) => c.request('GET', `/records/tasks/${id}`);
  const records = async (c: Client) => (await c.request('GET', `/projects/${projectId}/records`)).body;
  const propose = (over: object = {}) => ann.request('POST', `/projects/${projectId}/proposals`, { kind: 'action', text: 'Book the room', ...over });
  const authoriseHuman = (id: string, over: object = {}) => owner.request('POST', `/proposals/${id}/authorise`, { assigneeId: ids.ann, dueOn: '2026-11-30', ...over });
  const stored = async (id: string) => (await t.pool.query(`SELECT description FROM tasks WHERE id = $1`, [id])).rows[0].description as string | null;
  const amend = (id: string, terms: object) =>
    owner.request('POST', `/projects/${projectId}/changes`, { kind: 'amend_task', targetKind: 'task', targetId: id, terms: { reason: 'Clearer', ...terms }, approve: true });

  /** A run on a note (Restricted to ann when asked) with one item. */
  const seedItem = async (opts: { restricted?: boolean; kind?: string } = {}) => {
    const note = (await pm.request('POST', `/projects/${projectId}/notes`, { title: 'Kick-off', text: TEXT })).body;
    if (opts.restricted) {
      await t.pool.query(`UPDATE audiences SET mode = 'restricted' WHERE id = (SELECT audience_id FROM sources WHERE id = $1)`, [note.source.id]);
      await t.pool.query(
        `INSERT INTO audience_members (audience_id, user_id, added_by, added_at) SELECT audience_id, $2, $3, now() FROM sources WHERE id = $1`,
        [note.source.id, ids.ann, ids.pm],
      );
    }
    const runId = uuidv7();
    const itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at) VALUES ($1, $2, $3, 'succeeded', 1, 0, now(), now())`,
      [runId, note.version.id, ids.pm],
    );
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, due, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, $5, 'Export the records.', 'by 20 November 2026', $4, 0, $6, 1, now())`,
      [itemId, runId, note.version.id, TEXT, opts.kind ?? 'action', TEXT.length],
    );
    const authorise = (over: object = {}) =>
      owner.request('POST', `/extractions/${runId}/items/${itemId}/authorise`, { sourceVersionId: note.version.id, assigneeId: ids.ann, dueOn: '2026-11-20', severity: 'high', ...over });
    return { runId, itemId, sourceId: note.source.id as string, authorise };
  };
  const addCase = async (itemKind: string, itemId: string) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, reason, marked_length, state, reported_at) VALUES ($1, $2, $3, $4, $5, 'A password', 8, 'held', now())`,
      [id, projectId, itemKind, itemId, ids.pm],
    );
    return id;
  };

  // ---- Description -----------------------------------------------------------------------------------------------

  test('a proposer gives a description; authorising keeps it, or the authoriser changes or clears it', async () => {
    const made = await propose({ description: '  Seats for 40.\nNear the lift.  ' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const listed = (await ben.request('GET', `/projects/${projectId}/proposals`)).body.proposals[0];
    assert.equal(listed.description, 'Seats for 40.\nNear the lift.');
    const kept = (await authoriseHuman(made.body.proposal.id)).body.record.id;
    assert.equal((await get(ben, kept)).body.task.description, 'Seats for 40.\nNear the lift.');

    const second = (await propose({ description: 'Draft' })).body.proposal.id;
    assert.equal(await stored((await authoriseHuman(second, { description: 'Final' })).body.record.id), 'Final');
    const third = (await propose({ description: 'Draft' })).body.proposal.id;
    assert.equal(await stored((await authoriseHuman(third, { description: ' \n\t' })).body.record.id), null);
  });

  test('a description at authorising an extracted action; without one there is none', async () => {
    const a = await seedItem();
    const made = await a.authorise({ description: 'Only the 2026 records.' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await get(ann, made.body.record.id)).body.task.description, 'Only the 2026 records.');
    const b = await seedItem();
    assert.equal((await get(ann, (await b.authorise()).body.record.id)).body.task.description, null);
  });

  test('a follow-up proposal keeps its description', async () => {
    const id = await task({ status: 'cancelled' });
    const made = await ann.request('POST', `/records/tasks/${id}/follow-up`, { text: 'Try again', description: 'With the other vendor' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(await stored((await authoriseHuman(made.body.proposal.id)).body.record.id), 'With the other vendor');
  });

  test('a description waits with its request until the last approver', async () => {
    const id = (await propose({ description: 'Draft' })).body.proposal.id;
    const second = await seedUser(t.pool, 'sponsor@example.org');
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'sponsor', '2026-11-01')`, [uuidv7(), projectId, second]);
    const set = await (await t.signIn('admin@example.org')).request('POST', '/approval-policy', { required: 2, reason: 'Two sets of eyes', pending: 'keep' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const r = await authoriseHuman(id, { description: ' Agreed ' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.request.terms.description, 'Agreed');
    const done = await (await t.signIn('sponsor@example.org')).request('POST', `/changes/${r.body.request.id}/approve`, { version: 1 });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(await stored(done.body.applied.record.id), 'Agreed');
  });

  test('amending sets, changes and clears it; the history has the previous and new values', async () => {
    const id = await task();
    const amended = async () => (await get(ben, id)).body.history.at(-1).detail;
    assert.equal((await amend(id, { description: 'One' })).status, 201);
    assert.deepEqual(await amended(), { description: { from: null, to: 'One' } });
    t.clock.advanceSeconds(60);
    assert.equal((await amend(id, { description: ' Two ', dueOn: '2026-11-25' })).status, 201);
    assert.deepEqual(await amended(), { description: { from: 'One', to: 'Two' }, dueOn: { from: '2026-11-20', to: '2026-11-25' } });
    t.clock.advanceSeconds(60);
    assert.equal((await amend(id, { title: 'Renamed' })).status, 201);
    assert.equal(await stored(id), 'Two', 'a change that does not mention it leaves it');
    assert.equal((await amend(id, { description: 'Two' })).status, 409, 'nothing changed');
    t.clock.advanceSeconds(60);
    assert.equal((await amend(id, { description: '\n\t ' })).status, 201);
    assert.deepEqual(await amended(), { description: { from: 'Two', to: null } });
    assert.equal(await stored(id), null);
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'task.amended'`)).rows.map((r) => JSON.stringify(r.detail)).join();
    assert.ok(!audit.includes('One') && !audit.includes('Two'), 'audit holds field names only');
  });

  test('a subtask added by amendment may have a description', async () => {
    const id = await task();
    const add = { title: 'Part', assigneeId: ids.ben, dueOn: '2026-11-18' };
    const r = await amend(id, { addSubtask: { ...add, description: ' Half of it ' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await stored(r.body.applied.record.subtaskIds[0]), 'Half of it');
    const none = await amend(id, { addSubtask: { ...add, description: '\t\n' } });
    assert.equal(await stored(none.body.applied.record.subtaskIds[0]), null);
    assert.equal((await amend(id, { addSubtask: add, description: 'x' })).status, 400, 'a change or a subtask, not both');
  });

  test('too long and credentials are refused on every path; nothing is stored', async () => {
    const id = await task();
    const item = await seedItem();
    const human = (await propose()).body.proposal.id;
    const add = { title: 'Part', assigneeId: ids.ben, dueOn: '2026-11-18' };
    const paths: Array<[string, (description: unknown) => Promise<{ status: number; body: any }>]> = [
      ['propose', (description) => propose({ description })],
      ['authorise human', (description) => authoriseHuman(human, { description })],
      ['authorise item', (description) => item.authorise({ description })],
      ['amend', (description) => amend(id, { description })],
      ['subtask', (description) => amend(id, { addSubtask: { ...add, description } })],
    ];
    for (const [name, send] of paths) {
      for (const bad of ['x'.repeat(4001), 7]) {
        const r = await send(bad);
        assert.deepEqual([r.status, r.body.message], [400, TOO_LONG], name);
      }
      const secret = await send(CREDENTIAL);
      assert.equal(secret.status, 400, name);
      assert.match(secret.body.message, LOOKS_LIKE, name);
      assert.ok(!JSON.stringify(secret.body).includes('a1B2c3D4e5'), name);
    }
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n, 1);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM change_requests`)).rows[0].n, 0);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM human_proposals WHERE description IS NOT NULL`)).rows[0].n, 0);
    const full = await propose({ description: 'x'.repeat(4000) });
    assert.equal(full.status, 201, '4,000 is accepted');
    for (const blank of ['', '   ', '\n\n', '\t\n ', null]) {
      const p = (await propose({ description: blank })).body.proposal.id;
      assert.equal((await t.pool.query(`SELECT description FROM human_proposals WHERE id = $1`, [p])).rows[0].description, null, JSON.stringify(blank));
    }
  });

  test('only an action has a description', async () => {
    const r = await propose({ kind: 'risk', description: 'Detail' });
    assert.deepEqual([r.status, r.body.message], [400, 'Only an action can have a description.']);
    assert.equal((await propose({ kind: 'risk', description: ' ' })).status, 201);
    const item = await seedItem({ kind: 'risk' });
    assert.equal((await item.authorise({ description: 'Detail' })).status, 400);
    assert.equal((await item.authorise()).status, 201);
  });

  test('a credential in a description or proposal can be reported', async () => {
    const id = await task({ description: 'Vault Kp9vault-Rotor42' });
    const r = await ann.request('POST', `/projects/${projectId}/secret-reports`, { kind: 'task', id, marked: ['Kp9vault-Rotor42'], reason: 'Vault code' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await get(ann, id)).status, 404, 'held');
    await t.pool.query(`UPDATE tasks SET held_case_id = NULL`);
    const p = (await propose({ description: 'Panel Rx7gate-Key99' })).body.proposal.id;
    const s = await ann.request('POST', `/projects/${projectId}/secret-reports`, { kind: 'human_proposal', id: p, marked: ['Rx7gate-Key99'], reason: 'Panel code' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
  });

  // ---- The full reply --------------------------------------------------------------------------------------------

  test('parent, subtasks and who authorised it; a hidden one is left out', async () => {
    const top = await task({ title: 'Top' });
    const b = await task({ parent: top, depth: 1, title: 'Second', due: '2026-11-19' });
    const a = await task({ parent: top, depth: 1, title: 'First', due: '2026-11-10', status: 'in_progress' });
    const gone = await task({ parent: top, depth: 1, title: 'Gone' });
    const deeper = await task({ parent: a, depth: 2, title: 'Deeper' });
    await t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'x' WHERE id = $1`, [gone, ids.owner]);
    const r = (await get(ben, top)).body;
    assert.equal(r.parent, null);
    assert.deepEqual(r.subtasks, [
      { id: a, title: 'First', status: 'in_progress', dueOn: '2026-11-10' },
      { id: b, title: 'Second', status: 'not_started', dueOn: '2026-11-19' },
    ]);
    assert.deepEqual(r.authorised, { by: 'owner', at: '2026-11-02T02:00:00.000Z' });
    assert.deepEqual([r.blocked, r.proposal, r.task.proposal, r.task.description], [null, null, null, null]);
    const mid = (await get(ben, a)).body;
    assert.deepEqual(mid.parent, { id: top, title: 'Top' });
    assert.deepEqual(mid.subtasks.map((s: { id: string }) => s.id), [deeper]);
    // A held parent is hidden: its subtask is still there, without it.
    await t.pool.query(`UPDATE tasks SET held_case_id = $2 WHERE id = $1`, [top, await addCase('task', top)]);
    const orphan = await get(ben, b);
    assert.deepEqual([orphan.status, orphan.body.parent, orphan.body.task.id], [200, null, b]);
    // Nothing the parent's own date or status would tell either.
    await t.pool.query(`UPDATE tasks SET status = 'cancelled', due_on = '2026-11-01' WHERE id = $1`, [top]);
    const { parentId, dueAfterParent, parentCancelled } = (await get(ben, b)).body.task;
    assert.deepEqual({ parentId, dueAfterParent, parentCancelled }, { parentId: null, dueAfterParent: false, parentCancelled: false });
    assert.ok(!JSON.stringify(orphan.body).includes('Top'));
  });

  test('due soon follows the project calendar, and only for unfinished work', async () => {
    const soon = async (over: Parameters<typeof task>[0]) => (await get(ben, await task(over))).body.task.dueSoon;
    // Today is Monday 9 November 2026: seven working days on is Wednesday 18 November.
    assert.equal(await soon({ due: '2026-11-18' }), true);
    assert.equal(await soon({ due: '2026-11-19' }), false);
    assert.equal(await soon({ due: '2026-11-06' }), false, 'overdue');
    assert.equal(await soon({ due: '2026-11-18', status: 'completed' }), false);
    const marked = await task({ due: '2026-11-18' });
    await t.pool.query(`UPDATE tasks SET deadline_review_required = true WHERE id = $1`, [marked]);
    assert.equal((await get(ben, marked)).body.task.dueSoon, false, 'waits for a deadline review');
  });

  test('blocked gives the latest block, and nothing once unblocked', async () => {
    const id = await task();
    const act = async (c: Client, action: string, note?: string) => {
      t.clock.advanceSeconds(60);
      assert.equal((await c.request('POST', `/records/tasks/${id}/${action}`, { note })).status, 200, action);
    };
    await act(ann, 'start');
    await act(ann, 'block', 'First reason');
    await act(ann, 'unblock', 'Fixed');
    assert.equal((await get(ben, id)).body.blocked, null);
    await act(pm, 'block', 'Second reason');
    const at = t.clock.now().toISOString();
    t.clock.advanceSeconds(60);
    assert.equal((await amend(id, { dueOn: '2026-11-28' })).status, 201);
    assert.deepEqual((await get(ben, id)).body.blocked, { reason: 'Second reason', by: 'pm', at });
    await act(ann, 'unblock', 'Fixed again');
    assert.equal((await get(ben, id)).body.blocked, null);
  });

  test('an outsider, a held member and an administrator find nothing; a grant holder reads', async () => {
    const id = await task({ description: 'Private detail' });
    for (const who of ['outsider@example.org', 'admin@example.org']) {
      const r = await get(await t.signIn(who), id);
      assert.equal(r.status, 404, who);
      assert.ok(!JSON.stringify(r.body).includes('Private'));
    }
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), projectId, ids.auditor, ids.owner, ids.pm],
    );
    const auditor = await t.signIn('auditor@example.org');
    const read = await get(auditor, id);
    assert.deepEqual([read.status, read.body.task.description, read.body.task.mayAct], [200, 'Private detail', []]);
    await t.pool.query(`UPDATE memberships SET held_at = now(), hold_reason = 'Review' WHERE user_id = $1`, [ids.ben]);
    const held = await get(ben, id);
    assert.equal(held.status, 404);
    assert.equal((await ben.request('GET', `/projects/${projectId}/records`)).status, 404);
  });

  // ---- Proposal links --------------------------------------------------------------------------------------------

  test('every record kind links to its proposal, on the list and the page', async () => {
    const human = (await propose()).body.proposal.id;
    const humanTask = (await authoriseHuman(human)).body.record.id;
    assert.deepEqual((await get(ben, humanTask)).body.proposal, { kind: 'human', proposalId: human });
    const want: Record<string, unknown> = {};
    for (const kind of ['action', 'decision', 'question', 'risk']) {
      const item = await seedItem({ kind });
      const made = await item.authorise();
      assert.equal(made.status, 201, JSON.stringify(made.body));
      want[made.body.record.id] = { kind: 'run', runId: item.runId, itemId: item.itemId };
    }
    const all = await records(ben);
    const got = Object.fromEntries([...all.tasks, ...all.decisions, ...all.questions, ...all.risks].map((r: any) => [r.id, r.proposal]));
    assert.deepEqual(got, { ...want, [humanTask]: { kind: 'human', proposalId: human } });
  });

  test('a split subtask and a directly made record have no proposal', async () => {
    const human = (await propose()).body.proposal.id;
    const made = await authoriseHuman(human, { subtasks: [{ title: 'Part', assigneeId: ids.ben, dueOn: '2026-11-20' }] });
    assert.equal((await get(ben, made.body.record.subtaskIds[0])).body.proposal, null);
  });

  test('the proposal is given exactly to those who may open it', async () => {
    const item = await seedItem({ restricted: true });
    const id = (await item.authorise()).body.record.id;
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), projectId, ids.auditor, ids.owner, ids.pm],
    );
    const viewers: Array<[string, Client]> = [['pm', pm], ['owner', owner], ['ann', ann], ['ben', ben], ['auditor', await t.signIn('auditor@example.org')]];
    const link = { kind: 'run', runId: item.runId, itemId: item.itemId };
    /** Who gets the link; checked against the run page for everyone. */
    const given = async (label: string) => {
      const out: string[] = [];
      for (const [name, c] of viewers) {
        const page = await c.request('GET', `/extractions/${item.runId}`);
        const opens = page.status === 200 && page.body.items.some((i: { id: string }) => i.id === item.itemId);
        const one = (await get(c, id)).body;
        const listed = (await records(c)).tasks[0].proposal;
        assert.deepEqual([one.proposal, one.task.proposal, listed], Array(3).fill(opens ? link : null), `${label}: ${name}`);
        if (!opens) assert.ok(!JSON.stringify(one).includes(item.runId) && !JSON.stringify(one).includes(item.itemId), `${label}: ${name}`);
        if (opens) out.push(name);
      }
      return out;
    };
    assert.deepEqual(await given('restricted'), ['pm', 'owner', 'ann']);
    await t.pool.query(`UPDATE audiences SET mode = 'project'`);
    assert.deepEqual(await given('project-wide'), ['pm', 'owner', 'ann', 'ben', 'auditor']);
    for (const publication of ['submitted', 'returned']) {
      await t.pool.query(`UPDATE sources SET publication = $2, submitted_by = $3, intended_mode = 'project', returned_reason = 'More detail' WHERE id = $1`, [item.sourceId, publication, ids.ben]);
      assert.deepEqual(await given(publication), ['pm', 'owner', 'ben']);
    }
    await t.pool.query(`UPDATE sources SET publication = 'published' WHERE id = $1`, [item.sourceId]);
    const caseId = await addCase('proposal', item.itemId);
    await t.pool.query(`UPDATE extraction_items SET held_case_id = $2 WHERE id = $1`, [item.itemId, caseId]);
    assert.deepEqual(await given('held proposal'), []);
    await t.pool.query(`UPDATE extraction_items SET held_case_id = NULL`);
    await t.pool.query(`UPDATE sources SET held_case_id = $2 WHERE id = $1`, [item.sourceId, caseId]);
    await given('held source');
    await t.pool.query(`UPDATE sources SET held_case_id = NULL, status = 'deleted', deleted_by = $2, deleted_at = now(), delete_reason = 'Wrong' WHERE id = $1`, [item.sourceId, ids.pm]);
    await given('deleted source');
  });

  test('a held people’s proposal is not linked', async () => {
    const human = (await propose()).body.proposal.id;
    const id = (await authoriseHuman(human)).body.record.id;
    await t.pool.query(`UPDATE human_proposals SET held_case_id = $2 WHERE id = $1`, [human, await addCase('human_proposal', human)]);
    for (const c of [pm, ben]) {
      assert.equal((await get(c, id)).body.proposal, null);
      assert.ok(!JSON.stringify(await records(c)).includes(human));
    }
  });

  /** How many queries the pool sees while `read` runs. */
  const count = async (read: () => Promise<unknown>) => {
    let n = 0;
    const pool = t.app.get(PG_POOL);
    const original = pool.query;
    pool.query = function (...args: unknown[]) {
      n += 1;
      return original.apply(pool, args);
    };
    try {
      await read();
    } finally {
      pool.query = original;
    }
    return n;
  };

  // ---- Board fields on the list (11a.2) ---------------------------------------------------------------------------

  const inList = async (c: Client, id: string) => (await records(c)).tasks.find((x: { id: string }) => x.id === id);

  test('the list says due soon as the task page does, on both calendars, and never for overdue, marked or finished work', async () => {
    // Today is Monday 9 November 2026: seven working days on is 18 November, seven plain days on is 16 November.
    const due = async (over: Parameters<typeof task>[0]) => await task(over);
    const marked = await due({ due: '2026-11-18' });
    await t.pool.query(`UPDATE tasks SET deadline_review_required = true WHERE id = $1`, [marked]);
    const all = [
      await due({ due: '2026-11-09' }),
      await due({ due: '2026-11-16' }),
      await due({ due: '2026-11-18' }),
      await due({ due: '2026-11-19' }),
      await due({ due: '2026-11-06' }),
      await due({ due: '2026-11-18', status: 'completed' }),
      await due({ due: '2026-11-18', status: 'cancelled' }),
      marked,
    ];
    const agree = async () => {
      const out: boolean[] = [];
      for (const id of all) {
        const onList = (await inList(ben, id)).dueSoon;
        assert.equal(onList, (await get(ben, id)).body.task.dueSoon, id);
        out.push(onList);
      }
      return out;
    };
    assert.deepEqual(await agree(), [true, true, true, false, false, false, false, false], 'working days');
    await t.pool.query(`INSERT INTO project_notification_settings (project_id, day_counting) VALUES ($1, 'calendar')`, [projectId]);
    assert.deepEqual(await agree(), [true, true, false, false, false, false, false, false], 'plain days');
  });

  test('the list gives the UTC+8 day a task was finished, and null for the rest', async () => {
    const id = await task({ status: 'completed' });
    await t.pool.query(`UPDATE tasks SET completed_at = '2026-11-05T23:30:00Z' WHERE id = $1`, [id]);
    assert.equal((await inList(ben, id)).completedOn, '2026-11-06');
    assert.equal((await inList(ben, await task())).completedOn, null);
  });

  test('the list gives the latest block while Blocked; the cleaned text after cleaning; nothing while held', async () => {
    const id = await task();
    const act = async (c: Client, action: string, note?: string) => {
      t.clock.advanceSeconds(60);
      assert.equal((await c.request('POST', `/records/tasks/${id}/${action}`, { note })).status, 200, action);
    };
    const reason = async () => (await inList(ben, id)).blockedReason;
    assert.equal(await reason(), null, 'not started');
    await act(ann, 'start');
    await act(ann, 'block', 'First reason');
    await act(ann, 'unblock', 'Fixed');
    assert.equal(await reason(), null, 'unblocked');
    await act(ann, 'block', 'Second reason');
    assert.equal(await reason(), 'Second reason');
    assert.equal((await get(ben, id)).body.blocked.reason, 'Second reason', 'the page says the same');
    // Cleaning rewrites the note in place, inside the case that holds the task.
    const caseId = await addCase('task', id);
    const c = await t.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('kainow.quarantine_write', $1, true)`, [caseId]);
      await c.query(`UPDATE task_events SET note = 'Cleaned [removed]' WHERE task_id = $1 AND note = 'Second reason'`, [id]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    assert.equal(await reason(), 'Cleaned [removed]', 'the cleaned text');
    await t.pool.query(`UPDATE quarantine_cases SET state = 'cleaned', cleaned_at = now() WHERE id = $1`, [caseId]);
    await t.pool.query(`UPDATE tasks SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
    assert.equal((await inList(ben, id)).quarantineLabel !== null, true);
    assert.equal(await reason(), null, 'under review');
    const page = await get(ben, id);
    assert.equal(page.body.blocked.reason, null, 'the page too');
    assert.ok(!JSON.stringify(await records(ben)).includes('Cleaned [removed]'), 'the list holds no reason');
  });

  test('the number of queries for the list does not grow with the tasks', async () => {
    let made = 0;
    const make = async (n: number) => {
      for (let i = made; i < made + n; i += 1) {
        const id = await task({ status: i % 2 === 0 ? 'blocked' : 'in_progress', due: `2026-11-${10 + (i % 15)}` });
        if (i % 2 === 0) {
          await t.pool.query(
            `INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at) VALUES ($1, $2, 'blocked', 'in_progress', 'blocked', 'Waiting', $3, now())`,
            [uuidv7(), id, ids.ann],
          );
        }
      }
      made += n;
    };
    await make(1);
    await records(ben);
    const one = await count(() => records(ben));
    await make(19);
    assert.equal((await records(ben)).tasks.length, 20);
    assert.equal(await count(() => records(ben)), one);
    assert.equal((await records(ben)).tasks.filter((x: { blockedReason: string | null }) => x.blockedReason === 'Waiting').length, 10);
  });

  test('the list reads every proposal in a fixed number of queries', async () => {
    await authoriseHuman((await propose()).body.proposal.id);
    const proposals = () => ben.request('GET', `/projects/${projectId}/proposals`);
    const few = [await count(() => records(ben)), await count(proposals)];
    const made: string[] = [];
    for (let i = 0; i < 4; i += 1) made.push((await authoriseHuman((await propose()).body.proposal.id)).body.record.id);
    await propose();
    assert.deepEqual([await count(() => records(ben)), await count(proposals)], few);
    const listed = (await proposals()).body.proposals;
    const shown = listed.map((p: { record: { kind: string; id: string } | null }) => p.record);
    for (const id of made) assert.deepEqual(shown.filter((r: { id: string } | null) => r?.id === id), [{ kind: 'task', id }]);
    assert.equal(shown.filter((r: unknown) => r === null).length, 1, 'the one that was not authorised');
  });
});
