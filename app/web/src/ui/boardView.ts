/** What the board components say in words (11a.2): pure, so the wording is tested without a browser. */
import { dayLabel } from '../dashboard.ts';
import { plural } from '../format.ts';
import { TASK_STATUS_LABEL, TASK_STATUS_MEANING } from '../records.ts';
import type { Meaning } from './meanings.ts';
import { type BoardTask, FIRST_BOXES } from './board.ts';

/** The name a screen reader gets for a box: the title first, then status, due day and overdue. */
export function boxName(t: BoardTask): string {
  const done = t.status === 'completed' && t.completedOn !== null ? `, completed ${dayLabel(t.completedOn)}` : '';
  return `${t.title}, ${TASK_STATUS_LABEL[t.status]}, due ${dayLabel(t.dueOn)}${done}${t.overdue ? ', overdue' : t.dueSoon ? ', due soon' : ''}`;
}

/** "2 of 5 subtasks done", or null when there are none. */
export function progressText(p: { done: number; total: number }): string | null {
  return p.total === 0 ? null : `${p.done} of ${plural(p.total, 'subtask')} done`;
}

/** What a subtask is a subtask of, or null. The assignee is always shown beside it. */
export const parentText = (t: BoardTask): string | null => (t.parentTitle !== null ? `Subtask of ${t.parentTitle}` : null);

/** "Blocked: <reason>", or null when it is not blocked or gave no reason. */
export const blockedText = (status: BoardTask['status'], reason: string | null | undefined): string | null =>
  status === 'blocked' && reason ? `Blocked: ${reason}` : null;

/** The choices of the "Column" select on a narrow screen: each column's name and count. */
export const columnChoices = (columns: readonly { key: string; heading: string; boxes: readonly unknown[] }[]): { key: string; label: string }[] =>
  columns.map((c) => ({ key: c.key, label: `${c.heading} (${c.boxes.length})` }));

/** The column a narrow screen starts on: the first with boxes, else the first. */
export const startColumn = (columns: readonly { key: string; boxes: readonly unknown[] }[]): string | null =>
  (columns.find((c) => c.boxes.length > 0) ?? columns[0])?.key ?? null;

/** The "Show more" button's words, or null when every box already shows. */
export const moreText = (total: number, all: boolean): string | null =>
  total <= FIRST_BOXES ? null : all ? 'Show fewer' : `Show more (${total - FIRST_BOXES} more)`;

/** The flags a task's row shows, beside its status. Optional fields are absent on screens that do not have them. */
export type LabelFields = {
  status: BoardTask['status'];
  overdue: boolean;
  dueSoon?: boolean;
  awaitingMembership?: boolean;
  invitation?: string | null;
  dueAfterParent?: boolean;
  changeWaiting?: boolean;
  deadlineReviewRequired?: boolean;
  parentCancelled?: boolean;
};

/** A task's labels, each a meaning (symbol and colour) with its word: its status first, then each flag that holds. */
export function taskLabelList(t: LabelFields): { meaning: Meaning; word: string }[] {
  const out: { meaning: Meaning; word: string }[] = [{ meaning: TASK_STATUS_MEANING[t.status], word: TASK_STATUS_LABEL[t.status] }];
  if (t.overdue) out.push({ meaning: 'overdue', word: 'Overdue' });
  if (t.dueSoon) out.push({ meaning: 'dueSoon', word: 'Due soon' });
  if (t.awaitingMembership) out.push({ meaning: 'review', word: `Awaiting Membership${t.invitation ? ` (invitation ${t.invitation})` : ''}` });
  if (t.dueAfterParent) out.push({ meaning: 'review', word: 'Due after its parent task' });
  if (t.changeWaiting) out.push({ meaning: 'review', word: 'Change waiting' });
  if (t.deadlineReviewRequired) out.push({ meaning: 'overdue', word: 'Deadline review required' });
  if (t.parentCancelled) out.push({ meaning: 'review', word: 'Parent cancelled' });
  return out;
}

/**
 * What one subtask line inside its parent's box says: everything its row in the list shows (its labels, the held label,
 * its due day and its blocked reason), and where its title leads (its panel on the Work tab).
 */
export function subtaskLine(s: BoardTask & LabelFields & { quarantineLabel?: string | null; blockedReason?: string | null }): {
  href: string; labels: { meaning: Meaning; word: string }[]; due: string; blocked: string | null;
} {
  const labels = taskLabelList(s);
  if (s.quarantineLabel) labels.push({ meaning: 'review', word: s.quarantineLabel });
  return { href: `#/projects/${s.projectId}/work/${s.id}`, labels, due: `Due ${dayLabel(s.dueOn)}`, blocked: blockedText(s.status, s.blockedReason) };
}
