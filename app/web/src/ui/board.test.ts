import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NeedsYouItem } from '../dashboard.ts';
import type { TaskStatus } from '../records.ts';
import { type BoardTask, boardTasks, byAssignee, byStatus, inProjects, needsYouColumns, shownBoxes } from './board.ts';

const TODAY = '2026-11-26';
const ann = { id: 'ann', displayName: 'Ann Lee' };
const bob = { id: 'bob', displayName: 'Bob Tan' };

const t = (id: string, o: Partial<BoardTask> = {}): BoardTask => ({
  id, title: id, parentId: null, parentTitle: null, status: 'not_started', dueOn: '2026-12-01', overdue: false, dueSoon: false,
  completedOn: null, assignee: ann, projectId: 'p1', projectName: 'Alpha', ...o,
});
const done = (id: string, completedOn: string, o: Partial<BoardTask> = {}) => t(id, { status: 'completed', completedOn, ...o });
const ids = (c: { boxes: { task: { id: string } }[] }) => c.boxes.map((b) => b.task.id);

test('four status columns always, in order, with Completed folded', () => {
  const cols = byStatus(boardTasks([], TODAY).boxes);
  assert.deepEqual(cols.map((c) => [c.key, c.heading, c.folded, c.boxes.length]), [
    ['not_started', 'Not started', false, 0],
    ['in_progress', 'In progress', false, 0],
    ['blocked', 'Blocked', false, 0],
    ['completed', 'Completed', true, 0],
  ]);
  assert.deepEqual(cols.map((c) => c.meaning), ['draft', 'dueSoon', 'blocked', 'ok']);
});

test('overdue first then by due date; Completed newest first', () => {
  const tasks = [
    t('late', { dueOn: '2026-12-09' }), t('soon', { dueOn: '2026-11-30' }),
    t('over', { dueOn: '2026-12-20', overdue: true }), t('over2', { dueOn: '2026-11-01', overdue: true }),
    done('c1', '2026-11-01'), done('c3', '2026-11-20'), done('c2', '2026-11-10'),
  ];
  const cols = byStatus(boardTasks(tasks, TODAY).boxes);
  assert.deepEqual(ids(cols[0]), ['over2', 'over', 'soon', 'late']);
  assert.deepEqual(ids(cols[3]), ['c3', 'c2', 'c1']);
});

test('completed 30 days ago is on the board, 31 days is off it; cancelled is off', () => {
  const r = boardTasks([done('a', '2026-10-27'), done('b', '2026-10-26'), t('x', { status: 'cancelled' })], TODAY);
  assert.deepEqual(r.boxes.map((b) => b.task.id), ['a']);
  assert.deepEqual(r.offBoard.map((x) => x.id), ['b', 'x']);
});

test('a subtask sits inside its open parent, two levels deep, in the list order', () => {
  const tasks = [t('p'), t('s2', { parentId: 'p' }), t('s1', { parentId: 'p' }), t('g', { parentId: 's2' })];
  const { boxes } = boardTasks(tasks, TODAY);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0].subtasks.map((s) => [s.task.id, s.depth]), [['s2', 1], ['g', 2], ['s1', 1]]);
  assert.deepEqual(boxes[0].progress, { done: 0, total: 2 });
});

test('progress counts direct, non-cancelled subtasks; a supplied progress wins', () => {
  const tasks = [t('p'), done('a', '2026-11-20', { parentId: 'p' }), t('b', { parentId: 'p' }), t('c', { parentId: 'p', status: 'cancelled' }), t('d', { parentId: 'b' })];
  const { boxes, offBoard } = boardTasks(tasks, TODAY);
  assert.deepEqual(boxes[0].progress, { done: 1, total: 2 });
  assert.deepEqual(offBoard.map((x) => x.id), ['c']);
  assert.deepEqual(boardTasks([t('q', { progress: { done: 3, total: 7 } })], TODAY).boxes[0].progress, { done: 3, total: 7 });
});

test('an open subtask of a completed, cancelled or absent parent has its own box', () => {
  const tasks = [
    done('pc', '2026-11-20'), t('s1', { parentId: 'pc', parentTitle: 'Done parent' }),
    t('px', { status: 'cancelled' }), t('s2', { parentId: 'px', parentTitle: 'Cancelled parent' }),
    t('s3', { parentId: 'gone', parentTitle: 'Elsewhere' }),
  ];
  const { boxes, offBoard } = boardTasks(tasks, TODAY);
  assert.deepEqual(boxes.map((b) => b.task.id), ['pc', 's1', 's2', 's3']);
  assert.deepEqual(boxes.map((b) => b.task.parentTitle), [null, 'Done parent', 'Cancelled parent', 'Elsewhere']);
  assert.deepEqual(offBoard.map((x) => x.id), ['px']);
});

