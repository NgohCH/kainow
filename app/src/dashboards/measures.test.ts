import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStatus } from '../records/tasks';
import { COVERAGE_NOTE, type LeafRow, MEASURE_DEFINITIONS, MEASURES_VERSION, onTimeCompletion, percent, plannedEnd, referenceDay, taskCompletion } from './measures';

const leaf = (status: TaskStatus, dueOn = '2026-11-01', completedOn: string | null = null, deadlineReviewRequired = false): LeafRow => ({
  status,
  dueOn,
  completedOn: status === 'completed' ? (completedOn ?? dueOn) : null,
  deadlineReviewRequired,
});
const many = (n: number, status: TaskStatus): LeafRow[] => Array.from({ length: n }, () => leaf(status));

test('percent floors: 199/200 is 99, 1/300 is 0 with counts', () => {
  assert.equal(percent(199, 200), 99);
  assert.equal(percent(1, 300), 0);
  assert.equal(percent(200, 200), 100);
  assert.equal(percent(0, 0), 0);
  assert.deepEqual(taskCompletion([...many(199, 'completed'), leaf('in_progress')]), { state: 'measurable', done: 199, total: 200, cancelled: 0, percent: 99 });
  assert.deepEqual(taskCompletion([leaf('completed'), ...many(299, 'not_started')]), { state: 'measurable', done: 1, total: 300, cancelled: 0, percent: 0 });
});

test('only cancelled leaves is not measurable and shows cancelled count', () => {
  assert.deepEqual(taskCompletion(many(4, 'cancelled')), { state: 'not_measurable', cancelled: 4 });
  assert.deepEqual(taskCompletion([...many(4, 'cancelled'), leaf('completed'), leaf('blocked')]), { state: 'measurable', done: 1, total: 2, cancelled: 4, percent: 50 });
});

test('no leaves is not measurable', () => {
  assert.deepEqual(taskCompletion([]), { state: 'not_measurable', cancelled: 0 });
  assert.deepEqual(onTimeCompletion([], '2026-11-19'), { state: 'nothing_due', awaitingReview: 0 });
});

test('late completion counts as done and as late', () => {
  const leaves = [leaf('completed', '2026-11-10', '2026-11-12'), leaf('completed', '2026-11-10', '2026-11-10'), leaf('in_progress', '2026-11-10')];
  assert.deepEqual(onTimeCompletion(leaves, '2026-11-19'), { state: 'measured', due: 3, done: 2, late: 1, percent: 66, awaitingReview: 0 });
});

test('deadline review tasks are left out of due and counted in awaitingReview', () => {
  const leaves = [leaf('completed', '2026-11-10'), leaf('not_started', '2026-11-10', null, true), leaf('blocked', '2026-12-10', null, true)];
  assert.deepEqual(onTimeCompletion(leaves, '2026-11-19'), { state: 'measured', due: 1, done: 1, late: 0, percent: 100, awaitingReview: 2 });
  assert.deepEqual(onTimeCompletion([leaf('in_progress', '2026-11-10', null, true)], '2026-11-19'), { state: 'nothing_due', awaitingReview: 1 });
});

test('nothing due before reference day is nothing_due', () => {
  const leaves = [leaf('completed', '2026-11-25'), leaf('not_started', '2026-12-01'), leaf('cancelled', '2026-11-01')];
  assert.deepEqual(onTimeCompletion(leaves, '2026-11-19'), { state: 'nothing_due', awaitingReview: 0 });
});

test('due on the reference day is not yet due', () => {
  assert.deepEqual(onTimeCompletion([leaf('not_started', '2026-11-19')], '2026-11-19'), { state: 'nothing_due', awaitingReview: 0 });
  assert.deepEqual(onTimeCompletion([leaf('not_started', '2026-11-19')], '2026-11-20'), { state: 'measured', due: 1, done: 0, late: 0, percent: 0, awaitingReview: 0 });
});

test('Deferred project uses the deferral day, Closed uses the closing day', () => {
  const today = '2026-11-19';
  assert.equal(referenceDay({ status: 'deferred', today, deferredOn: '2026-10-05', closedOn: null }), '2026-10-05');
  assert.equal(referenceDay({ status: 'closed', today, deferredOn: '2026-10-05', closedOn: '2026-10-20' }), '2026-10-20');
  assert.equal(referenceDay({ status: 'active', today, deferredOn: '2026-10-05', closedOn: null }), today, 'resumed after a deferral');
  assert.equal(referenceDay({ status: 'planned', today, deferredOn: null, closedOn: null }), today);
});

test('plannedEnd none / ahead 10 / ended 3', () => {
  assert.deepEqual(plannedEnd(null, '2026-11-19'), { state: 'none' });
  assert.deepEqual(plannedEnd('2026-11-29', '2026-11-19'), { state: 'ahead', days: 10 });
  assert.deepEqual(plannedEnd('2026-11-16', '2026-11-19'), { state: 'ended', daysAgo: 3 });
  assert.deepEqual(plannedEnd('2026-11-19', '2026-11-19'), { state: 'ahead', days: 0 });
  assert.deepEqual(plannedEnd('2027-01-01', '2026-12-31'), { state: 'ahead', days: 1 }, 'across a year');
});

test('definitions: one per measure of the §3 table, with the version and coverage note', () => {
  assert.equal(MEASURES_VERSION, '1');
  assert.equal(COVERAGE_NOTE, 'Counts all authorised records in the project except deleted ones and any under credential review.');
  assert.deepEqual(
    MEASURE_DEFINITIONS.map((d) => d.label),
    ['Eligible leaf task', 'Task completion', 'On-time completion', 'Overdue', 'Blocked', 'Due soon', 'Stage and stage duration', 'Planned end', 'Open questions', 'Risks', 'Vacant required role', 'Escalations', 'Pending invitations', 'Refresh time',
      'Resource lines', 'Resource lines finished in the period', 'Resources past needed-by date', 'Resource lines with overlaps', 'Shared items in overlap', 'Finance summary', 'Financial tracking not required'],
  );
  assert.equal(new Set(MEASURE_DEFINITIONS.map((d) => d.key)).size, MEASURE_DEFINITIONS.length);
  assert.ok(MEASURE_DEFINITIONS.every((d) => d.definition.length > 0));
});
