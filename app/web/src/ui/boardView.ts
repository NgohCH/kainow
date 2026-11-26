/** What the board components say in words (11a.2): pure, so the wording is tested without a browser. */
import { dayLabel } from '../dashboard.ts';
import { plural } from '../format.ts';
import { TASK_STATUS_LABEL } from '../records.ts';
import { type BoardColumn, type BoardTask, FIRST_BOXES } from './board.ts';

/** The name a screen reader gets for a box: the title first, then status, due day and overdue. */
export function boxName(t: BoardTask): string {
  const done = t.status === 'completed' && t.completedOn !== null ? `, completed ${dayLabel(t.completedOn)}` : '';
  return `${t.title}, ${TASK_STATUS_LABEL[t.status]}, due ${dayLabel(t.dueOn)}${done}${t.overdue ? ', overdue' : t.dueSoon ? ', due soon' : ''}`;
}

/** "2 of 5 subtasks done", or null when there are none. */
export function progressText(p: { done: number; total: number }): string | null {
  return p.total === 0 ? null : `${p.done} of ${plural(p.total, 'subtask')} done`;
}

/** Who holds the task, or what it is a subtask of. */
export const holderText = (t: BoardTask): string => (t.parentTitle !== null ? `Subtask of ${t.parentTitle}` : t.assignee.displayName);

/** "Blocked: <reason>", or null when it is not blocked or gave no reason. */
export const blockedText = (status: BoardTask['status'], reason: string | null | undefined): string | null =>
  status === 'blocked' && reason ? `Blocked: ${reason}` : null;

/** The choices of the "Column" select on a narrow screen: each column's name and count. */
export const columnChoices = (columns: readonly BoardColumn<BoardTask>[]): { key: string; label: string }[] =>
  columns.map((c) => ({ key: c.key, label: `${c.heading} (${c.boxes.length})` }));

/** The column a narrow screen starts on: the first with boxes, else the first. */
export const startColumn = (columns: readonly { key: string; boxes: readonly unknown[] }[]): string | null =>
  (columns.find((c) => c.boxes.length > 0) ?? columns[0])?.key ?? null;

/** The "Show more" button's words, or null when every box already shows. */
export const moreText = (total: number, all: boolean): string | null =>
  total <= FIRST_BOXES ? null : all ? 'Show fewer' : `Show more (${total - FIRST_BOXES} more)`;
