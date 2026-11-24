/**
 * What the project Overview (spec 7.5) and the Work tab show at a glance, worked out from data the page already has:
 * the stage flow, the task-status split, the tasks due soon and this project's part of the Needs you queue.
 */
import type { NeedsYouItem } from './dashboard.ts';
import { STAGES, type ProjectStatus } from './projects.ts';
import { TASK_STATUS_MEANING, type TaskStatus } from './records.ts';
import type { BarPart, Stage } from './ui/graphics.ts';

/**
 * The stages a project moves through, in order. Every project has the fixed five today; when projects get their own
 * stage templates (D131) this is the one place to change.
 */
export function projectStageNames(): readonly string[] {
  return STAGES;
}

/** Whole UTC+8 calendar days from an instant to now (0 on the day it happened). */
function daysSince(iso: string, now: Date): number {
  const day = (ms: number) => Math.floor((ms + 8 * 3_600_000) / 86_400_000);
  return Math.max(0, day(now.getTime()) - day(new Date(iso).getTime()));
}

/**
 * The stage flow's steps: stages before the current one done, the current one with its days, the rest to come. A
 * closed project has every stage done; a project with no stage yet has every stage to come. A current stage missing
 * from the list is added at its end, so the flow never hides where the project is.
 */
export function stageSteps(
  names: readonly string[],
  current: { stage: string; startedAt: string } | null,
  status: ProjectStatus,
  now: Date = new Date(),
): Stage[] {
  if (status === 'closed') return names.map((name) => ({ name, state: 'done' }));
  if (!current) return names.map((name) => ({ name, state: 'todo' }));
  const list = names.includes(current.stage) ? names : [...names, current.stage];
  const at = list.indexOf(current.stage);
  return list.map((name, i) =>
    i < at ? { name, state: 'done' } : i === at ? { name, state: 'current', days: daysSince(current.startedAt, now) } : { name, state: 'todo' },
  );
}

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
