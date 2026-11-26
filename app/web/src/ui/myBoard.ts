/** My tasks and Needs you as boards (11a.2 spec 5 and 6): what the dashboard sends, made into boxes and columns. Pure. */
import type { NeedsYouItem } from '../dashboard.ts';
import type { TaskStatus } from '../records.ts';
import type { BoxTask } from './BoardBoxes.tsx';
import { type BoardColumn, boardTasks, byStatus, needsYouColumns } from './board.ts';
import type { TaskRow } from './home.ts';
import type { Meaning } from './meanings.ts';

/** The status and project filters of My tasks; they apply to every view. An empty choice means all. */
export const filterTasks = (rows: TaskRow[], status: string, project: string): TaskRow[] =>
  rows.filter((t) => (!status || t.status === status) && (!project || t.projectId === project));

/**
 * The person's tasks as board tasks. Every one is its own box, a subtask included, naming its parent (none when the
 * parent is hidden from the person). Subtask progress is the server's count, as the parent's subtasks are not in the list.
 */
export function myBoxTasks(rows: readonly TaskRow[], me: { id: string; name: string }): BoxTask[] {
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    parentId: null,
    parentTitle: t.parent?.title ?? null,
    status: t.status as TaskStatus,
    dueOn: t.dueOn,
    overdue: t.group === 'overdue',
    dueSoon: t.group === 'dueSoon',
    deadlineReviewRequired: t.group === 'awaitingReview',
    completedOn: t.completedOn,
    blockedReason: t.blockedReason,
    assignee: { id: me.id, displayName: me.name },
    projectId: t.projectId,
    projectName: t.projectName,
    progress: t.subtasks,
  }));
}

/** The four status columns of the person's tasks. */
export function myBoardColumns(rows: readonly TaskRow[], me: { id: string; name: string }, today: string): { columns: BoardColumn<BoxTask>[] } {
  return { columns: byStatus(boardTasks(myBoxTasks(rows, me), today).boxes) };
}

export type NeedsYouBoardColumn = { key: string; heading: string; meaning: Meaning; items: NeedsYouItem[] };

/** Home's Needs you as board columns: the non-empty ones, each with its items project by project, most urgent project first. */
export const needsYouBoardColumns = (items: NeedsYouItem[]): NeedsYouBoardColumn[] =>
  needsYouColumns(items).map((c) => ({ key: c.group, heading: c.heading, meaning: c.meaning, items: c.projects.flatMap((p) => p.items) }));

/** A column's shown items under their projects, in the order the projects first appear. */
export function needsYouProjectGroups(items: readonly NeedsYouItem[]): { id: string; name: string; items: NeedsYouItem[] }[] {
  const groups = new Map<string, { id: string; name: string; items: NeedsYouItem[] }>();
  for (const i of items) {
    const g = groups.get(i.projectId) ?? { id: i.projectId, name: i.projectName, items: [] };
    g.items.push(i);
    groups.set(i.projectId, g);
  }
  return [...groups.values()];
}
