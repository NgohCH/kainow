/**
 * Task boards (11a.2 spec 4 to 6): which tasks are boxes, which columns they stand in, in what order, and what is folded.
 * Pure; the screens only draw it. "today" and every day here is a YYYY-MM-DD string in UTC+8.
 */
import type { NeedsYouItem } from '../dashboard.ts';
import { TASK_STATUS_MEANING, type TaskStatus } from '../records.ts';
import { type AttentionGroup, groupAttention } from './attention.ts';
import { attentionByProject, byUrgency, type ProjectBox } from './byProject.ts';
import type { Meaning } from './meanings.ts';

export type BoardTask = {
  id: string;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  status: TaskStatus;
  dueOn: string;
  overdue: boolean;
  dueSoon: boolean;
  completedOn: string | null;
  assignee: { id: string; displayName: string };
  projectId: string;
  projectName: string;
  /** Subtask progress the caller already knows (the server's count); it replaces the one worked out from the list. */
  progress?: { done: number; total: number };
};

export type BoardBox<T extends BoardTask = BoardTask> = { task: T; subtasks: { task: T; depth: number }[]; progress: { done: number; total: number } };
export type BoardColumn<T extends BoardTask = BoardTask> = { key: string; heading: string; meaning?: Meaning; boxes: BoardBox<T>[]; folded: boolean };

/** Completed tasks stay on the board this many days. */
export const COMPLETED_DAYS = 30;
/** Boxes a column shows before "Show more". */
export const FIRST_BOXES = 10;

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

const isOpen = (t: BoardTask): boolean => t.status !== 'completed' && t.status !== 'cancelled';

/** A task that is a box: not cancelled, and not completed longer ago than 30 days. A completed task with no day is kept. */
function onBoard(t: BoardTask, today: string): boolean {
  if (t.status === 'cancelled') return false;
  if (t.status !== 'completed' || t.completedOn === null) return true;
  return dayNumber(today) - dayNumber(t.completedOn) <= COMPLETED_DAYS;
}

type Tree<T extends BoardTask> = { byId: Map<string, T>; children: Map<string, T[]> };

function treeOf<T extends BoardTask>(tasks: readonly T[]): Tree<T> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map<string, T[]>();
  for (const t of tasks) {
    if (t.parentId !== null && byId.has(t.parentId)) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  }
  return { byId, children };
}

/** A subtask is inside its parent's box when the parent is in the list and still open; cancelled ones are never inside. */
function nestsUnder<T extends BoardTask>(t: T, tree: Tree<T>): boolean {
  if (t.status === 'cancelled' || t.parentId === null) return false;
  const parent = tree.byId.get(t.parentId);
  return parent !== undefined && isOpen(parent);
}

