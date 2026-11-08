/**
 * Archiving (V1.0 Q04): only Closed projects; archived by hand, or automatically twelve calendar months
 * after closing unless unarchived since. Worked out on read; days are 'YYYY-MM-DD' in UTC+8.
 */
import type { ProjectStatus } from './matrix';

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
  closedOn: string | null;
  events: Array<{ kind: 'archived' | 'unarchived'; at: string }>;
  today: string;
}): { archived: boolean; automatic: boolean } {
  if (input.status !== 'closed' || input.closedOn === null) return { archived: false, automatic: false };
  const closedOn = input.closedOn;
  const since = input.events.filter((e) => e.at >= closedOn).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const latest = since[since.length - 1];
  const due = addMonths(closedOn, ARCHIVE_AFTER_MONTHS);
  if (latest?.kind === 'archived') return { archived: true, automatic: false };
  if (latest?.kind === 'unarchived' && latest.at >= due) return { archived: false, automatic: false };
  if (input.today >= due && !(latest?.kind === 'unarchived' && latest.at >= due)) return { archived: true, automatic: true };
  return { archived: false, automatic: false };
}
