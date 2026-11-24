/**
 * What the project Overview (spec 7.5) and the Work tab show at a glance, worked out from data the page already has:
 * the task-status split, the tasks due soon and this project's part of the Needs you queue.
 */
import type { NeedsYouItem } from './dashboard.ts';
import { TASK_STATUS_MEANING, type TaskStatus } from './records.ts';
import type { BarPart } from './ui/graphics.ts';

const BAR_ORDER: { status: TaskStatus; label: string }[] = [
  { status: 'completed', label: 'completed' },
  { status: 'in_progress', label: 'in progress' },
  { status: 'blocked', label: 'blocked' },
  { status: 'not_started', label: 'not started' },
];

/** The task-status split for the stacked bar. Cancelled tasks are left out, as they are from task completion. */
export function taskStatusParts(tasks: readonly { status: string }[]): BarPart[] {
  return BAR_ORDER.map(({ status, label }) => ({ meaning: TASK_STATUS_MEANING[status], label, count: tasks.filter((t) => t.status === status).length }));
}

/** A calendar day (YYYY-MM-DD) moved by a number of days. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Unfinished tasks due from `today` to `days` days ahead (both included), soonest first. Overdue ones are not "due". */
export function dueWithin<T extends { dueOn: string; status: string; title: string }>(tasks: readonly T[], today: string, days: number): T[] {
  const last = addDays(today, days);
  return tasks
    .filter((t) => t.status !== 'completed' && t.status !== 'cancelled' && t.dueOn >= today && t.dueOn <= last)
    .sort((a, b) => (a.dueOn === b.dueOn ? a.title.localeCompare(b.title) : a.dueOn < b.dueOn ? -1 : 1));
}

/** This project's part of the person's Needs you queue. */
export function projectAttention(items: readonly NeedsYouItem[], projectId: string): NeedsYouItem[] {
  return items.filter((i) => i.projectId === projectId);
}
