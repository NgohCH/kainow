/**
 * The Operations page's data (spec 10, D116): backups, restore drills, storage, protective mode and health, all read
 * from the tables the ops commands fill. Read-only. Nothing here carries a host or container path, key material or a
 * connection string: the backup folder is shown by its label only (and not at all when the label is the container path),
 * keys by id only, failures by their fixed text.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type Clock } from '../auth/tokens';
import { runningVersion } from '../common/version';
import { PG_POOL } from '../db/database.module';
import { BOSS_SCHEMA } from '../worker/queues';
import { OPS_FAILURES, codeMigrationLevel, currentMigrationLevel } from './common';
import { DRILL_AGAIN_TEXT, drillAgainReason } from './drill-again';
import { type StorageLevel, levelFor } from './levels';
import { PROTECTIVE_BANNER, UPDATE_BANNER } from './protective';
import { type OpsSettings, loadOpsSettings } from './settings';
import { type BackupStatus, INTERRUPTED_AFTER_MS, type RunRow, backupStatus } from './status';
import { latestCheck, newestAvailable } from '../updater/release-check';
import { OPEN_STATES, type UpdateState } from '../updater/states';

const UTC8_MS = 8 * 3_600_000;
/** No reading for this long makes a location's level Unknown (spec 7.2). */
export const READING_MAX_AGE_MS = 30 * 60_000;
export const STORAGE_LOCATIONS = ['database_disk', 'backup_disk', 'source_area'] as const;
export type StorageLocation = (typeof STORAGE_LOCATIONS)[number];
export const OPERATIONS_LINK = '#/admin/operations';

export interface BackupRunView {
  id: string;
  kind: 'daily' | 'manual' | 'pre_update';
  startedAt: Date;
  finishedAt: Date | null;
  /** A run still running after 6 hours shows as failed (interrupted). */
  outcome: 'running' | 'succeeded' | 'failed';
  failureCode: string | null;
  /** The fixed text for the failure code, never raw error output. */
  failureText: string | null;
  durationSeconds: number | null;
  /** The size of the ENCRYPTED database dump in the set (not the live database's size). */
  databaseEncryptedBytes: number | null;
  filesTotal: number | null;
  filesNew: number | null;
  filesNewBytes: number | null;
  filesNotCopied: number | null;
  sourceArea: 'included' | 'not_in_use' | null;
  keyId: string | null;
  /** The set has been removed by expiry. */
  expired: boolean;
}

export interface DrillCheck {
  name: string;
  result: string;
  detail?: string;
}

export interface DrillView {
  id: string;
  setName: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: 'running' | 'passed' | 'passed_over_target' | 'failed';
  durationSeconds: number | null;
  sampled: boolean;
  /** Every check with its result; when `failureCode` is null on a failed drill, the failed ones are here. */
  checks: DrillCheck[];
  failureCode: string | null;
  failureText: string | null;
  keyId: string | null;
  folderLabel: string | null;
}

export interface StorageRow {
  location: StorageLocation;
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  usedPct: number | null;
  level: StorageLevel;
  /** Time of the latest reading, null when there is none. */
  at: Date | null;
  unavailable: boolean;
}

export interface OperationsView {
  backups: {
    status: BackupStatus;
    lastSuccess: BackupRunView | null;
    lastAttempt: BackupRunView | null;
    retentionDays: number;
    /** The label only; null when none is known or it would be the container path. */
    folderLabel: string | null;
    keyId: string | null;
    drillAgain: string | null;
    /** The last 30 runs, started_at DESC, id DESC. */
    runs: BackupRunView[];
  };
  drills: {
    last: DrillView | null;
    /** The ten before it, newest first. */
    earlier: DrillView[];
    /** Drill databases kept with --keep and not yet dropped (names only). */
    kept: { name: string; drillId: string }[];
    /** `kainow_drill_*` databases on the server that no kept drill row names (a killed drill leaves one). */
    stray: string[];
  };
  storage: { locations: StorageRow[]; safeFloorGb: number };
  /** storage_daily for the last 30 days, day ASC, location ASC. */
  growth: GrowthRow[];
  protective: {
    on: boolean;
    reason: 'low_space' | 'restored_from_backup' | 'update' | null;
    /** When the mode started (after a restore: the restore time). */
    since: Date | null;
    /** After a restore only: the time of the backup set that was restored, and its name. Otherwise null. */
    setTime: string | null;
    setName: string | null;
    text: string;
  };
  health: {
    database: 'up';
    migrationsCurrent: boolean;
    lastSweepAt: Date | null;
    queues: { name: string; queued: number; active: number; failed24h: number }[];
  };
  /** The status strip's Updates item (10b spec 11); the web words it. */
  updates: UpdatesSummary;
}

