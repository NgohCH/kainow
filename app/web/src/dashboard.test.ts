import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  awaitingLabel,
  barWidth,
  cancelledLabel,
  completionLabel,
  expandAllPatch,
  monthLabel,
  onTimeLabel,
  overdueDaysLabel,
  plannedEndLabel,
  stageLabel,
  updatedLabel,
  visibleHomeSections,
  homeQuery,
  withTodayMarker,
} from './dashboard.ts';

test('the stage and its days; a stopped one says so', () => {
  const s = { stage: 'Build', substage: null, days: 4, stopped: null };
  assert.equal(stageLabel(null), 'None');
  assert.equal(stageLabel(s), 'Build, 4 days');
  assert.equal(stageLabel({ ...s, substage: 'Testing', days: 1 }), 'Build, Testing, 1 day');
  assert.equal(stageLabel({ ...s, stopped: 'deferred' }), 'Build, stopped when deferred, after 4 days');
  assert.equal(stageLabel({ ...s, stopped: 'closed', days: 0 }), 'Build, stopped when closed, after 0 days');
});

test('completion label: measurable, cancelled, and not measurable', () => {
  assert.equal(completionLabel({ state: 'measurable', done: 31, total: 50, cancelled: 4, percent: 62 }), '62% task completion (31 of 50 tasks)');
  assert.equal(cancelledLabel({ state: 'measurable', done: 31, total: 50, cancelled: 4, percent: 62 }), '4 cancelled');
  assert.equal(cancelledLabel({ state: 'measurable', done: 1, total: 2, cancelled: 0, percent: 50 }), null);
  assert.equal(completionLabel({ state: 'not_measurable', cancelled: 4 }), 'Progress not yet measurable');
  assert.equal(cancelledLabel({ state: 'not_measurable', cancelled: 4 }), '4 cancelled');
  assert.equal(completionLabel({ state: 'measurable', done: 1, total: 300, cancelled: 0, percent: 0 }), '0% task completion (1 of 300 tasks)');
});

test('on-time label and awaiting review', () => {
  assert.equal(onTimeLabel({ state: 'measured', due: 40, done: 32, late: 3, percent: 80, awaitingReview: 0 }), '32 of 40 tasks due so far are done (80%)');
  assert.equal(onTimeLabel({ state: 'nothing_due', awaitingReview: 0 }), 'Nothing due yet');
  assert.equal(awaitingLabel({ state: 'nothing_due', awaitingReview: 2 }), 'Awaiting deadline review: 2');
  assert.equal(awaitingLabel({ state: 'nothing_due', awaitingReview: 0 }), null);
});

test('planned end label', () => {
  assert.equal(plannedEndLabel({ state: 'none' }), 'No planned end date');
  assert.equal(plannedEndLabel({ state: 'ended', daysAgo: 3 }), 'Ended 3 days ago');
  assert.equal(plannedEndLabel({ state: 'ended', daysAgo: 1 }), 'Ended 1 day ago');
  assert.equal(plannedEndLabel({ state: 'ahead', days: 0 }), 'Ends today');
  assert.equal(plannedEndLabel({ state: 'ahead', days: 12 }), 'Ends in 12 days');
});

test('updated label shows UTC+8', () => {
  assert.equal(updatedLabel('2026-11-19T02:42:00Z'), 'Updated 10:42 UTC+8');
  assert.equal(updatedLabel('2026-11-19T17:05:00Z'), 'Updated 01:05 UTC+8');
});

test('overdue days label', () => {
  assert.equal(overdueDaysLabel(1), 'overdue 1 day');
  assert.equal(overdueDaysLabel(5), 'overdue 5 days');
});

test('home sections: saved order, hidden ones left out, Needs you first and never hidden', () => {
  assert.deepEqual(visibleHomeSections(['myTasks', 'needsYou', 'myProjects'], ['myTasks']), ['needsYou', 'myProjects']);
  assert.deepEqual(visibleHomeSections(['myProjects', 'myTasks'], ['needsYou']), ['needsYou', 'myProjects', 'myTasks']);
});

test('expand all and collapse all set every shown project', () => {
  assert.deepEqual(expandAllPatch({ a: false, z: true }, ['a', 'b'], true), { a: true, b: true, z: true });
  assert.deepEqual(expandAllPatch({ a: true }, ['a', 'b'], false), { a: false, b: false });
});

test('timeline: months are named, and a Today marker sits in order', () => {
  assert.equal(monthLabel('2026-11'), 'November 2026');
  const months = [
    { month: '2026-10', lines: [{ day: '2026-10-30', kind: 'status', label: 'Active' }] },
    { month: '2026-11', lines: [{ day: '2026-11-02', kind: 'stage', label: 'a' }, { day: '2026-11-25', kind: 'tasks_due', label: 'b' }] },
  ] as const;
  const out = withTodayMarker(months.map((m) => ({ month: m.month, lines: [...m.lines] })), '2026-11-20');
  assert.deepEqual(out[1].items.map((i) => (i.today ? 'TODAY' : i.line.label)), ['a', 'TODAY', 'b']);
  // A month with no recorded lines still carries the marker.
  const empty = withTodayMarker([{ month: '2026-10', lines: [] }], '2026-11-20');
  assert.equal(empty.length, 2);
  assert.equal(empty[1].month, '2026-11');
  assert.equal(empty[1].items[0].today, true);
});

test('bar width never shows a missing value as a bar', () => {
  assert.equal(barWidth(31, 100), 31);
  assert.equal(barWidth(null, 100), null);
  assert.equal(barWidth(0, 100), 0);
  assert.equal(barWidth(150, 100), 100);
});

test('home query uses defaults until preferences are loaded', () => {
  const home = { includeArchived: true, showCompleted: true };
  assert.equal(homeQuery(home, false), 'includeArchived=0&showCompleted=0');
  assert.equal(homeQuery(home, true), 'includeArchived=1&showCompleted=1');
});
