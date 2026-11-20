/**
 * The storage check (spec 7.1-7.3, D113, D114): one reading per disk, a daily summary, warning and critical episodes
 * with one notice each, and protective read-only mode when the database disk falls below the safe floor.
 * Each location is one transaction under the ops advisory lock (shared with the sweep): the reading, its episodes, its
 * notices and any protective entry commit together or not at all. This command never turns protective mode off.
 * One GB is 1024^3 bytes everywhere here (the safe floor of 5 GB is 5 * 1024^3 bytes).
 */
import { statfsSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { closeEpisode, openEpisode } from './alerts';
import type { OpsConfig } from './config';
import { type StorageLevel, levelFor } from './levels';
import { notifyAdmins } from './notify';
import { loadOpsSettings } from './settings';

type Db = Pick<Pool | PoolClient, 'query'>;
export type StatFs = (path: string) => { total: number; free: number } | null;

export interface StorageCheckDeps {
  pool: Pool;
  config: OpsConfig;
  statfs?: StatFs;
  now(): Date;
  /** Source-area reading (Task 15). Undefined: no source_area row is written. */
  sourceArea?: () => Promise<{ used: number; quota: number | null } | null>;
  out?(line: string): void;
  err?(line: string): void;
}

const LINK = '#/admin/operations';
const GB = 1024 ** 3;
const UTC8_MS = 8 * 3_600_000;
const TEXT = {
  usage: 'Usage: npm run storage-check',
  failed: 'The storage check could not finish for one location.',
  protective: 'Kainow is read-only for now to protect your data. Nothing you have saved is affected.',
};

const LOCATIONS = [
  { key: 'database_disk', label: 'the database disk' },
  { key: 'backup_disk', label: 'the backup disk' },
] as const;

export const defaultStatfs: StatFs = (path) => {
  try {
    const s = statfsSync(path);
    return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
  } catch {
    return null;
  }
};

/** The UTC+8 calendar day of an instant, as YYYY-MM-DD. */
const utc8Day = (at: Date): string => new Date(at.getTime() + UTC8_MS).toISOString().slice(0, 10);

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

/**
 * Turns protective mode on if it is not already. True only when this call turned it on. Pass the caller's transaction
 * client so the state, its history row, the audit event and the notice commit together.
 */
export async function enterProtective(
  db: PoolClient,
  reason: 'low_space' | 'restored_from_backup',
  detail: Record<string, unknown>,
  now: Date,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE operations_state SET protective = true, reason = $1, since = $2, detail = $3, changed_by = NULL WHERE protective = false`,
    [reason, now, JSON.stringify(detail)],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await db.query(`INSERT INTO operations_state_changes (id, at, action, actor_id, reason, detail) VALUES ($1, $2, 'entered', NULL, $3, $4)`, [
    uuidv7(now.getTime()),
    now,
    reason,
    JSON.stringify(detail),
  ]);
  await writeAudit(db, { at: now, action: 'ops.protective_entered', subjectType: 'operations_state', detail: { reason, ...detail } });
  await notifyAdmins(db, {
    kind: 'protective_mode_entered',
    summary: reason === 'low_space' ? `${TEXT.protective} The database disk is running out of space.` : TEXT.protective,
    link: LINK,
    now,
    urgent: true,
  });
  return true;
}

/** Incremental: the recorded sizes of the succeeded sets, never a walk of the tree. */
async function backupFolderBytes(db: Db): Promise<number> {
  const { rows } = await db.query(
    `SELECT coalesce(sum(coalesce(database_bytes, 0) + coalesce(files_new_bytes, 0)), 0)::text AS n FROM backup_runs WHERE outcome = 'succeeded' AND expired_at IS NULL`,
  );
  return Number(rows[0].n);
}

async function recordLevels(
  c: PoolClient,
  location: string,
  label: string,
  level: StorageLevel,
  usedPct: number | null,
  now: Date,
): Promise<void> {
  const changed = (from: string, to: string): Promise<void> =>
    writeAudit(c, { at: now, action: 'ops.storage_level_changed', detail: { location, from, to, usedPct } });
  const pct = usedPct === null ? '' : ` (${usedPct.toFixed(1)}% used)`;
  if (level === 'unknown') return; // an unmeasurable reading changes no episode
  if (level === 'normal') {
    const w = await closeEpisode(c, 'storage_warning', location, now);
    const k = await closeEpisode(c, 'storage_critical', location, now);
    if (w || k) await changed(k ? 'critical' : 'warning', 'normal');
    return;
  }
  if (level === 'warning') {
    const k = await closeEpisode(c, 'storage_critical', location, now); // back below critical, silently
    if (await openEpisode(c, 'storage_warning', location, now)) {
      await changed('normal', 'warning');
      await notifyAdmins(c, {
        kind: 'storage_warning',
        summary: `Storage warning: ${label} is getting full${pct}.`,
        link: LINK,
        now,
        urgent: true,
      });
    } else if (k) await changed('critical', 'warning');
    return;
  }
  // Critical: warning stays open until the disk is below the warning level.
  const openedWarning = await openEpisode(c, 'storage_warning', location, now); // silent: the critical notice covers it
  if (await openEpisode(c, 'storage_critical', location, now)) {
    await changed(openedWarning ? 'normal' : 'warning', 'critical');
    await notifyAdmins(c, {
      kind: 'storage_critical',
      summary: `Storage critical: ${label} is almost full${pct}.`,
      link: LINK,
      now,
      urgent: true,
    });
  }
}

async function checkLocation(pool: Pool, loc: (typeof LOCATIONS)[number], stat: { total: number; free: number } | null, now: Date): Promise<void> {
  await inTransaction(pool, async (c) => {
    const settings = await loadOpsSettings(c);
    const total = stat && stat.total > 0 ? stat.total : null;
    const free = stat && total !== null ? stat.free : null;
    const used = total !== null && free !== null ? total - free : null;
    const usedPct = total !== null && used !== null ? (used / total) * 100 : null;
    const extra: Record<string, unknown> = {};
    if (loc.key === 'database_disk') {
      extra.databaseBytes = Number((await c.query('SELECT pg_database_size(current_database())::text AS n')).rows[0].n);
    } else {
      extra.kainowBytes = await backupFolderBytes(c);
    }
    await c.query(
      `INSERT INTO storage_readings (id, at, location, total_bytes, free_bytes, used_bytes, extra, unavailable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(now.getTime()), now, loc.key, total, free, used, JSON.stringify(extra), total === null],
    );
    if (total !== null && used !== null && free !== null) {
      await c.query(
        `INSERT INTO storage_daily (day, location, max_used_bytes, min_free_bytes, total_bytes) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (day, location) DO UPDATE SET
           max_used_bytes = greatest(storage_daily.max_used_bytes, EXCLUDED.max_used_bytes),
           min_free_bytes = least(storage_daily.min_free_bytes, EXCLUDED.min_free_bytes),
           total_bytes = EXCLUDED.total_bytes`,
        [utc8Day(now), loc.key, used, free, total],
      );
    }
    // The sweep opened this when checks stopped; a new reading ends it, silently.
    await closeEpisode(c, 'storage_check_missing', loc.key, now);
    await recordLevels(c, loc.key, loc.label, levelFor(usedPct, settings), usedPct, now);
    const floor = settings.safeFloorGb * GB;
    if (loc.key === 'database_disk' && free !== null && Number.isFinite(free) && free >= 0 && free < floor) {
      await enterProtective(c, 'low_space', { location: loc.key, freeBytes: free, totalBytes: total, floorBytes: floor }, now);
    }
  });
}

/** Exit 0 all locations recorded, 1 a location failed (fixed text, never the cause), 2 usage. */
export async function runStorageCheck(argv: string[], deps: StorageCheckDeps): Promise<number> {
  const err = deps.err ?? ((l: string) => console.error(l));
  if (argv.length > 0) {
    err(TEXT.usage);
    return 2;
  }
  const statfs = deps.statfs ?? defaultStatfs;
  const now = deps.now();
  let code = 0;
  for (const loc of LOCATIONS) {
    const path = loc.key === 'database_disk' ? deps.config.dbDataDir : deps.config.backupDir;
    let stat: { total: number; free: number } | null = null;
    try {
      stat = statfs(path);
    } catch {
      stat = null;
    }
    try {
      await checkLocation(deps.pool, loc, stat, now);
    } catch {
      err(TEXT.failed);
      code = 1;
    }
  }
  return code;
}
