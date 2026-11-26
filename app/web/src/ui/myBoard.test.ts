import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MyTask, NeedsYouItem } from '../dashboard.ts';
import { viewsOf } from '../prefs.ts';
import { boardTasks, byStatus } from './board.ts';
import { tasksByProject } from './byProject.ts';
import { type TaskRow, taskRows } from './home.ts';
import { filterTasks, myBoardColumns, myBoxTasks, needsYouBoardColumns, needsYouProjectGroups } from './myBoard.ts';

const ME = { id: 'me', name: 'Mei Tan' };
const TODAY = '2026-11-26';
const mine = (id: string, o: Partial<MyTask> = {}): MyTask => ({
  id, title: `Task ${id}`, projectId: 'p1', projectName: 'Alpha', dueOn: '2026-12-01', status: 'in_progress',
  completedOn: null, blockedReason: null, parent: null, subtasks: { done: 0, total: 0 }, ...o,
});
const list = (): TaskRow[] =>
  taskRows({
    overdue: [mine('a', { dueOn: '2026-11-20', status: 'not_started', overdueDays: 6 }), mine('b', { projectId: 'p2', projectName: 'Beta', dueOn: '2026-11-22', status: 'blocked', blockedReason: 'Waiting on legal' })],
    dueSoon: [mine('c', { dueOn: '2026-11-27', parent: { id: 'a', title: 'Task a' } })],
    later: [mine('d', { projectId: 'p2', projectName: 'Beta', dueOn: '2026-12-30', subtasks: { done: 1, total: 3 } })],
    awaitingReview: [],
    completed: [mine('e', { status: 'completed', completedOn: '2026-11-25', dueOn: '2026-11-25' })],
  });

const idsOf = (xs: { id: string }[]) => xs.map((x) => x.id).sort().join(' ');
const inBoard = (rows: TaskRow[]) => idsOf(boardTasks(myBoxTasks(rows, ME), TODAY).boxes.map((b) => b.task));
const inProject = (rows: TaskRow[]) => idsOf(tasksByProject(rows).flatMap((p) => p.rows));
const inDue = (rows: TaskRow[]) => idsOf(rows);

test('Board, By project and Due date hold the same tasks for every filter', () => {
  const all = list();
  for (const [status, project] of [['', ''], ['blocked', ''], ['', 'p2'], ['in_progress', 'p1'], ['completed', 'p2']] as const) {
    const rows = filterTasks(all, status, project);
    assert.equal(inBoard(rows), inDue(rows), `${status}/${project}`);
    assert.equal(inProject(rows), inDue(rows), `${status}/${project}`);
  }
  assert.equal(inDue(list()), 'a b c d e');
});

test('a status filter leaves the other columns at 0, and the four columns stay', () => {
  const cols = byStatus(boardTasks(myBoxTasks(filterTasks(list(), 'blocked', ''), ME), TODAY).boxes);
  assert.deepEqual(cols.map((c) => [c.key, c.boxes.length]), [['not_started', 0], ['in_progress', 0], ['blocked', 1], ['completed', 0]]);
});

test('a subtask assigned to the person has its own box naming its parent; a hidden parent shows no name', () => {
  const { columns } = myBoardColumns(list(), ME, TODAY);
  const boxes = columns.flatMap((c) => c.boxes);
  assert.equal(boxes.length, 5);
  assert.equal(boxes.find((b) => b.task.id === 'c')?.task.parentTitle, 'Task a');
  const hidden = myBoxTasks([{ ...list()[0], parent: null }], ME);
  assert.equal(hidden[0].parentTitle, null);
});

test('a box carries the server counts, the reason, the urgency and the person', () => {
  const t = myBoxTasks(list(), ME);
  const d = t.find((x) => x.id === 'd')!;
  assert.deepEqual(d.progress, { done: 1, total: 3 });
  assert.equal(t.find((x) => x.id === 'b')!.blockedReason, 'Waiting on legal');
  assert.equal(t.find((x) => x.id === 'a')!.overdue, true);
  assert.equal(t.find((x) => x.id === 'c')!.dueSoon, true);
  assert.deepEqual(d.assignee, { id: 'me', displayName: 'Mei Tan' });
  assert.equal(d.parentId, null);
});

const need = (kind: NeedsYouItem['kind'], projectId: string, label = kind): NeedsYouItem => ({ kind, projectId, projectName: projectId.toUpperCase(), label, since: null, link: `#/${projectId}/${label}` });

test('Needs you as a board and by project hold the same items; empty columns are left out', () => {
  const items = [need('due_soon', 'x'), need('overdue', 'y'), need('overdue', 'x'), need('approval', 'y'), need('question', 'y')];
  const cols = needsYouBoardColumns(items);
  assert.deepEqual(cols.map((c) => c.heading), ['Overdue', 'Review and decisions', 'Due soon']);
  const board = cols.flatMap((c) => c.items).map((i) => i.link).sort();
  assert.deepEqual(board, items.map((i) => i.link).sort());
  assert.deepEqual(needsYouBoardColumns([]), []);
});

test('inside a column, items stand under their project, most urgent project first', () => {
  const cols = needsYouBoardColumns([need('overdue', 'x'), need('overdue', 'y'), need('overdue', 'y', 'second')]);
  const groups = needsYouProjectGroups(cols[0].items);
  assert.deepEqual(groups.map((g) => [g.id, g.items.length]), [['y', 2], ['x', 1]]);
});

test('a board choice saved earlier opens that view; none saved opens the board', () => {
  assert.equal(viewsOf({ views: { myTasks: 'due', needsYou: 'project' } }).myTasks, 'due');
  assert.equal(viewsOf({ views: { myTasks: 'due', needsYou: 'project' } }).needsYou, 'project');
  assert.equal(viewsOf({}).myTasks, 'board');
  assert.equal(viewsOf({}).needsYou, 'board');
});
