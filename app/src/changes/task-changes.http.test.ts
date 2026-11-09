import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const FINISHED = 'A completed or cancelled task cannot be changed; propose a follow-up task instead.';

describe('amending and cancelling tasks', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let owner: Client;
  let sponsor: Client;
  let ann: Client;
  let ben: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'sponsor', 'ann', 'ben']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    ann = await t.signIn('ann@example.org');
    ben = await t.signIn('ben@example.org');
    await (await t.signIn('admin@example.org')).request('POST', '/domains', { domain: 'example.org' });
  });
  afterEach(async () => {
    await t?.close();
  });

  const task = async (over: { assignee?: string; parent?: string | null; depth?: number; status?: string; due?: string; title?: string } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [id, projectId, over.parent ?? null, over.depth ?? 0, over.title ?? 'Task', over.assignee ?? ids.ann, over.due ?? '2026-11-20', over.status ?? 'not_started', ids.owner],
    );
    return id;
  };
  const submit = (c: Client, kind: 'amend_task' | 'cancel_task', taskId: string, terms: object, approve = false) =>
    c.request('POST', `/projects/${projectId}/changes`, { kind, targetKind: 'task', targetId: taskId, terms, approve });
  const approve = (c: Client, id: string, version = 1) => c.request('POST', `/changes/${id}/approve`, { version });
  const row = async (id: string) =>
    (await t.pool.query(`SELECT status, title, assignee_id, to_char(due_on, 'YYYY-MM-DD') AS due, follows_task_id FROM tasks WHERE id = $1`, [id])).rows[0];
  const view = async (c: Client, id: string) => (await c.request('GET', `/projects/${projectId}/records`)).body.tasks.find((x: { id: string }) => x.id === id);

  test('an assignee proposes a new due date and an Owner authorises it', async () => {
    const id = await task();
    const r = await submit(ann, 'amend_task', id, { dueOn: '2026-11-27', reason: 'Waiting on a supplier' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.request.status, 'pending');
    t.clock.advanceSeconds(60);
    const a = await approve(owner, r.body.request.id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal((await row(id)).due, '2026-11-27');
    const history = (await ann.request('GET', `/records/tasks/${id}`)).body.history;
    const amended = history.find((h: { kind: string }) => h.kind === 'amended');
    assert.deepEqual(amended.detail, { dueOn: { from: '2026-11-20', to: '2026-11-27' } });
    assert.equal(amended.note, 'Waiting on a supplier');
  });

  test('the closure batch cannot be named from outside closing', async () => {
    const id = await task();
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    const r = await owner.request('POST', `/projects/${projectId}/changes`, {
      kind: 'cancel_task', targetKind: 'task', targetId: id, terms: { reason: 'Not needed', subtasks: {} }, batchId: projectId,
    });
    assert.deepEqual([r.status, r.body.message], [400, 'A cancellation for closing is prepared on the Closing screen.']);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM change_requests`)).rows[0].n, 0);
    assert.equal((await row(id)).status, 'not_started');
    const upper = await owner.request('POST', `/projects/${projectId}/changes`, {
      kind: 'cancel_task', targetKind: 'task', targetId: id, terms: { reason: 'Not needed', subtasks: {} }, batchId: projectId.toUpperCase(),
    });
    assert.deepEqual([upper.status, upper.body.message], [400, 'A cancellation for closing is prepared on the Closing screen.'], 'whatever the letter case');
    const junk = await owner.request('POST', `/projects/${projectId}/changes`, {
      kind: 'cancel_task', targetKind: 'task', targetId: id, terms: { reason: 'Not needed', subtasks: {} }, batchId: 'not-a-batch',
    });
    assert.equal(junk.status, 400, 'a batch is a uuid');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM change_requests`)).rows[0].n, 0);
  });

  test('a Member who is not the assignee cannot propose', async () => {
    const id = await task();
    const r = await submit(ben, 'amend_task', id, { dueOn: '2026-11-27', reason: 'x' });
    assert.deepEqual([r.status, r.body.message], [403, 'Only the assignee, the Project Manager, a Deputy, an Owner or a Sponsor can propose changes to this task.']);
  });

  test('nothing changed is refused', async () => {
    const id = await task();
    const r = await submit(pm, 'amend_task', id, { dueOn: '2026-11-20', title: 'Task', assigneeId: ids.ann, reason: 'x' });
    assert.deepEqual([r.status, r.body.message], [409, 'Change at least one of the wording, the assignee or the due date.']);
    const noReason = await submit(pm, 'amend_task', id, { dueOn: '2026-11-21' });
    assert.deepEqual([noReason.status, noReason.body.message], [400, 'A reason is required.']);
  });

  test('a completed task cannot be amended', async () => {
    const id = await task({ status: 'completed' });
    const r = await submit(pm, 'amend_task', id, { dueOn: '2026-11-27', reason: 'x' });
    assert.deepEqual([r.status, r.body.message], [409, FINISHED]);
  });

  test('the change waits and does not alter the task until authorised', async () => {
    const id = await task();
    const r = await submit(pm, 'amend_task', id, { title: 'Export the records', dueOn: '2026-11-05', reason: 'Brought forward' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([(await row(id)).title, (await row(id)).due], ['Task', '2026-11-20']);
    assert.equal((await view(ann, id)).changeWaiting, true);
    const again = await submit(owner, 'cancel_task', id, { reason: 'x', subtasks: {} });
    assert.deepEqual([again.status, again.body.message], [409, 'This task already has a change waiting for authorisation.']);
    assert.equal((await approve(sponsor, r.body.request.id)).status, 200);
    assert.deepEqual([(await row(id)).title, (await row(id)).due], ['Export the records', '2026-11-05']);
    assert.equal((await view(ann, id)).changeWaiting, false);
    assert.equal((await view(ann, id)).overdue, true, 'a past date is allowed; the task is overdue at once');
  });

  test('a new assignee invited by email gets the invitation at authorisation, not before', async () => {
    const id = await task();
    const r = await submit(pm, 'amend_task', id, { inviteEmail: 'new@example.org', reason: 'Ann is away' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const count = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM invitations WHERE email = 'new@example.org'`)).rows[0].n;
    assert.equal(await count(), 0);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'new@example.org'`)).rows[0].n, 0);
    const a = await approve(owner, r.body.request.id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.applied.delivered, true);
    assert.equal(await count(), 1);
    assert.ok(t.sender.lastInvitation('new@example.org'));
    const now = await row(id);
    const newUser = (await t.pool.query(`SELECT id FROM users WHERE email = 'new@example.org'`)).rows[0].id;
    assert.equal(now.assignee_id, newUser);
    assert.equal((await view(pm, id)).awaitingMembership, true);
  });

  test('adding a subtask needs authorisation', async () => {
    const top = await task();
    const old = await pm.request('POST', `/records/tasks/${top}/subtasks`, { title: 'Part', assigneeId: ids.ben, dueOn: '2026-11-18', reason: 'x' });
    assert.equal(old.status, 404);
    const add = async (parent: string, actor: Client = pm) => {
      const r = await submit(actor, 'amend_task', parent, { addSubtask: { title: 'Part', assigneeId: ids.ben, dueOn: '2026-11-18' }, reason: 'Split the work' });
      if (r.status !== 201) return r;
      t.clock.advanceSeconds(60);
      return approve(owner, r.body.request.id);
    };
    const pending = await submit(pm, 'amend_task', top, { addSubtask: { title: 'Part', assigneeId: ids.ben, dueOn: '2026-11-18' }, reason: 'Split the work' });
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE parent_id = $1`, [top])).rows[0].n, 0, 'nothing exists until authorised');
    const done = await approve(owner, pending.body.request.id);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const mid = done.body.applied.record.subtaskIds[0];
    const ev = (await t.pool.query(`SELECT kind, note FROM task_events WHERE task_id = $1`, [mid])).rows[0];
    assert.deepEqual(ev, { kind: 'authorised', note: 'Added by amendment' });
    const low = await add(mid);
    assert.equal(low.status, 200, JSON.stringify(low.body));
    const deeper = await add(low.body.applied.record.subtaskIds[0]);
    assert.deepEqual([deeper.status, deeper.body.message], [409, 'Subtasks go at most two levels deep.']);
  });

  test('cancellation needs a choice for each unfinished subtask', async () => {
    const top = await task();
    const mid = await task({ parent: top, depth: 1, assignee: ids.ben });
    const low = await task({ parent: mid, depth: 2, assignee: ids.ben });
    const done = await task({ parent: top, depth: 1, status: 'completed' });
    const none = await submit(pm, 'cancel_task', top, { reason: 'No longer needed', subtasks: {} });
    assert.deepEqual([none.status, none.body.message], [400, 'Choose cancel or keep for each unfinished subtask.']);
    const partial = await submit(pm, 'cancel_task', top, { reason: 'No longer needed', subtasks: { [mid]: 'cancel' } });
    assert.equal(partial.status, 400);
    const r = await submit(pm, 'cancel_task', top, { reason: 'No longer needed', subtasks: { [mid]: 'cancel', [low]: 'keep' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await row(top)).status, 'not_started', 'waits for authorisation');
    const a = await approve(owner, r.body.request.id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([(await row(top)).status, (await row(mid)).status, (await row(low)).status, (await row(done)).status], ['cancelled', 'cancelled', 'not_started', 'completed']);
    assert.equal((await view(ann, low)).parentCancelled, true);
    assert.equal((await view(ann, top)).parentCancelled, false);
    const ev = (await t.pool.query(`SELECT note FROM task_events WHERE task_id = $1 AND kind = 'cancelled'`, [top])).rows[0];
    assert.equal(ev.note, 'No longer needed');
  });

  test('a parent with cancelled children can complete without an override', async () => {
    const parent = await task();
    await task({ parent, depth: 1, status: 'cancelled' });
    await task({ parent, depth: 1, status: 'completed' });
    const r = await ann.request('POST', `/records/tasks/${parent}/complete`, { note: 'Done' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await row(parent)).status, 'completed');
  });

  test('cancelled is final', async () => {
    const id = await task({ status: 'cancelled' });
    const start = await ann.request('POST', `/records/tasks/${id}/start`, {});
    assert.deepEqual([start.status, start.body.message], [409, 'That change is not possible from Cancelled.']);
    const reopen = await pm.request('POST', `/records/tasks/${id}/reopen`, { note: 'x' });
    assert.equal(reopen.status, 409);
    const amend = await submit(pm, 'amend_task', id, { dueOn: '2026-11-27', reason: 'x' });
    assert.deepEqual([amend.status, amend.body.message], [409, FINISHED]);
    const cancel = await submit(pm, 'cancel_task', id, { reason: 'x', subtasks: {} });
    assert.deepEqual([cancel.status, cancel.body.message], [409, FINISHED]);
    assert.deepEqual((await view(pm, id)).mayAct, []);
  });

  test('a follow-up proposal links both tasks once authorised', async () => {
    const id = await task({ title: 'Export the records' });
    const notYet = await ann.request('POST', `/records/tasks/${id}/follow-up`, { text: 'Export again' });
    assert.equal(notYet.status, 409);
    await t.pool.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [id]);
    assert.equal((await ann.request('POST', `/records/tasks/${id}/follow-up`, { text: '' })).status, 400);
    const r = await ann.request('POST', `/records/tasks/${id}/follow-up`, { text: 'Export the records in two parts', owner: 'Ann' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const made = await owner.request('POST', `/proposals/${r.body.proposal.id}/authorise`, { assigneeId: ids.ann, dueOn: '2026-12-01' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const next = made.body.record.id;
    assert.equal((await row(next)).follows_task_id, id);
    assert.deepEqual((await view(pm, next)).follows, { id, title: 'Export the records' });
    assert.deepEqual((await view(pm, id)).followedBy, { id: next, title: 'Export the records in two parts' });
  });

  test('a task completed after its amendment was proposed refuses the approval with the completed-task message', async () => {
    await t.pool.query(`UPDATE approval_policy SET required = 2`);
    const id = await task();
    const r = await submit(ann, 'amend_task', id, { dueOn: '2026-11-27', reason: 'More time' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await approve(owner, r.body.request.id)).status, 200);
    assert.equal((await ann.request('POST', `/records/tasks/${id}/complete`, { note: 'Finished early' })).status, 200);
    const late = await approve(sponsor, r.body.request.id);
    assert.deepEqual([late.status, late.body.message], [409, FINISHED]);
    const after = (await owner.request('GET', `/projects/${projectId}/changes`)).body.requests[0];
    assert.deepEqual([after.status, after.approvals.length], ['pending', 1], 'the refused approval is not kept');
    assert.equal((await row(id)).due, '2026-11-20');
  });
});
