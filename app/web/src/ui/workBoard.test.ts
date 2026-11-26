import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BoardTask, boardTasks, byAssignee, byStatus } from './board.ts';
import { boxFor, focusAfterClose, offBoardText, panelTarget, withProject } from './workBoard.ts';

const TODAY = '2026-11-26';
const ann = { id: 'ann', displayName: 'Ann Lee' };
const bob = { id: 'bob', displayName: 'Bob Tan' };

const t = (id: string, o: Partial<BoardTask> = {}): BoardTask => ({
  id, title: id, parentId: null, parentTitle: null, status: 'not_started', dueOn: '2026-12-01', overdue: false, dueSoon: false,
  completedOn: null, assignee: ann, projectId: 'p1', projectName: 'Alpha', ...o,
});

const tasks = [
  t('open'),
  t('sub', { parentId: 'open', parentTitle: 'open', assignee: bob }),
  t('gone', { status: 'cancelled' }),
  t('old', { status: 'completed', completedOn: '2026-09-01' }),
  t('recent', { status: 'completed', completedOn: '2026-11-20' }),
];
const records = {
  tasks,
  decisions: [{ id: 'd1' }],
  questions: [{ id: 'q1' }],
  risks: [{ id: 'r1' }],
};
const boxes = boardTasks(tasks, TODAY).boxes;

test('a task with a box on the board opens in the panel', () => {
  assert.equal(panelTarget('open', records, boxes), 'panel');
  assert.equal(panelTarget('recent', records, boxes), 'panel');
});

test('a subtask shown inside its parent box is on the board too', () => {
  assert.equal(panelTarget('sub', records, boxes), 'panel');
});

test('a task off the board, a decision, a question or a risk goes to its row', () => {
  assert.equal(panelTarget('gone', records, boxes), 'list');
  assert.equal(panelTarget('old', records, boxes), 'list');
  assert.equal(panelTarget('d1', records, boxes), 'list');
  assert.equal(panelTarget('q1', records, boxes), 'list');
  assert.equal(panelTarget('r1', records, boxes), 'list');
});

test('an unknown id or none at all targets nothing', () => {
  assert.equal(panelTarget('nope', records, boxes), 'none');
  assert.equal(panelTarget(undefined, records, boxes), 'none');
});

test('the board drawn decides: by assignee, the boxes of every column count', () => {
  const drawn = byAssignee(tasks, TODAY).flatMap((c) => c.boxes);
  assert.equal(panelTarget('sub', records, drawn), 'panel');
  assert.equal(panelTarget('old', records, drawn), 'list');
});

test('boxFor names the box showing a task: its own first, else the box it sits inside', () => {
  const byStat = byStatus(boxes).flatMap((c) => c.boxes);
  assert.equal(boxFor('open', byStat), 'open');
  assert.equal(boxFor('sub', byStat), 'open');
  assert.equal(boxFor('gone', byStat), null);
  // By assignee Bob's subtask also has a box of its own.
  assert.equal(boxFor('sub', byAssignee(tasks, TODAY).flatMap((c) => c.boxes)), 'sub');
});

test('closing the panel puts focus on the box, or on its column heading when the box is gone', () => {
  assert.equal(focusAfterClose(true), 'box');
  assert.equal(focusAfterClose(false), 'column');
});

test('the line under the board names how many tasks are only in the list view', () => {
  assert.equal(offBoardText(0), null);
  assert.equal(offBoardText(1), '1 cancelled or completed earlier is in the list view');
  assert.equal(offBoardText(3), '3 cancelled or completed earlier are in the list view');
});

test('withProject gives each task its project and its parent title, null when the parent is not in the list', () => {
  const rows = [
    { id: 'a', title: 'Plan', parentId: null },
    { id: 'b', title: 'Book', parentId: 'a' },
    { id: 'c', title: 'Hidden parent', parentId: 'x' },
  ];
  assert.deepEqual(
    withProject(rows, 'p9', 'Example').map((r) => [r.id, r.parentTitle, r.projectId, r.projectName]),
    [['a', null, 'p9', 'Example'], ['b', 'Plan', 'p9', 'Example'], ['c', null, 'p9', 'Example']],
  );
});
