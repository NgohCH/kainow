import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NeedsYouItem } from '../dashboard.ts';
import { type ProjectCount, attentionByProject, attentionCounts, distinctNames, itemDate, shownRows, startsOpen, taskCounts, tasksByProject } from './byProject.ts';
import type { TaskRow } from './home.ts';

const item = (projectId: string, kind: NeedsYouItem['kind'], more: Partial<NeedsYouItem> = {}): NeedsYouItem => ({ kind, projectId, projectName: projectId, label: kind, since: null, link: '#/x', ...more });
const row = (projectId: string, group: TaskRow['group'], dueOn = '2026-11-20', more: Partial<TaskRow> = {}): TaskRow => ({ id: `${projectId}-${group}-${dueOn}`, title: 't', projectId, projectName: projectId, dueOn, status: 'todo', group, ...more });
const order = (list: { projectId: string }[]) => list.map((p) => p.projectId).join(' ');
const sum = (counts: ProjectCount[]) => counts.reduce((n, c) => n + c.count, 0);

test('needs you: most overdue first, then most to review, then most due soon, then by name; blocked does not decide', () => {
  assert.equal(order(attentionByProject([item('a', 'overdue'), item('b', 'overdue'), item('b', 'overdue')])), 'b a');
  assert.equal(order(attentionByProject([item('a', 'overdue'), item('a', 'due_soon'), item('b', 'overdue'), item('b', 'approval')])), 'b a');
  assert.equal(order(attentionByProject([item('a', 'blocked'), item('a', 'blocked'), item('b', 'due_soon')])), 'b a');
  assert.equal(order(attentionByProject([item('b', 'blocked'), item('a', 'blocked')])), 'a b');
});
test('tasks: the same order, with tasks awaiting a deadline review as those to review', () => {
  assert.equal(order(tasksByProject([row('a', 'overdue'), row('b', 'overdue', '2026-11-01'), row('b', 'overdue')])), 'b a');
  assert.equal(order(tasksByProject([row('a', 'dueSoon'), row('a', 'dueSoon', '2026-11-21'), row('b', 'awaitingReview')])), 'b a');
  assert.equal(order(tasksByProject([row('a', 'later'), row('a', 'later', '2026-12-01'), row('b', 'dueSoon')])), 'b a');
  assert.equal(order(tasksByProject([row('b', 'later'), row('a', 'completed')])), 'a b');
});
test('inside a project, items keep the urgency order and their own order in each group', () => {
  const [p] = attentionByProject([item('a', 'due_soon'), item('a', 'blocked'), item('a', 'question', { label: 'q1' }), item('a', 'overdue'), item('a', 'approval', { label: 'q2' })]);
  assert.deepEqual(p.groups.map((g) => g.group), ['overdue', 'review', 'blocked', 'dueSoon']);
  assert.deepEqual(p.groups[1].items.map((i) => i.label), ['q1', 'q2']);
  assert.deepEqual(attentionCounts(p).map((c) => c.word), ['1 overdue', '2 to review', '1 blocked', '1 due soon']);
});
test('inside a project, tasks are overdue first, then by due date, with completed ones last', () => {
  const [p] = tasksByProject([row('a', 'completed', '2026-10-01'), row('a', 'later', '2026-12-01'), row('a', 'dueSoon', '2026-11-28'), row('a', 'awaitingReview', '2026-11-02'), row('a', 'overdue', '2026-11-19'), row('a', 'overdue', '2026-11-18')]);
  assert.deepEqual(p.rows.map((r) => `${r.group} ${r.dueOn}`), ['overdue 2026-11-18', 'overdue 2026-11-19', 'awaitingReview 2026-11-02', 'dueSoon 2026-11-28', 'later 2026-12-01', 'completed 2026-10-01']);
});
test('counts add up to the list; an item that stands for several is one item, as before', () => {
  const items = [item('a', 'copies', { count: 3 }), item('a', 'overdue'), item('b', 'resources', { count: 2 }), item('b', 'minutes'), item('c', 'blocked')];
  const boxes = attentionByProject(items);
  assert.equal(boxes.reduce((n, p) => n + sum(p.counts), 0), items.length);
  assert.deepEqual(boxes.flatMap((p) => p.groups.flatMap((g) => g.items)).map((i) => i.label).sort(), items.map((i) => i.label).sort());
  assert.deepEqual(boxes.flatMap((p) => p.groups.flatMap((g) => g.items)).map((i) => i.count).filter(Boolean).sort(), [2, 3]);
  const rows = [row('a', 'overdue'), row('a', 'later'), row('b', 'completed'), row('b', 'awaitingReview'), row('b', 'dueSoon')];
  const tasks = tasksByProject(rows);
  assert.equal(tasks.reduce((n, p) => n + sum(p.counts), 0), rows.length);
  assert.equal(tasks.reduce((n, p) => n + p.rows.length, 0), rows.length);
});
test('blocked tasks are also counted in the task header, over their due-date group', () => {
  const [p] = tasksByProject([row('a', 'overdue', '2026-11-01', { status: 'blocked' }), row('a', 'later')]);
  assert.deepEqual(p.counts, [{ group: 'overdue', count: 1 }, { group: 'later', count: 1 }]);
  assert.deepEqual(taskCounts(p).map((c) => c.word), ['1 overdue', '1 blocked', '1 later']);
});
test('two projects with one name stay apart', () => {
  const same = { projectName: 'Same' };
  assert.equal(attentionByProject([item('a', 'overdue', same), item('b', 'overdue', same)]).length, 2);
  assert.equal(tasksByProject([row('a', 'later', '2026-12-01', same), row('b', 'later', '2026-12-01', same)]).length, 2);
});
test('projects with one name get names that tell them apart', () => {
  const box = (projectId: string, projectName: string) => ({ projectId, projectName });
  assert.deepEqual(distinctNames([box('a', 'Same'), box('b', 'Other'), box('c', 'Same')]), ['Same (1 of 2 with this name)', 'Other', 'Same (2 of 2 with this name)']);
});
test('a project with no match after a filter is not listed', () => {
  const rows = [row('a', 'later', '2026-12-01', { status: 'blocked' }), row('b', 'later')];
  assert.equal(order(tasksByProject(rows.filter((r) => r.status === 'blocked'))), 'a');
});
test('one project, and nothing at all', () => {
  assert.equal(attentionByProject([item('a', 'overdue')]).length, 1);
  assert.deepEqual(attentionByProject([]), []);
  assert.deepEqual(tasksByProject([]), []);
});
test('the first three boxes start open; a box shows five rows until all are asked for', () => {
  assert.deepEqual([0, 1, 2, 3].map(startsOpen), [true, true, true, false]);
  assert.equal(shownRows([1, 2, 3, 4, 5, 6], false).length, 5);
  assert.equal(shownRows([1, 2, 3, 4, 5, 6], true).length, 6);
  assert.equal(shownRows([1, 2, 3, 4, 5], false).length, 5);
});
test('an item shows the date the reply holds, in UTC+8, and nothing when it holds none', () => {
  const since = '2026-11-19T16:00:00.000Z';
  assert.equal(itemDate(item('a', 'overdue', { since })), 'Due 20 Nov 2026');
  assert.equal(itemDate(item('a', 'risk_review', { since })), 'Review by 20 Nov 2026');
  assert.equal(itemDate(item('a', 'resources', { since })), 'Needed by 20 Nov 2026');
  assert.equal(itemDate(item('a', 'approval', { since })), 'Since 20 Nov 2026');
  assert.equal(itemDate(item('a', 'deadline_review')), '');
});
