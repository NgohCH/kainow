import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardTask } from './board.ts';
import { blockedText, boxName, columnChoices, parentText, moreText, progressText, startColumn, subtaskLine, taskLabelList } from './boardView.ts';

const task = (o: Partial<BoardTask> = {}): BoardTask => ({
  id: 't1', title: 'Write plan', parentId: null, parentTitle: null, status: 'in_progress', dueOn: '2026-12-04', overdue: false, dueSoon: false,
  completedOn: null, assignee: { id: 'p1', displayName: 'Ann Lee' }, projectId: 'pr', projectName: 'Example', ...o,
});

test('a box is named by its title first, then status and due day', () => {
  assert.equal(boxName(task()), 'Write plan, In progress, due 4 Dec 2026');
  assert.ok(boxName(task({ overdue: true })).endsWith(', overdue'));
  assert.ok(boxName(task({ dueSoon: true })).endsWith(', due soon'));
  assert.match(boxName(task({ status: 'completed', completedOn: '2026-11-20' })), /^Write plan, Completed, due 4 Dec 2026, completed 20 Nov 2026/);
});

test('progress, holder and blocked wording', () => {
  assert.equal(progressText({ done: 2, total: 5 }), '2 of 5 subtasks done');
  assert.equal(progressText({ done: 0, total: 1 }), '0 of 1 subtask done');
  assert.equal(progressText({ done: 0, total: 0 }), null);
  assert.equal(parentText(task()), null);
  assert.equal(parentText(task({ parentTitle: 'Plan' })), 'Subtask of Plan');
  assert.equal(blockedText('blocked', 'Waiting on legal'), 'Blocked: Waiting on legal');
  assert.equal(blockedText('blocked', null), null);
  assert.equal(blockedText('in_progress', 'x'), null);
});

test('the Column select lists names with counts and starts at the first column with boxes', () => {
  const box = { task: task(), subtasks: [], progress: { done: 0, total: 0 } };
  const cols = [
    { key: 'a', heading: 'Not started', boxes: [], folded: false },
    { key: 'b', heading: 'In progress', boxes: [box, box], folded: false },
  ];
  assert.deepEqual(columnChoices(cols), [{ key: 'a', label: 'Not started (0)' }, { key: 'b', label: 'In progress (2)' }]);
  assert.equal(startColumn(cols), 'b');
  assert.equal(startColumn([cols[0]]), 'a');
  assert.equal(startColumn([]), null);
});

test('Show more appears past ten boxes and offers fewer once open', () => {
  assert.equal(moreText(10, false), null);
  assert.equal(moreText(14, false), 'Show more (4 more)');
  assert.equal(moreText(14, true), 'Show fewer');
});

test('a subtask inside its parent box shows what its list row shows: an overdue one', () => {
  const s = task({ id: 's1', parentId: 't1', title: 'Order cables', status: 'not_started', dueOn: '2026-11-20', overdue: true });
  const line = subtaskLine({ ...s, changeWaiting: true, deadlineReviewRequired: false });
  assert.deepEqual(line.labels.map((l) => l.word), ['Not started', 'Overdue', 'Change waiting']);
  assert.equal(line.labels[1].meaning, 'overdue', 'Overdue keeps its symbol and colour');
  assert.equal(line.due, 'Due 20 Nov 2026');
  assert.equal(line.blocked, null);
  // Its title opens it on the Work tab, as a box does.
  assert.equal(line.href, '#/projects/pr/work/s1');
});

test('a blocked subtask inside its parent box shows its reason, and a held one its label and no reason', () => {
  const s = task({ id: 's2', parentId: 't1', title: 'Fit shelves', status: 'blocked', dueSoon: true });
  const line = subtaskLine({ ...s, blockedReason: 'The shelves have not arrived' });
  assert.deepEqual(line.labels.map((l) => l.word), ['Blocked', 'Due soon']);
  assert.equal(line.blocked, 'Blocked: The shelves have not arrived');
  // Held for a credential review: the server sends no reason, and the line shows the held label.
  const held = subtaskLine({ ...s, blockedReason: null, quarantineLabel: 'Credential removed — under review' });
  assert.deepEqual(held.labels.map((l) => l.word), ['Blocked', 'Due soon', 'Credential removed — under review']);
  assert.equal(held.blocked, null);
});

test('task labels: the status first, then each flag that holds, in the list row order', () => {
  const all = taskLabelList({
    status: 'in_progress', overdue: true, dueSoon: true, awaitingMembership: true, invitation: 'sent', dueAfterParent: true,
    changeWaiting: true, deadlineReviewRequired: true, parentCancelled: true,
  });
  assert.deepEqual(all.map((l) => l.word), [
    'In progress', 'Overdue', 'Due soon', 'Awaiting Membership (invitation sent)', 'Due after its parent task', 'Change waiting', 'Deadline review required', 'Parent cancelled',
  ]);
  assert.deepEqual(taskLabelList({ status: 'completed', overdue: false }).map((l) => l.word), ['Completed']);
});
