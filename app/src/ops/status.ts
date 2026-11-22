/** Backup status (spec 6.1, D111): computed on every read from the run rows. */
import type { Pool } from 'pg';

const H = 3_600_000;
export const TARGET_MS = 24 * H;
/** A run still `running` after this long counts as failed (interrupted). */
export const INTERRUPTED_AFTER_MS = 6 * H;

export interface RunRow {
  id: string;
  kind: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: 'running' | 'succeeded' | 'failed';
  failureCode: string | null;
}

export type BackupStatus = 'healthy' | 'last_failed' | 'target_exceeded' | 'none';

const t = (d: Date): number => d.getTime();

/** When the run ended, as far as the status is concerned (a started-at stands in for a run that never finished). */
const endedAt = (r: RunRow): Date => r.finishedAt ?? r.startedAt;

/** The run as the status sees it: a `running` row older than 6 hours is a failed (interrupted) run. */
function effective(r: RunRow, now: Date): RunRow {
  if (r.outcome === 'running' && t(now) - t(r.startedAt) > INTERRUPTED_AFTER_MS) {
    return { ...r, outcome: 'failed', failureCode: 'interrupted' };
  }
  return r;
}

/** Newest first by end time, then start time, then id (stable). */
const newestFirst = (a: RunRow, b: RunRow): number =>
  t(endedAt(b)) - t(endedAt(a)) || t(b.startedAt) - t(a.startedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function backupStatus(
  runs: RunRow[],
  now: Date,
): { status: BackupStatus; lastSuccess?: RunRow; lastAttempt?: RunRow } {
  const all = runs.map((r) => effective(r, now));
  const lastAttempt = [...all].sort(
    (a, b) => t(b.startedAt) - t(a.startedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )[0];
  const lastSuccess = all.filter((r) => r.outcome === 'succeeded').sort(newestFirst)[0];
  if (!lastSuccess) return { status: 'none', lastAttempt };
  if (t(now) - t(endedAt(lastSuccess)) > TARGET_MS) return { status: 'target_exceeded', lastSuccess, lastAttempt };
  const finished = all.filter((r) => r.outcome !== 'running').sort(newestFirst)[0];
  return { status: finished.outcome === 'failed' ? 'last_failed' : 'healthy', lastSuccess, lastAttempt };
}

/** `ok` only when a successful run finished within the last 24 hours (for 10b and the update gate). */
export async function freshBackup(
  pool: Pick<Pool, 'query'>,
  now: Date,
): Promise<{ ok: boolean; runId?: string; finishedAt?: Date }> {
  const { rows } = await pool.query(
    `SELECT id, finished_at FROM backup_runs
      WHERE outcome = 'succeeded' AND finished_at >= $1
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [new Date(t(now) - TARGET_MS)],
  );
  const r = rows[0];
  return r ? { ok: true, runId: r.id as string, finishedAt: r.finished_at as Date } : { ok: false };
}
