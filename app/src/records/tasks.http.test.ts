import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('the task lifecycle', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let ann: Client;
  let ben: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'ann', 'ben', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.ann, role: 'member' }, { userId: ids.ben, role: 'member' }],
    });
    pm = await t.signIn('pm@example.org');
    ann = await t.signIn('ann@example.org');
    ben = await t.signIn('ben@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  /** A task inserted directly, as authorising would leave it. */
  const task = async (over: { assignee?: string; parent?: string | null; depth?: number; status?: string; due?: string } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, 'Task', $5, $6, $7, $8, now())`,
      [id, projectId, over.parent ?? null, over.depth ?? 0, over.assignee ?? ids.ann, over.due ?? '2026-11-20', over.status ?? 'not_started', ids.owner],
    );
    return id;
  };
  const act = (c: Client, id: string, action: string, body: object = {}) => c.request('POST', `/records/tasks/${id}/${action}`, body);
  const status = async (id: string) => (await t.pool.query(`SELECT status FROM tasks WHERE id = $1`, [id])).rows[0].status;

  test('start needs an Active assignee', async () => {
    const id = await task({ assignee: ids.outsider });
    const r = await act(pm, id, 'start');
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'The assignee must be an Active member to start this task.');
  });

  test('the assignee starts, blocks with a reason and unblocks', async () => {
    const id = await task();
    assert.equal((await act(ann, id, 'start')).status, 200);
    t.clock.advanceSeconds(60); // history is ordered by time; ids are not ordered within one instant
    const noReason = await act(ann, id, 'block', {});
    assert.deepEqual([noReason.status, noReason.body.message], [400, 'A note is required.']);
    assert.equal((await act(ann, id, 'block', { note: 'Waiting for the vendor' })).status, 200);
    t.clock.advanceSeconds(60);
    assert.equal((await act(ann, id, 'unblock', { note: 'Vendor replied' })).status, 200);
    assert.equal(await status(id), 'in_progress');
    const history = (await ann.request('GET', `/records/tasks/${id}`)).body.history.map((h: { kind: string }) => h.kind);
    assert.deepEqual(history, ['started', 'blocked', 'unblocked']);
  });

  test("a Member cannot change someone else's task", async () => {
    const id = await task();
    const r = await act(ben, id, 'start');
    assert.equal(r.status, 403);
    assert.equal(r.body.message, 'Only the assignee, the Project Manager or a Deputy can do this.');
  });

  test('parent completion', async () => {
    const parent = await task({ assignee: ids.ann });
    const child = await task({ assignee: ids.ben, parent, depth: 1 });
    const refused = await act(ann, parent, 'complete', { note: 'Done' });
    assert.deepEqual([refused.status, refused.body.message], [409, 'Finish the subtasks first, or record an override.']);
    assert.equal((await act(pm, parent, 'complete', { note: 'Done', overrideReason: 'Ben finishes his part separately' })).status, 200);
    assert.deepEqual([await status(parent), await status(child)], ['completed', 'not_started']);
    const ev = (await t.pool.query(`SELECT override_reason FROM task_events WHERE task_id = $1 AND kind = 'completed'`, [parent])).rows[0];
    assert.equal(ev.override_reason, 'Ben finishes his part separately');
  });

  test('reopening reopens completed ancestors', async () => {
    const top = await task({ status: 'completed' });
    const mid = await task({ parent: top, depth: 1, status: 'completed' });
    const low = await task({ parent: mid, depth: 2, status: 'completed' });
    assert.equal((await act(ann, low, 'reopen', { note: 'x' })).status, 403, 'only the PM or a Deputy reopens');
    assert.equal((await act(pm, low, 'reopen', { note: 'A mistake in the export' })).status, 200);
    assert.deepEqual([await status(top), await status(mid), await status(low)], ['in_progress', 'in_progress', 'in_progress']);
    const n = (await t.pool.query(`SELECT count(*)::int AS n FROM task_events WHERE kind = 'reopened'`)).rows[0].n;
    assert.equal(n, 3);
  });

  test('subtasks go at most two levels deep', async () => {
    const top = await task();
    const add = (parent: string) => pm.request('POST', `/records/tasks/${parent}/subtasks`, { title: 'Part', assigneeId: ids.ben, dueOn: '2026-11-18', reason: 'Split the work' });
    const mid = await add(top);
    assert.equal(mid.status, 201, JSON.stringify(mid.body));
    const low = await add(mid.body.task.id);
    assert.equal(low.status, 201);
    const deeper = await add(low.body.task.id);
    assert.deepEqual([deeper.status, deeper.body.message], [409, 'Subtasks go at most two levels deep.']);
    assert.equal((await ann.request('POST', `/records/tasks/${top}/subtasks`, { title: 'P', assigneeId: ids.ben, dueOn: '2026-11-18', reason: 'r' })).status, 403);
  });

  test('nothing changes while Deferred; a grant holder reads but cannot act', async () => {
    const id = await task();
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    const r = await act(ann, id, 'start');
    assert.deepEqual([r.status, r.body.message], [409, 'Tasks change only while the project is Active.']);
    await t.pool.query(`UPDATE projects SET status = 'active' WHERE id = $1`, [projectId]);
    const owner = await t.signIn('owner@example.org');
    const admin = await t.signIn('admin@example.org');
    const gid = (await owner.request('POST', `/projects/${projectId}/grants`, { userId: ids.outsider, kind: 'audit', purpose: 'p', scope: 's', startsOn: '2026-11-09' })).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    const x = await t.signIn('outsider@example.org');
    assert.equal((await x.request('GET', `/projects/${projectId}/records`)).status, 200);
    assert.equal((await act(x, id, 'start')).status, 403);
  });

  test('Overdue shows after the due day, and the list says what you may do', async () => {
    const id = await task({ due: '2026-11-09' });
    const view = async (c: Client) => (await c.request('GET', `/projects/${projectId}/records`)).body.tasks.find((x: { id: string }) => x.id === id);
    assert.equal((await view(ann)).overdue, false);
    assert.deepEqual((await view(ann)).mayAct, ['start', 'block', 'complete']);
    assert.deepEqual((await view(ben)).mayAct, []);
    t.clock.advanceSeconds(86400);
    const ann2 = await t.signIn('ann@example.org');
    assert.equal((await view(ann2)).overdue, true);
  });

  test('My Projects counts your open tasks', async () => {
    await task();
    await task({ status: 'completed' });
    await task({ assignee: ids.ben });
    const row = (await ann.request('GET', '/projects')).body.projects.find((p: { id: string }) => p.id === projectId);
    assert.equal(row.myOpenTasks, 1);
  });
});
