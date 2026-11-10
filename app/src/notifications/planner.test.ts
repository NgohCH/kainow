import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Calendar } from './calendar';
import { type RiskSnap, type TaskSnap, type Timings, dueNow, planProject } from './planner';

const cal: Calendar = { dayCounting: 'working', weekdays: [1, 2, 3, 4, 5], holidays: new Set() };
const timings: Timings = { leadDays: [7, 1], escalationDays: 3 };
const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');
const at = (s: string) => new Date(s);

// Due Monday 2026-11-23 unless stated; the due date was set long before.
const task = (o: Partial<TaskSnap> = {}): TaskSnap => ({
  id: 't1', parentId: null, title: 'Write plan', assigneeId: 'u1', dueOn: '2026-11-23',
  status: 'in_progress', deadlineReviewRequired: false, dueSetAt: at('2026-10-01T00:00:00Z'),
  reopenCount: 0, ...o,
});
const risk = (o: Partial<RiskSnap> = {}): RiskSnap => ({
  id: 'r1', description: 'Supplier delay', status: 'open', responsibleId: null, reviewOn: '2026-11-25', ...o,
});
const plan = (tasks: TaskSnap[], risks: RiskSnap[] = []) => planProject({ cal, timings, tasks, risks });
const keys = (p: { key: string }[]) => p.map((x) => x.key).sort();

test('two reminders, one escalation for a fresh task', () => {
  const p = plan([task()]);
  assert.deepEqual(keys(p), [
    'task:t1:overdue:2026-11-23:0',
    'task:t1:reminder:1:2026-11-23:0',
    'task:t1:reminder:7:2026-11-23:0',
  ]);
  const by = Object.fromEntries(p.map((x) => [x.key, iso(x.fireAt)]));
  assert.equal(by['task:t1:reminder:7:2026-11-23:0'], '2026-11-12T01:00:00Z'); // Thu 09:00
  assert.equal(by['task:t1:reminder:1:2026-11-23:0'], '2026-11-20T01:00:00Z'); // Fri 09:00
  assert.equal(by['task:t1:overdue:2026-11-23:0'], '2026-11-27T01:00:00Z'); // Fri 09:00
  const r = p.find((x) => x.kind === 'reminder' && x.detail.lead === 7)!;
  assert.equal(r.detail.dueOn, '2026-11-23');
  assert.equal(r.detail.title, 'Write plan');
  assert.equal(r.detail.reopenCount, 0);
});

test('no reminder whose time passed before the due date was set', () => {
  const p = plan([task({ dueSetAt: at('2026-11-15T00:00:00Z') })]);
  assert.deepEqual(keys(p), ['task:t1:overdue:2026-11-23:0', 'task:t1:reminder:1:2026-11-23:0']);
});

test('past due set gives past_due_set and, when 3+ days overdue, overdue at the same slot', () => {
  // Set Wed 2026-12-02 14:00 UTC+8 for a task due Mon 2026-11-23 (7 working days late).
  const p = plan([task({ dueSetAt: at('2026-12-02T06:00:00Z') })]);
  assert.deepEqual(keys(p), ['task:t1:overdue:2026-11-23:0', 'task:t1:past_due_set:2026-11-23:0']);
  for (const x of p) assert.equal(iso(x.fireAt), '2026-12-03T01:00:00Z');
  // Only slightly late: overdue keeps its normal wait; past_due_set still planned.
  const q = plan([task({ dueSetAt: at('2026-11-24T06:00:00Z') })]);
  assert.equal(iso(q.find((x) => x.kind === 'past_due_set')!.fireAt), '2026-11-25T01:00:00Z');
  assert.equal(iso(q.find((x) => x.kind === 'overdue')!.fireAt), '2026-11-27T01:00:00Z');
});

test('amended due date changes every key', () => {
  const a = keys(plan([task()]));
  const b = keys(plan([task({ dueOn: '2026-11-30' })]));
  assert.equal(a.filter((k) => b.includes(k)).length, 0);
});

