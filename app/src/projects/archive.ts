/**
 * Archiving (V1.0 Q04): only Closed projects; archived by hand, or automatically twelve calendar months
 * after closing unless unarchived since. Worked out on read. Events and the closing are exact instants
 * (ISO strings); the twelve months count from the closing's UTC+8 day.
 */
import type { ProjectStatus } from './matrix';
import { todayUtc8 } from './membership';

export const ARCHIVE_AFTER_MONTHS = 12;

/** The same day `months` later, clamped to the last day of a shorter month. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export function archiveState(input: {
  status: ProjectStatus;
  closedAt: string | null;
  events: Array<{ kind: 'archived' | 'unarchived'; at: string }>;
  today: string;
}): { archived: boolean; automatic: boolean } {
  if (input.status !== 'closed' || input.closedAt === null) return { archived: false, automatic: false };
  const closedAt = Date.parse(input.closedAt);
  const since = input.events
    .map((e) => ({ kind: e.kind, at: Date.parse(e.at) }))
    .filter((e) => e.at >= closedAt)
    .sort((a, b) => a.at - b.at);
  const latest = since[since.length - 1];
  if (latest?.kind === 'archived') return { archived: true, automatic: false };
  const due = addMonths(todayUtc8(new Date(closedAt)), ARCHIVE_AFTER_MONTHS);
  const unarchivedAfterDue = latest?.kind === 'unarchived' && todayUtc8(new Date(latest.at)) >= due;
  if (input.today >= due && !unarchivedAfterDue) return { archived: true, automatic: true };
  return { archived: false, automatic: false };
}
