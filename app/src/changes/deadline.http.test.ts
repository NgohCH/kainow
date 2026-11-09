import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const NEEDS_DATE = 'This task needs a new authorised due date first.';
const DAY = 24 * 3600;

describe('deadline review and completion reconciliation', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let deputy: Client;
  let owner: Client;
  let sponsor: Client;
  let ann: Client;
  let ben: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'deputy', 'owner', 'sponsor', 'ann', 'ben']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    deputy = await t.signIn('deputy@example.org');
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
  /** Moves the clock on by days; sessions lapse, so everyone signs in again. */
  const passDays = async (n: number) => {
    t.clock.advanceSeconds(n * DAY);
    [pm, deputy, owner, sponsor, ann, ben] = await Promise.all(['pm', 'deputy', 'owner', 'sponsor', 'ann', 'ben'].map((p) => t.signIn(`${p}@example.org`)));
  };
  const defer = async () => {
    const r = await pm.request('POST', `/projects/${projectId}/transition`, { to: 'deferred', reason: 'Funding paused' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const resume = async () => {
    const r = await owner.request('POST', `/projects/${projectId}/transition`, { to: 'active', reason: 'Funding back', stage: 'Execution' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const row = async (id: string) =>
    (await t.pool.query(`SELECT status, deadline_review_required AS marked, to_char(due_on, 'YYYY-MM-DD') AS due, completed_at FROM tasks WHERE id = $1`, [id])).rows[0];
  const review = (c: Client, tasks: Array<{ taskId: string; dueOn: string }>) => c.request('POST', `/projects/${projectId}/deadline-review`, { tasks });
  const approve = (c: Client, id: string, version = 1) => c.request('POST', `/changes/${id}/approve`, { version });
  const act = (c: Client, id: string, action: string, body: object = {}) => c.request('POST', `/records/tasks/${id}/${action}`, body);
  const requestOf = (res: { body: { requests: Array<{ taskId: string; requestId: string }> } }, taskId: string) =>
    res.body.requests.find((r) => r.taskId === taskId)!.requestId;
  const events = async (id: string, kind: string) =>
    (await t.pool.query(`SELECT detail, note FROM task_events WHERE task_id = $1 AND kind = $2`, [id, kind])).rows;

  test('deferring marks outstanding tasks, not finished ones', async () => {
    const a = await task({ due: '2026-11-01' });
    const b = await task({ status: 'in_progress' });
    const sub = await task({ parent: b, depth: 1, status: 'blocked' });
    const done = await task({ status: 'completed' });
    const gone = await task({ status: 'cancelled' });
    await defer();
    assert.deepEqual(
      [(await row(a)).marked, (await row(b)).marked, (await row(sub)).marked, (await row(done)).marked, (await row(gone)).marked],
      [true, true, true, false, false],
    );
    assert.equal((await events(a, 'review_required')).length, 1);
    assert.equal((await events(done, 'review_required')).length, 0);
    assert.equal((await row(a)).due, '2026-11-01', 'the due date is unchanged');
    await resume();
    const list = (await ann.request('GET', `/projects/${projectId}/records`)).body.tasks;
    const shown = list.find((x: { id: string }) => x.id === a);
    assert.equal(shown.deadlineReviewRequired, true);
    assert.equal(shown.overdue, false, 'Deadline review required replaces Overdue');
    assert.deepEqual(shown.mayAct.filter((m: string) => ['start', 'unblock', 'complete'].includes(m)), []);
    assert.equal(list.find((x: { id: string }) => x.id === done).deadlineReviewRequired, false);
  });

  test('closing marks outstanding tasks too', async () => {
    const a = await task();
    const kept = await owner.request('POST', `/projects/${projectId}/closure/dispositions`, { recordKind: 'task', recordId: a, disposition: 'keep', reason: 'Handed on' });
    assert.equal(kept.status, 201, JSON.stringify(kept.body));
    const r = await owner.request('POST', `/projects/${projectId}/transition`, { to: 'closed', reason: 'Finished', outcome: 'partially_delivered' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await row(a)).marked, true);
  });

  test('a marked task cannot start or complete after resuming', async () => {
    const a = await task();
    const b = await task({ status: 'in_progress' });
    const c = await task({ status: 'blocked' });
    await defer();
    await resume();
    for (const [id, action] of [[a, 'start'], [b, 'complete'], [c, 'unblock']] as const) {
      const r = await act(ann, id, action, { note: 'Going ahead' });
      assert.deepEqual([r.status, r.body.message], [409, NEEDS_DATE], action);
    }
    assert.deepEqual([(await row(a)).status, (await row(b)).status, (await row(c)).status], ['not_started', 'in_progress', 'blocked']);
  });

  test('comments are still allowed', async () => {
    const a = await task();
    await defer();
    await resume();
    const r = await act(ann, a, 'block', { note: 'Waiting for funding to be confirmed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await row(a)).marked, true);
  });

  test('the PM proposes new dates while Deferred and an Owner approves some', async () => {
    const a = await task({ title: 'Alpha' });
    const b = await task({ title: 'Beta', status: 'in_progress' });
    await defer();
    assert.equal((await ann.request('GET', `/projects/${projectId}/deadline-review`)).status, 403);
    const forbidden = await review(ann, [{ taskId: a, dueOn: '2026-11-30' }]);
    assert.deepEqual([forbidden.status, forbidden.body.message], [403, 'Only the Project Manager or a Deputy can prepare a deadline review.']);

    const screen = await deputy.request('GET', `/projects/${projectId}/deadline-review`);
    assert.equal(screen.status, 200, JSON.stringify(screen.body));
    const alpha = screen.body.tasks.find((x: { id: string }) => x.id === a);
    assert.deepEqual(
      { title: alpha.title, depth: alpha.depth, parentId: alpha.parentId, status: alpha.status, previousDueOn: alpha.previousDueOn, membershipState: alpha.membershipState, pendingRequest: alpha.pendingRequest },
      { title: 'Alpha', depth: 0, parentId: null, status: 'not_started', previousDueOn: '2026-11-20', membershipState: 'active', pendingRequest: null },
    );
    assert.equal(alpha.assignee.id, ids.ann);
    assert.equal(screen.body.tasks.length, 2);

    const sub = await review(pm, [{ taskId: a, dueOn: '2026-11-30' }, { taskId: b, dueOn: '2026-12-05' }]);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    assert.equal(sub.body.requests.length, 2);
    assert.ok(sub.body.batchId);
    assert.notEqual(sub.body.batchId, projectId, 'never the closure batch');
    assert.deepEqual([(await row(a)).due, (await row(a)).marked], ['2026-11-20', true], 'waiting changes nothing');
    const pending = (await pm.request('GET', `/projects/${projectId}/deadline-review`)).body.tasks.find((x: { id: string }) => x.id === a).pendingRequest;
    assert.equal(pending.id, requestOf(sub, a));

    t.clock.advanceSeconds(60);
    const ok = await approve(owner, requestOf(sub, a));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([(await row(a)).due, (await row(a)).marked], ['2026-11-30', false]);
    assert.deepEqual([(await row(b)).due, (await row(b)).marked], ['2026-11-20', true]);
    assert.deepEqual((await events(a, 'deadline_reviewed'))[0].detail, { dueOn: { from: '2026-11-20', to: '2026-11-30' } });
    const left = (await pm.request('GET', `/projects/${projectId}/deadline-review`)).body.tasks;
    assert.deepEqual(left.map((x: { id: string }) => x.id), [b]);
  });

  test('a new date equal to the old or in the past is refused', async () => {
    const a = await task();
    await defer();
    const same = await review(pm, [{ taskId: a, dueOn: '2026-11-20' }]);
    assert.deepEqual([same.status, same.body.message], [409, 'Choose a date different from the previous due date.']);
    const past = await review(pm, [{ taskId: a, dueOn: '2026-11-08' }]);
    assert.deepEqual([past.status, past.body.message], [409, 'Choose a date that is not in the past.']);
    const bad = await review(pm, [{ taskId: a, dueOn: 'soon' }]);
    assert.equal(bad.status, 400);
    const none = await review(pm, []);
    assert.equal(none.status, 400);

    // Re-checked at application: the date has become past by the time it is approved.
    const ok = await review(pm, [{ taskId: a, dueOn: '2026-11-10' }]);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    await passDays(3);
    const late = await approve(owner, requestOf(ok, a));
    assert.deepEqual([late.status, late.body.message], [409, 'Choose a date that is not in the past.']);
    assert.equal((await row(a)).marked, true);
    const status = (await t.pool.query(`SELECT status FROM change_requests WHERE id = $1`, [requestOf(ok, a)])).rows[0].status;
    assert.equal(status, 'pending');
  });

  test('a later-than-parent date is allowed and flagged', async () => {
    const p = await task({ due: '2026-11-20' });
    const c = await task({ parent: p, depth: 1, due: '2026-11-18' });
    await defer();
    const r = await review(pm, [{ taskId: c, dueOn: '2026-12-31' }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.requests[0].dueAfterParent, true);
  });

  test('resuming does not wait for every review', async () => {
    const a = await task();
    await defer();
    const sub = await review(pm, [{ taskId: a, dueOn: '2026-11-30' }]);
    assert.equal(sub.status, 201);
    await resume();
    assert.equal((await row(a)).marked, true);
    // The review can still be approved once Active, and then the task may start.
    assert.equal((await approve(owner, requestOf(sub, a))).status, 200);
    assert.equal((await act(ann, a, 'start')).status, 200);
  });

  test('a subtask with an approved date can start while its parent review is pending', async () => {
    const p = await task({ title: 'Parent' });
    const c = await task({ parent: p, depth: 1, title: 'Child' });
    await defer();
    const sub = await review(pm, [{ taskId: p, dueOn: '2026-12-10' }, { taskId: c, dueOn: '2026-12-01' }]);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    assert.equal((await approve(owner, requestOf(sub, c))).status, 200);
    await resume();
    const start = await act(ann, c, 'start');
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const parent = await act(ann, p, 'start');
    assert.deepEqual([parent.status, parent.body.message], [409, NEEDS_DATE]);
    // Once the parent's date is approved it may start, but still cannot complete over an unfinished subtask.
    assert.equal((await approve(owner, requestOf(sub, p))).status, 200);
    assert.equal((await act(ann, p, 'start')).status, 200);
    const done = await act(ann, p, 'complete', { note: 'Done' });
    assert.deepEqual([done.status, done.body.message], [409, 'Finish the subtasks first, or record an override.']);
  });

  test('work finished during the pause is reconciled with its actual date', async () => {
    const a = await task({ status: 'in_progress' });
    await defer();
    await passDays(3);
    const r = await ann.request('POST', `/projects/${projectId}/changes`, {
      kind: 'reconcile_completion',
      targetKind: 'task',
      targetId: a,
      terms: { completedOn: '2026-11-10', explanation: 'Finished by the supplier during the pause', evidence: 'https://example.org/handover' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([(await row(a)).status, (await row(a)).marked], ['in_progress', true], 'waiting changes nothing');
    t.clock.advanceSeconds(60);
    const ok = await approve(owner, r.body.request.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = await row(a);
    assert.deepEqual([after.status, after.marked], ['completed', false]);
    assert.equal(after.completed_at.toISOString(), '2026-11-10T15:59:59.999Z', 'end of 10 November, UTC+8');
    const [rec] = await events(a, 'reconciled');
    assert.equal(rec.note, 'Finished by the supplier during the pause');
    assert.equal(rec.detail.completedOn, '2026-11-10');
    assert.equal(rec.detail.evidence, 'https://example.org/handover');
  });

  test('a reconciliation date before the pause or in the future is refused', async () => {
    const a = await task({ status: 'in_progress' });
    const free = await task();
    await defer();
    await passDays(3);
    const propose = (c: Client, id: string, terms: object) =>
      c.request('POST', `/projects/${projectId}/changes`, { kind: 'reconcile_completion', targetKind: 'task', targetId: id, terms });
    const before = await propose(ann, a, { completedOn: '2026-11-08', explanation: 'Done' });
    assert.deepEqual([before.status, before.body.message], [409, 'The completion date cannot be before the pause began.']);
    const future = await propose(ann, a, { completedOn: '2026-11-30', explanation: 'Done' });
    assert.deepEqual([future.status, future.body.message], [409, 'The completion date cannot be in the future.']);
    const blank = await propose(ann, a, { completedOn: '2026-11-10', explanation: '  ' });
    assert.deepEqual([blank.status, blank.body.message], [400, 'Explain how the work was completed.']);
    const other = await propose(ben, a, { completedOn: '2026-11-10', explanation: 'Done' });
    assert.deepEqual([other.status, other.body.message], [403, 'Only the assignee, the Project Manager or a Deputy can reconcile this task.']);
    assert.equal((await propose(deputy, a, { completedOn: '2026-11-10', explanation: 'Done' })).status, 201);
    await t.pool.query(`UPDATE tasks SET deadline_review_required = false WHERE id = $1`, [free]);
    const unmarked = await propose(pm, free, { completedOn: '2026-11-10', explanation: 'Done' });
    assert.equal(unmarked.status, 409);
  });

  test('a parent cannot be reconciled over unfinished subtasks', async () => {
    const p = await task({ status: 'in_progress' });
    await task({ parent: p, depth: 1, status: 'in_progress' });
    await defer();
    const r = await ann.request('POST', `/projects/${projectId}/changes`, {
      kind: 'reconcile_completion', targetKind: 'task', targetId: p, terms: { completedOn: '2026-11-09', explanation: 'Done' },
    });
    assert.deepEqual([r.status, r.body.message], [409, 'Finish the subtasks first, or record an override.']);
  });

  test('approve all approves the batch', async () => {
    const a = await task();
    const b = await task();
    const c = await task();
    await defer();
    const sub = await review(pm, [{ taskId: a, dueOn: '2026-11-30' }, { taskId: b, dueOn: '2026-12-01' }, { taskId: c, dueOn: '2026-12-02' }]);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    await t.pool.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [c]);
    assert.equal((await ann.request('POST', `/changes/batch/${sub.body.batchId}/approve`, {})).status, 403);
    t.clock.advanceSeconds(60);
    const all = await owner.request('POST', `/changes/batch/${sub.body.batchId}/approve`, {});
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const outcome = (taskId: string) => all.body.results.find((x: { taskId: string }) => x.taskId === taskId);
    assert.equal(outcome(a).outcome, 'applied');
    assert.equal(outcome(a).requestId, requestOf(sub, a));
    assert.equal(outcome(b).outcome, 'applied');
    assert.equal(outcome(c).outcome, 'refused');
    assert.ok(outcome(c).reason);
    assert.deepEqual([(await row(a)).due, (await row(b)).due, (await row(a)).marked], ['2026-11-30', '2026-12-01', false]);
    assert.equal((await owner.request('POST', `/changes/batch/${uuidv7()}/approve`, {})).status, 404);
  });

  test('approve all waits for the count when more than one approver is needed', async () => {
    const a = await task();
    await t.pool.query(`UPDATE approval_policy SET required = 2`);
    await defer();
    const sub = await review(pm, [{ taskId: a, dueOn: '2026-11-30' }]);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    t.clock.advanceSeconds(60);
    const first = await owner.request('POST', `/changes/batch/${sub.body.batchId}/approve`, {});
    assert.equal(first.body.results[0].outcome, 'waiting');
    assert.equal((await row(a)).marked, true);
    t.clock.advanceSeconds(60);
    const second = await sponsor.request('POST', `/changes/batch/${sub.body.batchId}/approve`, {});
    assert.equal(second.body.results[0].outcome, 'applied');
    assert.equal((await row(a)).marked, false);
  });

  test('normal completion records when the task was completed', async () => {
    const a = await task({ status: 'in_progress' });
    const r = await act(ann, a, 'complete', { note: 'Done' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((await row(a)).completed_at);
  });
});
