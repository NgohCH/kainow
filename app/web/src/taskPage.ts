/** The task page (11a.1, D133): its address, what each status means, and its history in plain words. The server decides who may read and act. */
import { formatDay } from './due.ts';
import { formatWhen } from './format.ts';
import type { TaskHistoryEntry, TaskStatus } from './records.ts';

export const taskHref = (projectId: string, taskId: string): string => `#/projects/${projectId}/tasks/${taskId}`;

export const NO_DESCRIPTION = 'No description';

/**
 * The description in a proposed change to a task. `current` is the one in force (undefined while it is not known),
 * `proposed` the one a request being revised proposes (null: its removal; undefined: it proposes none), `typed` what the
 * person has written (null until then). A proposed description is shown and sent even when the one in force is unknown.
 */
export function amendDescription(d: { current: string | null | undefined; proposed: string | null | undefined; typed: string | null }): { known: boolean; value: string; send: string | undefined } {
  if (d.current === undefined && d.proposed === undefined) return { known: false, value: '', send: undefined };
  const value = d.typed ?? (d.proposed !== undefined ? d.proposed : d.current) ?? '';
  const unchanged = d.current !== undefined && value.trim() === (d.current ?? '');
  return { known: true, value, send: unchanged ? undefined : value };
}

/** The description in force, in words, beside a proposed one. */
export function descriptionNow(current: string | null | undefined, failed: boolean): string {
  if (current === undefined) return failed ? 'Could not be read' : 'Reading the description';
  return current || NO_DESCRIPTION;
}

const MEANS: Record<TaskStatus, string> = {
  not_started: 'Not started: nobody has begun the work yet.',
  in_progress: 'In progress: the work is under way.',
  blocked: 'Blocked: the work cannot continue. The due date has not moved.',
  completed: 'Completed: the work is finished.',
  cancelled: 'Cancelled: the work will not be done.',
};
/** One sentence on what a task's status means. */
export const statusMeaning = (status: TaskStatus): string => MEANS[status];

/** Why a task is blocked, who blocked it and when. */
export function blockedLine(b: { reason: string | null; by: string; at: string }): string {
  const who = `Blocked by ${b.by}, ${formatWhen(b.at)}.`;
  if (!b.reason) return who;
  return `Reason: ${b.reason}${/[.!?]$/.test(b.reason) ? '' : '.'} ${who}`;
}

export type ProposalRef = { kind: 'run'; runId: string; itemId: string } | { kind: 'human'; proposalId: string };
/** Where a record's proposal is shown: its item on the run's page, or the person's proposal on the Proposals tab. */
export const proposalHref = (projectId: string, p: ProposalRef): string => (p.kind === 'run' ? `#/runs/${p.runId}/${p.itemId}` : `#/projects/${projectId}/proposals/${p.proposalId}`);

const CHANGED: Record<string, string> = { title: 'Wording', description: 'Description', assigneeId: 'Assignee', dueOn: 'Due date' };

/** The previous and new values a history entry carries, in words. `names` is user id to display name. */
export function historyChanges(detail: TaskHistoryEntry['detail'], names: Record<string, string>): Array<{ label: string; from: string; to: string }> {
  const word = (key: string, v: unknown): string => {
    if (typeof v !== 'string' || v === '') return key === 'description' ? NO_DESCRIPTION : 'None';
    if (key === 'assigneeId') return names[v] ?? 'Another person';
    return key === 'dueOn' ? formatDay(v) : v;
  };
  return Object.entries(CHANGED).flatMap(([key, label]) => {
    const d = detail?.[key];
    if (!d || typeof d !== 'object') return [];
    const { from, to } = d as { from?: unknown; to?: unknown };
    return [{ label, from: word(key, from), to: word(key, to) }];
  });
}