test('reopen count changes the episode', () => {
  const a = keys(plan([task()]));
  const b = keys(plan([task({ reopenCount: 1 })]));
  assert.equal(a.filter((k) => b.includes(k)).length, 0);
  assert.ok(b.every((k) => k.endsWith(':1')));
});

test('completed, cancelled and deadline-review tasks plan nothing', () => {
  assert.deepEqual(plan([task({ status: 'completed' })]), []);
  assert.deepEqual(plan([task({ status: 'cancelled' })]), []);
  assert.deepEqual(plan([task({ deadlineReviewRequired: true })]), []);
});

test('blocked tasks still plan', () => {
  assert.equal(plan([task({ status: 'blocked' })]).length, 3);
});

test('parent deadline planned for an open grandchild, not for a completed one', () => {
  const top = task({ id: 'p', dueOn: '2026-11-20' });
  const mid = task({ id: 'm', parentId: 'p', dueOn: '2026-12-10' });
  const leaf = task({ id: 'g', parentId: 'm', dueOn: '2026-12-11' });
  const done = task({ id: 'd', parentId: 'm', dueOn: '2026-12-11', status: 'completed' });
  const p = plan([top, mid, leaf, done]).filter((x) => x.kind === 'parent_deadline');
  assert.deepEqual(keys(p), [
    'task:g:parent_deadline:m:2026-12-10',
    'task:g:parent_deadline:p:2026-11-20',
    'task:m:parent_deadline:p:2026-11-20',
  ]);
  const x = p.find((y) => y.key === 'task:g:parent_deadline:p:2026-11-20')!;
  assert.equal(iso(x.fireAt), '2026-11-23T01:00:00Z'); // next slot after Fri deadline: Mon 09:00
  assert.equal(x.detail.parentId, 'p');
  assert.equal(x.detail.parentDueOn, '2026-11-20');
  // A completed parent, or a child under deadline review, plans no parent-deadline.
  const none = plan([task({ id: 'p', status: 'completed' }), task({ id: 'c', parentId: 'p' })]);
  assert.equal(none.filter((y) => y.kind === 'parent_deadline').length, 0);
  const rev = plan([task({ id: 'p' }), task({ id: 'c', parentId: 'p', deadlineReviewRequired: true })]);
  assert.equal(rev.filter((y) => y.kind === 'parent_deadline').length, 0);
});

test('risk due and missed keyed by review date; resolved risk plans nothing', () => {
  const p = plan([], [risk(), risk({ id: 'r2', status: 'resolved' }), risk({ id: 'r3', reviewOn: null })]);
  assert.deepEqual(keys(p), ['risk:r1:review_due:2026-11-25', 'risk:r1:review_missed:2026-11-25']);
  const by = Object.fromEntries(p.map((x) => [x.kind, iso(x.fireAt)]));
  assert.equal(by.risk_review_due, '2026-11-25T01:00:00Z');
  assert.equal(by.risk_review_missed, '2026-11-26T01:00:00Z');
  assert.equal(p[0]!.detail.reviewOn, '2026-11-25');
  assert.equal(p[0]!.detail.description, 'Supplier delay');
});

test('dueNow keeps only the latest reminder when 7-day and 1-day are both due, and drops reminders after the deadline as obsolete', () => {
  const p = plan([task()]);
  const mid = dueNow(p, at('2026-11-20T02:00:00Z')); // after Fri 09:00, before the deadline
  assert.deepEqual(mid.fire.map((x) => x.key), ['task:t1:reminder:1:2026-11-23:0']);
  assert.deepEqual(mid.obsolete.map((x) => x.key), ['task:t1:reminder:7:2026-11-23:0']);
  const late = dueNow(p, at('2026-11-23T16:00:00Z')); // past the Monday deadline
  assert.equal(late.fire.length, 0);
  assert.equal(late.obsolete.length, 2);
  assert.deepEqual(dueNow(p, at('2026-11-10T00:00:00Z')), { fire: [], obsolete: [] });
  const esc = dueNow(p, at('2026-11-27T01:00:00Z'));
  assert.deepEqual(esc.fire.map((x) => x.kind), ['overdue']);
});