/** The live descendants of a task, depth first in list order; depth 1 is a direct subtask. */
function descendants<T extends BoardTask>(root: T, tree: Tree<T>): { task: T; depth: number }[] {
  const out: { task: T; depth: number }[] = [];
  const seen = new Set([root.id]);
  const walk = (parent: T, depth: number) => {
    for (const child of tree.children.get(parent.id) ?? []) {
      if (seen.has(child.id) || !nestsUnder(child, tree)) continue;
      seen.add(child.id);
      out.push({ task: child, depth });
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/** The caller's progress when it gave one, else the direct subtasks in the list that are not cancelled. */
function progressOf<T extends BoardTask>(task: T, tree: Tree<T>): { done: number; total: number } {
  if (task.progress) return task.progress;
  const live = (tree.children.get(task.id) ?? []).filter((c) => c.status !== 'cancelled');
  return { done: live.filter((c) => c.status === 'completed').length, total: live.length };
}

const boxOf = <T extends BoardTask>(task: T, tree: Tree<T>): BoardBox<T> => ({ task, subtasks: descendants(task, tree), progress: progressOf(task, tree) });

/**
 * The boxes of a list of tasks and what stays off the board. A task is a box unless it is a live subtask of an open
 * parent (then it is inside that parent's box, to any depth). Cancelled and long-completed tasks are `offBoard`; they
 * are in the list view. Every task is in exactly one of a box, a box's subtasks, or `offBoard`.
 */
export function boardTasks<T extends BoardTask>(tasks: readonly T[], today: string): { boxes: BoardBox<T>[]; offBoard: T[] } {
  const tree = treeOf(tasks);
  const boxes: BoardBox<T>[] = [];
  const offBoard: T[] = [];
  for (const t of tasks) {
    if (nestsUnder(t, tree)) continue;
    if (onBoard(t, today)) boxes.push(boxOf(t, tree));
    else offBoard.push(t);
  }
  return { boxes, offBoard };
}

const cmp = (a: string, b: string) => a.localeCompare(b);

/** Overdue first, then by due day; ties by title then id so the order never shifts. */
const openOrder = <T extends BoardTask>(a: BoardBox<T>, b: BoardBox<T>): number =>
  Number(b.task.overdue) - Number(a.task.overdue) || cmp(a.task.dueOn, b.task.dueOn) || cmp(a.task.title, b.task.title) || cmp(a.task.id, b.task.id);

/** Newest completed first; a missing day last. */
const completedOrder = <T extends BoardTask>(a: BoardBox<T>, b: BoardBox<T>): number =>
  cmp(b.task.completedOn ?? '', a.task.completedOn ?? '') || cmp(a.task.id, b.task.id);

/** Open boxes in due order, then completed ones, newest first. */
const order = <T extends BoardTask>(a: BoardBox<T>, b: BoardBox<T>): number => {
  const ca = a.task.status === 'completed';
  const cb = b.task.status === 'completed';
  return ca !== cb ? Number(ca) - Number(cb) : ca ? completedOrder(a, b) : openOrder(a, b);
};

const STATUS_COLUMNS: { status: Exclude<TaskStatus, 'cancelled'>; heading: string }[] = [
  { status: 'not_started', heading: 'Not started' },
  { status: 'in_progress', heading: 'In progress' },
  { status: 'blocked', heading: 'Blocked' },
  { status: 'completed', heading: 'Completed' },
];

/** The four status columns, always, in order. Completed starts folded. */
export function byStatus<T extends BoardTask>(boxes: readonly BoardBox<T>[]): BoardColumn<T>[] {
  return STATUS_COLUMNS.map(({ status, heading }) => ({
    key: status,
    heading,
    meaning: TASK_STATUS_MEANING[status],
    boxes: boxes.filter((b) => b.task.status === status).sort(order),
    folded: status === 'completed',
  }));
}

/**
 * One column per person who holds a box, by name. A subtask held by someone other than its parent's holder is also a
 * box in that person's column, and stays inside the parent's box too.
 */
export function byAssignee<T extends BoardTask>(tasks: readonly T[], today: string): BoardColumn<T>[] {
  const tree = treeOf(tasks);
  const { boxes } = boardTasks(tasks, today);
  const placed: BoardBox<T>[] = [...boxes];
  for (const { subtasks } of boxes) {
    for (const { task } of subtasks) {
      const parent = task.parentId === null ? undefined : tree.byId.get(task.parentId);
      if (parent && parent.assignee.id !== task.assignee.id && onBoard(task, today)) placed.push(boxOf(task, tree));
    }
  }
  const people = new Map<string, { name: string; boxes: BoardBox<T>[] }>();
  for (const box of placed) {
    const who = people.get(box.task.assignee.id) ?? { name: box.task.assignee.displayName, boxes: [] };
    who.boxes.push(box);
    people.set(box.task.assignee.id, who);
  }
  return [...people.entries()]
    .sort(([ia, a], [ib, b]) => cmp(a.name, b.name) || cmp(ia, ib))
    .map(([id, who]) => ({ key: id, heading: who.name, boxes: who.boxes.sort(order), folded: false }));
}

type ProjectGroup<T extends BoardTask> = { projectId: string; projectName: string; boxes: BoardBox<T>[] };

/**
 * The boxes of each project, in the order they came; projects most urgent first (11a.1's order: most overdue, then most
 * needing review, then most due soon, then by name), kept apart by id. A task has no review state of its own, so only
 * the overdue and due-soon counts differ here.
 */
export function inProjects<T extends BoardTask>(boxes: readonly BoardBox<T>[]): ProjectGroup<T>[] {
  const groups = new Map<string, ProjectGroup<T>>();
  for (const box of boxes) {
    const g = groups.get(box.task.projectId) ?? { projectId: box.task.projectId, projectName: box.task.projectName, boxes: [] };
    g.boxes.push(box);
    groups.set(box.task.projectId, g);
  }
  const urgency = (g: ProjectGroup<T>): ProjectBox => ({
    projectId: g.projectId,
    projectName: g.projectName,
    counts: [
      { group: 'overdue', count: g.boxes.filter((b) => isOpen(b.task) && b.task.overdue).length },
      { group: 'dueSoon', count: g.boxes.filter((b) => isOpen(b.task) && b.task.dueSoon).length },
    ],
  });
  return [...groups.values()].sort((a, b) => byUrgency(urgency(a), urgency(b)));
}

/** The first ten boxes, or all of them after "Show more". */
export const shownBoxes = <T>(boxes: readonly T[], all: boolean): readonly T[] => (all ? boxes : boxes.slice(0, FIRST_BOXES));

export type NeedsYouColumn = {
  group: AttentionGroup;
  heading: string;
  meaning: Meaning;
  count: number;
  projects: { projectId: string; projectName: string; items: NeedsYouItem[] }[];
};

/** Needs you as columns (Overdue, Review and decisions, Blocked, Due soon); empty ones are left out. Projects stand most urgent first, each with its items in order. */
export function needsYouColumns(items: NeedsYouItem[]): NeedsYouColumn[] {
  const rank = new Map(attentionByProject(items).map((p, i) => [p.projectId, i]));
  return groupAttention(items).map((bucket) => {
    const projects = new Map<string, { projectId: string; projectName: string; items: NeedsYouItem[] }>();
    for (const item of bucket.items) {
      const p = projects.get(item.projectId) ?? { projectId: item.projectId, projectName: item.projectName, items: [] };
      p.items.push(item);
      projects.set(item.projectId, p);
    }
    return {
      group: bucket.group,
      heading: bucket.heading,
      meaning: bucket.meaning,
      count: bucket.items.length,
      projects: [...projects.values()].sort((a, b) => (rank.get(a.projectId) ?? 0) - (rank.get(b.projectId) ?? 0)),
    };
  });
}
