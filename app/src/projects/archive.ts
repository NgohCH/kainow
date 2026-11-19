/**
 * Archiving (V1.0 Q04): only Closed projects; archived by hand, or automatically the set number of calendar months
 * after closing (twelve unless the Administrator changed it) unless unarchived since. Worked out on read. Events and the closing are exact instants
 * (ISO strings); the months count from the closing's UTC+8 day.
 */
import type { Pool, PoolClient } from 'pg';
import type { ProjectStatus } from './matrix';
import { loadAccessSettings } from '../organisation/access-settings';
import { todayUtc8 } from './membership';

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
  /** The archive delay in force (access settings). */
  afterMonths: number;
}): { archived: boolean; automatic: boolean } {
  if (input.status !== 'closed' || input.closedAt === null) return { archived: false, automatic: false };
  const closedAt = Date.parse(input.closedAt);
  const since = input.events
    .map((e) => ({ kind: e.kind, at: Date.parse(e.at) }))
    .filter((e) => e.at >= closedAt)
    .sort((a, b) => a.at - b.at);
  const latest = since[since.length - 1];
  if (latest?.kind === 'archived') return { archived: true, automatic: false };
  const due = addMonths(todayUtc8(new Date(closedAt)), input.afterMonths);
  const unarchivedAfterDue = latest?.kind === 'unarchived' && todayUtc8(new Date(latest.at)) >= due;
  if (input.today >= due && !unarchivedAfterDue) return { archived: true, automatic: true };
  return { archived: false, automatic: false };
}

/** Archived state, worked out from the latest closing and the archive history (V1.0 Q04). */
export async function loadArchiveState(db: Pool | PoolClient, projectId: string, status: ProjectStatus, today: string) {
  const closing = (
    await db.query(`SELECT at FROM project_transitions WHERE project_id = $1 AND to_status = 'closed' ORDER BY at DESC, id DESC LIMIT 1`, [projectId])
  ).rows[0];
  const events = (await db.query(`SELECT kind, at FROM project_archive_events WHERE project_id = $1 ORDER BY at, id`, [projectId])).rows;
  const { archiveAfterMonths } = await loadAccessSettings(db);
  const s = archiveState({
    status,
    closedAt: closing ? new Date(closing.at).toISOString() : null,
    events: events.map((e) => ({ kind: e.kind, at: new Date(e.at).toISOString() })),
    today,
    afterMonths: archiveAfterMonths,
  });
  return { archived: s.archived, archivedAutomatically: s.automatic };
}
