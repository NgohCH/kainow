/**
 * The ops part of the sweep (spec 6.1, 6.3, 7.1, D111, D115). Runs on every sweep tick. Every step is idempotent:
 * conditional updates and the episode index make two sweeps running together harmless.
 */
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { sendDueReminders } from '../updater/people-mail';
import { endMissedWindows } from '../updater/window-sweep';
import { closeEpisode, openEpisode } from './alerts';
import { OPS_FAILURES } from './common';
import { notifyAdmins } from './notify';
import { loadOpsSettings } from './settings';
import { INTERRUPTED_AFTER_MS, type RunRow, TARGET_MS, backupStatus } from './status';

const LINK = '#/admin/operations';
const MIN = 60_000;
const DAY_MS = 86_400_000;
const CHECK_MISSING_AFTER_MS = 30 * MIN;

/** Locations whose storage check is watched (the source area joins when it has its own check). */
const LOCATIONS = [
  { key: 'database_disk', label: 'the database disk' },
  { key: 'backup_disk', label: 'the backup disk' },
] as const;

const before = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

/** Runs fn in one transaction, serialised with other ops sweeps; an episode and its notice commit together or not at all. */
async function inTransaction(pool: Pool, fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.ops-sweep'))`);
      await fn(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    client.release(broken);
  }
}

async function markInterruptedRuns(pool: Pool, now: Date): Promise<void> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      const runs = await client.query(
        `UPDATE backup_runs SET outcome = 'failed', failure_code = 'interrupted', failure_detail = $2, finished_at = $3
          WHERE outcome = 'running' AND started_at < $1
          RETURNING id, kind`,
        [before(now, INTERRUPTED_AFTER_MS), OPS_FAILURES.interrupted, now],
      );
      for (const r of runs.rows) {
        await writeAudit(client, {
          at: now,
          action: 'ops.backup_interrupted',
          subjectType: 'backup_run',
          subjectId: r.id,
          detail: { kind: r.kind },
        });
        // The command that died could not tell anyone; this is the one notice for the run.
        await notifyAdmins(client, {
          kind: 'backup_failed',
          summary: `Backup failed. ${OPS_FAILURES.interrupted}`,
          link: LINK,
          now,
          urgent: true,
        });
      }
      const drills = await client.query(
        `UPDATE restore_drills SET outcome = 'failed', failure_code = 'interrupted', finished_at = $2
          WHERE outcome = 'running' AND started_at < $1
          RETURNING id`,
        [before(now, INTERRUPTED_AFTER_MS), now],
      );
      for (const d of drills.rows) {
        await writeAudit(client, {
          at: now,
          action: 'ops.restore_drill_interrupted',
          subjectType: 'restore_drill',
          subjectId: d.id,
        });
        // As for backups: the drill that died could not tell anyone, so this is the one notice for it.
        await notifyAdmins(client, {
          kind: 'restore_drill_failed',
          summary: `Restore drill failed. ${OPS_FAILURES.interrupted}`,
          link: LINK,
          now,
          urgent: true,
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    client.release(broken);
  }
}

async function loadRuns(pool: Pick<Pool, 'query'>): Promise<RunRow[]> {
  const { rows } = await pool.query(
    `(SELECT id, kind, started_at, finished_at, outcome, failure_code FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT 30)
     UNION
     (SELECT id, kind, started_at, finished_at, outcome, failure_code FROM backup_runs
       WHERE outcome = 'succeeded' ORDER BY finished_at DESC, id DESC LIMIT 1)`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    outcome: r.outcome,
    failureCode: r.failure_code,
  }));
}

async function checkBackupTarget(pool: Pool, now: Date): Promise<void> {
  await inTransaction(pool, async (c) => {
    const { status } = backupStatus(await loadRuns(c), now);
    // No backup ever counts as the target exceeded once the organisation was registered more than 24 hours ago.
    let exceeded = status === 'target_exceeded';
    if (status === 'none') {
      const reg = (await c.query('SELECT registered_at FROM organisation WHERE id = 1')).rows[0]?.registered_at as Date | null | undefined;
      exceeded = !!reg && now.getTime() - reg.getTime() > TARGET_MS;
    }
    if (exceeded) {
      if (await openEpisode(c, 'backup_target_exceeded', null, now)) {
        await notifyAdmins(c, {
          kind: 'backup_target_exceeded',
          summary: 'Backups: the 24-hour recovery target is exceeded. There is no successful backup from the last 24 hours.',
          link: LINK,
          now,
          urgent: true,
        });
      }
    } else if (status === 'healthy' || status === 'last_failed') {
      if (await closeEpisode(c, 'backup_target_exceeded', null, now)) {
        await notifyAdmins(c, {
          kind: 'backup_recovered',
          summary: 'Backups: a new backup succeeded. The 24-hour recovery target is met again.',
          link: LINK,
          now,
          urgent: true,
        });
      }
    }
  });
}

async function checkStorageReadings(pool: Pool, now: Date): Promise<void> {
  for (const loc of LOCATIONS) {
    await inTransaction(pool, async (c) => {
      const anyRun = ((await c.query('SELECT 1 FROM backup_runs LIMIT 1')).rowCount ?? 0) > 0;
      const newest = (await c.query('SELECT max(at) AS at FROM storage_readings WHERE location = $1', [loc.key])).rows[0]?.at as Date | null;
      if (newest && now.getTime() - newest.getTime() <= CHECK_MISSING_AFTER_MS) {
        await closeEpisode(c, 'storage_check_missing', loc.key, now);
        return;
      }
      // A fresh install with no cron job set yet stays quiet until a reading or a backup run shows ops has started.
      if (!newest && !anyRun) return;
      if (await openEpisode(c, 'storage_check_missing', loc.key, now)) {
        await notifyAdmins(c, {
          kind: 'storage_check_missing',
          summary: `The storage check for ${loc.label} has not run for over 30 minutes.`,
          link: LINK,
          now,
          urgent: true,
        });
      }
    });
  }
}

async function expireDiagnostics(pool: Pool, now: Date): Promise<void> {
  const { diagnosticRetentionDays } = await loadOpsSettings(pool);
  const cutoff = before(now, diagnosticRetentionDays * DAY_MS);
  await pool.query('DELETE FROM storage_readings WHERE at < $1', [cutoff]);
  // Release checks (10b): rows that first found a tag stay as the record of when it appeared.
  await pool.query(
    `DELETE FROM release_checks rc WHERE rc.at < $1 AND NOT EXISTS (
       SELECT 1 FROM releases_seen s WHERE rc.outcome = 'found' AND s.tag = rc.newest_tag AND s.first_seen_at = rc.at)`,
    [cutoff],
  );
  // Updater ticks: the newest one always stays, so the Operations page can say when the updater last ran.
  await pool.query(
    `DELETE FROM updater_ticks WHERE at < $1 AND id <> (SELECT id FROM updater_ticks ORDER BY at DESC, id DESC LIMIT 1)`,
    [cutoff],
  );
}

/** Runs every step even when one fails, then reports the first failure (the caller logs a fixed message). */
export async function runOpsSweep(pool: Pool, now: Date): Promise<void> {
  let failure: unknown;
  for (const step of [markInterruptedRuns, checkBackupTarget, checkStorageReadings, expireDiagnostics, endMissedWindows, sendDueReminders]) {
    try {
      await step(pool, now);
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== undefined) throw failure;
}