/** What the status strip needs to say Up to date / Update available / scheduled / failed / Not checked for 3 days. */
export interface UpdatesSummary {
  /** The latest update's state (newest approval first), null when there has been none. */
  latestState: UpdateState | null;
  latestToVersion: string | null;
  /** The latest update's start time while it is open (approved, preparing, ready or installing). */
  startsAt: Date | null;
  /** The newest release tag newer than the running version that any check found. */
  available: string | null;
  lastCheckAt: Date | null;
  /** Three days without a successful release check. */
  stale: boolean;
}

export interface GrowthRow {
  day: string;
  location: StorageLocation;
  maxUsedBytes: number | null;
  minFreeBytes: number | null;
  totalBytes: number | null;
}

export type BannerView = { protective: boolean; reason?: 'update'; text?: string; admin?: { backups: BackupStatus; storage: StorageLevel; text: string; link: string } };

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const SEVERITY: Record<StorageLevel, number> = { normal: 0, unknown: 1, warning: 2, critical: 3 };

/** Fixed month names, as the email and digest dates: a locale's own short month can read "Sept". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '21 Nov 02:04' in UTC+8. */
export function shortTime(at: Date): string {
  const d = new Date(at.getTime() + UTC8_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.toISOString().slice(11, 16)}`;
}

/** Row to the view type; a `running` row older than 6 hours is shown as failed (interrupted). */
function toRun(r: Record<string, unknown>, now: Date): BackupRunView {
  const startedAt = r.started_at as Date;
  const finishedAt = (r.finished_at as Date | null) ?? null;
  const interrupted = r.outcome === 'running' && now.getTime() - startedAt.getTime() > INTERRUPTED_AFTER_MS;
  const failureCode = interrupted ? 'interrupted' : ((r.failure_code as string | null) ?? null);
  return {
    id: r.id as string,
    kind: r.kind as BackupRunView['kind'],
    startedAt,
    finishedAt,
    outcome: interrupted ? 'failed' : (r.outcome as BackupRunView['outcome']),
    failureCode,
    failureText: failureCode ? ((OPS_FAILURES as Record<string, string>)[failureCode] ?? null) : null,
    durationSeconds: finishedAt ? Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)) : null,
    databaseEncryptedBytes: num(r.database_bytes),
    filesTotal: num(r.files_total),
    filesNew: num(r.files_new),
    filesNewBytes: num(r.files_new_bytes),
    filesNotCopied: num(r.files_not_copied),
    sourceArea: (r.source_area as BackupRunView['sourceArea']) ?? null,
    keyId: (r.key_id as string | null) ?? null,
    expired: r.expired_at !== null && r.expired_at !== undefined,
  };
}

function toDrill(r: Record<string, unknown>): DrillView {
  const code = (r.failure_code as string | null) ?? null;
  return {
    id: r.id as string,
    setName: (r.set_name as string | null) ?? null,
    startedAt: r.started_at as Date,
    finishedAt: (r.finished_at as Date | null) ?? null,
    outcome: r.outcome as DrillView['outcome'],
    durationSeconds: num(r.duration_seconds),
    sampled: r.sampled as boolean,
    checks: Array.isArray(r.checks) ? (r.checks as DrillCheck[]) : [],
    failureCode: code,
    failureText: code ? ((OPS_FAILURES as Record<string, string>)[code] ?? null) : null,
    keyId: (r.key_id as string | null) ?? null,
    folderLabel: safeFolderLabel((r.folder_label as string | null) ?? null),
  };
}

/** The container path is never shown; a folder label that is (or sits under) it counts as no label. */
export function safeFolderLabel(label: string | null): string | null {
  if (!label) return null;
  return label === '/backups' || label.startsWith('/backups/') ? null : label;
}

const RUN_COLUMNS = `id, kind, started_at, finished_at, outcome, failure_code, database_bytes, files_total, files_new, files_new_bytes,
  files_not_copied, source_area, key_id, folder_label, expired_at`;

@Injectable()
export class OperationsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async view(): Promise<OperationsView> {
    const now = this.clock();
    const settings = await loadOpsSettings(this.pool);
    const [backups, drills, storage, growth, protective, health, updates] = await Promise.all([
      this.backups(now, settings),
      this.drills(),
      this.storage(now, settings),
      this.growth(now),
      this.protective(),
      this.health(now),
      this.updates(now),
    ]);
    return { backups, drills, storage, growth, protective, health, updates };
  }

  /** The Updates item of the status strip: the latest update, the newest release available and the last check. */
  async updates(now: Date = this.clock()): Promise<UpdatesSummary> {
    const [latest, available, check] = await Promise.all([
      this.pool.query(`SELECT state, to_version, starts_at FROM updates ORDER BY approved_at DESC, id DESC LIMIT 1`),
      newestAvailable(this.pool, runningVersion()),
      latestCheck(this.pool, now),
    ]);
    const u = latest.rows[0] as { state: UpdateState; to_version: string; starts_at: Date } | undefined;
    return {
      latestState: u?.state ?? null,
      latestToVersion: u?.to_version ?? null,
      startsAt: u && OPEN_STATES.includes(u.state) ? u.starts_at : null,
      available: available?.tag ?? null,
      lastCheckAt: check.latest?.at ?? null,
      stale: check.stale,
    };
  }

  /** Backup status and the last success/attempt, without the run tables (for the banner and the analytics panel). */
  async backupSummary(now: Date = this.clock()): Promise<{ status: BackupStatus; lastSuccess: BackupRunView | null; lastAttempt: BackupRunView | null }> {
    const { status, lastSuccess, lastAttempt, views } = await this.statusOf(now);
    return { status, lastSuccess: lastSuccess ? (views.get(lastSuccess.id) ?? null) : null, lastAttempt: lastAttempt ? (views.get(lastAttempt.id) ?? null) : null };
  }

  private async statusOf(now: Date) {
    // The latest 30 runs plus the latest success, so an old success still counts when 30 newer runs failed.
    const { rows } = await this.pool.query(
      `SELECT ${RUN_COLUMNS} FROM (
         (SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT 30)
         UNION
         (SELECT * FROM backup_runs WHERE outcome = 'succeeded' ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1)
       ) r ORDER BY started_at DESC, id DESC`,
    );
    const views = new Map<string, BackupRunView>(rows.map((r) => [r.id as string, toRun(r, now)]));
    const input: RunRow[] = [...views.values()].map((v) => ({ id: v.id, kind: v.kind, startedAt: v.startedAt, finishedAt: v.finishedAt, outcome: v.outcome, failureCode: v.failureCode }));
    return { ...backupStatus(input, now), views, rows: rows as Record<string, unknown>[] };
  }

  private async backups(now: Date, settings: OpsSettings): Promise<OperationsView['backups']> {
    const { status, lastSuccess, lastAttempt, views, rows } = await this.statusOf(now);
    const runs = [...views.values()].slice(0, 30);
    const labelled = rows.find((r) => r.folder_label) as { folder_label: string } | undefined;
    const keyed = rows.find((r) => r.key_id) as { key_id: string } | undefined;
    const again = await drillAgainReason(this.pool);
    return {
      status,
      lastSuccess: lastSuccess ? (views.get(lastSuccess.id) ?? null) : null,
      lastAttempt: lastAttempt ? (views.get(lastAttempt.id) ?? null) : null,
      retentionDays: settings.backupRetentionDays,
      folderLabel: safeFolderLabel(labelled?.folder_label ?? null),
      keyId: keyed?.key_id ?? null,
      drillAgain: again ? DRILL_AGAIN_TEXT[again] : null,
      runs,
    };
  }

  private async drills(): Promise<OperationsView['drills']> {
    const { rows } = await this.pool.query(
      `SELECT id, set_name, started_at, finished_at, outcome, duration_seconds, sampled, checks, failure_code, key_id, folder_label
         FROM restore_drills ORDER BY started_at DESC, id DESC LIMIT 11`,
    );
    const all = rows.map(toDrill);
    const kept = (
      await this.pool.query(`SELECT id, kept_database FROM restore_drills WHERE kept_database IS NOT NULL ORDER BY started_at DESC, id DESC`)
    ).rows.map((r) => ({ name: r.kept_database as string, drillId: r.id as string }));
    // Read-only look at the server's database list; names only. A killed drill leaves one of these behind.
    const onServer = (await this.pool.query(`SELECT datname FROM pg_database WHERE datname LIKE 'kainow\\_drill\\_%' ORDER BY datname`)).rows.map((r) => r.datname as string);
    const keptNames = new Set(kept.map((k) => k.name));
    // A drill still running owns its database (kainow_drill_ plus the last 12 characters of its id): not stray.
    const running = (await this.pool.query(`SELECT id FROM restore_drills WHERE outcome = 'running'`)).rows;
    for (const r of running) keptNames.add(`kainow_drill_${(r.id as string).replace(/-/g, '').slice(-12)}`);
    return { last: all[0] ?? null, earlier: all.slice(1, 11), kept, stray: onServer.filter((n) => !keptNames.has(n)) };
  }

  private async storage(now: Date, settings: OpsSettings): Promise<OperationsView['storage']> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (location) location, at, total_bytes, free_bytes, used_bytes, unavailable
         FROM storage_readings ORDER BY location, at DESC, id DESC`,
    );
    const by = new Map(rows.map((r) => [r.location as StorageLocation, r]));
    const locations: StorageRow[] = [];
    for (const location of STORAGE_LOCATIONS) {
      const r = by.get(location);
      if (!r && location === 'source_area') continue; // only once sub-project 9 records it
      if (!r) {
        locations.push({ location, totalBytes: null, freeBytes: null, usedBytes: null, usedPct: null, level: 'unknown', at: null, unavailable: false });
        continue;
      }
      const total = num(r.total_bytes);
      const used = num(r.used_bytes);
      const usedPct = total !== null && total > 0 && used !== null ? (used / total) * 100 : null;
      const stale = now.getTime() - (r.at as Date).getTime() > READING_MAX_AGE_MS;
      locations.push({
        location,
        totalBytes: total,
        freeBytes: num(r.free_bytes),
        usedBytes: used,
        usedPct,
        level: stale ? 'unknown' : levelFor(usedPct, settings),
        at: r.at as Date,
        unavailable: r.unavailable as boolean,
      });
    }
    return { locations, safeFloorGb: settings.safeFloorGb };
  }

  /** storage_daily from `from` to `to` (days, UTC+8); with neither, the last 30 days. */
  async growth(now: Date, range?: { from: string; to: string }): Promise<GrowthRow[]> {
    const today = new Date(now.getTime() + UTC8_MS).toISOString().slice(0, 10);
    const from = range?.from ?? new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    const to = range?.to ?? today;
    const { rows } = await this.pool.query(
      `SELECT day::text AS day, location, max_used_bytes, min_free_bytes, total_bytes FROM storage_daily
        WHERE day >= $1::date AND day <= $2::date ORDER BY day, location`,
      [from, to],
    );
    return rows.map((r) => ({
      day: r.day as string,
      location: r.location as StorageLocation,
      maxUsedBytes: num(r.max_used_bytes),
      minFreeBytes: num(r.min_free_bytes),
      totalBytes: num(r.total_bytes),
    }));
  }

  private async protective(): Promise<OperationsView['protective']> {
    const r = (await this.pool.query(`SELECT protective, reason, since, detail FROM operations_state WHERE id`)).rows[0];
    const restored = r?.protective === true && r?.reason === 'restored_from_backup' && r.detail && typeof r.detail === 'object';
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      on: r?.protective === true,
      reason: r?.reason ?? null,
      since: r?.since ?? null,
      setTime: restored ? str(r.detail.setTime) : null,
      setName: restored ? str(r.detail.setName) : null,
      text: r?.protective === true && r?.reason === 'update' ? UPDATE_BANNER : PROTECTIVE_BANNER,
    };
  }

  private async health(now: Date): Promise<OperationsView['health']> {
    await this.pool.query('SELECT 1');
    const migrationsCurrent = (await currentMigrationLevel(this.pool)) === codeMigrationLevel();
    const lastSweepAt = ((await this.pool.query(`SELECT max(started_at) AS at FROM sweep_runs`)).rows[0]?.at as Date | null) ?? null;
    const has = (await this.pool.query(`SELECT to_regclass('${BOSS_SCHEMA}.job') IS NOT NULL AS ok`)).rows[0].ok as boolean;
    let queues: OperationsView['health']['queues'] = [];
    if (has) {
      queues = (
        await this.pool.query(
          `SELECT name,
                  count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS queued,
                  count(*) FILTER (WHERE state = 'active')::int AS active,
                  count(*) FILTER (WHERE state = 'failed' AND completed_on >= $1::timestamptz - interval '24 hours')::int AS failed24h
             FROM ${BOSS_SCHEMA}.job GROUP BY name ORDER BY name`,
          [now],
        )
      ).rows.map((r) => ({ name: r.name as string, queued: r.queued as number, active: r.active as number, failed24h: r.failed24h as number }));
    }
    return { database: 'up', migrationsCurrent, lastSweepAt, queues };
  }

  /** The banner: protective mode for everyone; backup and storage warnings for Enterprise Administrators only. */
  async banner(isAdmin: boolean): Promise<BannerView> {
    const p = await this.protective();
    const protective = p.on;
    // Update maintenance carries its own banner text; other protective reasons keep the web's own wording.
    const update = protective && p.reason === 'update' ? { reason: 'update' as const, text: UPDATE_BANNER } : {};
    if (!isAdmin) return { protective, ...update };
    const now = this.clock();
    const settings = await loadOpsSettings(this.pool);
    const [backup, storage] = await Promise.all([this.backupSummary(now), this.storage(now, settings)]);
    const worst = storage.locations.reduce<StorageLevel>((w, l) => (SEVERITY[l.level] > SEVERITY[w] ? l.level : w), 'normal');
    const parts: string[] = [];
    if (backup.status !== 'healthy') {
      const last = backup.lastSuccess?.finishedAt ?? backup.lastSuccess?.startedAt;
      const lastText = last ? ` Last successful backup ${shortTime(last)}.` : '';
      if (backup.status === 'none') parts.push('Backups: no backup has been made yet.');
      else if (backup.status === 'target_exceeded') parts.push(`Backups: 24-hour recovery target exceeded.${lastText}`);
      else parts.push(`Backups: the last backup failed.${lastText}`);
    }
    if (worst === 'critical') parts.push('Storage: a disk is at its critical level.');
    else if (worst === 'warning') parts.push('Storage: a disk is at its warning level.');
    else if (worst === 'unknown') parts.push('Storage: no recent reading for a disk.');
    return { protective, ...update, admin: { backups: backup.status, storage: worst, text: parts.join(' '), link: OPERATIONS_LINK } };
  }
}