test('by assignee: columns by name; a subtask held by someone else is in their column and in the parent box', () => {
  const tasks = [t('p', { assignee: bob }), t('s', { parentId: 'p', assignee: ann }), t('s2', { parentId: 'p', assignee: bob }), t('own', { assignee: ann })];
  const cols = byAssignee(tasks, TODAY);
  assert.deepEqual(cols.map((c) => c.heading), ['Ann Lee', 'Bob Tan']);
  assert.deepEqual(ids(cols[0]).sort(), ['own', 's']);
  assert.deepEqual(ids(cols[1]), ['p']);
  assert.deepEqual(cols[1].boxes[0].subtasks.map((x) => x.task.id), ['s', 's2']);
  assert.ok(cols.every((c) => !c.folded));
});

test('by status, boxes + subtasks + offBoard are exactly the list, each once (500 tasks)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const statuses: TaskStatus[] = ['not_started', 'in_progress', 'blocked', 'completed', 'cancelled'];
  const tasks: BoardTask[] = [];
  for (let i = 0; i < 500; i++) {
    const status = statuses[Math.floor(rnd() * 5)];
    const day = `2026-${rnd() < 0.5 ? '09' : '11'}-${String(1 + Math.floor(rnd() * 27)).padStart(2, '0')}`;
    tasks.push(t(`t${i}`, { status, completedOn: status === 'completed' ? day : null, parentId: i > 0 && rnd() < 0.6 ? `t${Math.floor(rnd() * i)}` : null }));
  }
  const { boxes, offBoard } = boardTasks(tasks, TODAY);
  const seen = [...boxes.flatMap((b) => [b.task.id, ...b.subtasks.map((s) => s.task.id)]), ...offBoard.map((x) => x.id)];
  assert.equal(seen.length, 500);
  assert.deepEqual(new Set(seen), new Set(tasks.map((x) => x.id)));
  assert.equal(byStatus(boxes).reduce((n, c) => n + c.boxes.length, 0), boxes.length);
});

test('ten boxes, then Show more shows all', () => {
  const boxes = Array.from({ length: 25 }, (_, i) => i);
  assert.equal(shownBoxes(boxes, false).length, 10);
  assert.equal(shownBoxes(boxes, true).length, 25);
  assert.equal(shownBoxes([1, 2], false).length, 2);
});

test('in projects: most overdue, then most due soon, then name; same names kept apart; empty groups absent', () => {
  const tasks = [
    t('a', { projectId: 'pa', projectName: 'Alpha' }),
    t('b', { projectId: 'pb', projectName: 'Beta', overdue: true }),
    t('c', { projectId: 'pc', projectName: 'Gamma', dueSoon: true }),
    t('d', { projectId: 'pd', projectName: 'Alpha' }),
    t('e', { projectId: 'pb', projectName: 'Beta', overdue: true }),
  ];
  const groups = inProjects(boardTasks(tasks, TODAY).boxes);
  assert.deepEqual(groups.map((g) => [g.projectId, g.boxes.length]), [['pb', 2], ['pc', 1], ['pa', 1], ['pd', 1]]);
  assert.deepEqual(inProjects([]), []);
});

const item = (kind: NeedsYouItem['kind'], projectId: string, projectName = projectId): NeedsYouItem => ({ kind, projectId, projectName, label: kind, since: null, link: '#/x' });

test('needs you columns drop empty ones, keep same-named projects apart and count each item once', () => {
  const items = [
    item('overdue', 'p1', 'Same'), item('overdue', 'p2', 'Same'), item('overdue', 'p2', 'Same'),
    item('approval', 'p1', 'Same'), item('question', 'p1', 'Same'), item('due_soon', 'p3', 'Other'),
  ];
  const cols = needsYouColumns(items);
  assert.deepEqual(cols.map((c) => [c.group, c.heading, c.count]), [['overdue', 'Overdue', 3], ['review', 'Review and decisions', 2], ['dueSoon', 'Due soon', 1]]);
  assert.deepEqual(cols[0].projects.map((p) => [p.projectId, p.items.length]), [['p2', 2], ['p1', 1]]);
  assert.equal(cols.reduce((n, c) => n + c.projects.reduce((m, p) => m + p.items.length, 0), 0), items.length);
  assert.deepEqual(needsYouColumns([]), []);
});
