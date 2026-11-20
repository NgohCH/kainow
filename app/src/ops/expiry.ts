/**
 * Backup expiry (spec 5.7, D110): run by the backup command after a success, never after a failure.
 *
 * Sets older than the retention period go, except the newest succeeded set and the newest succeeded pre_update set;
 * `-incomplete` sets (and row-less folders without backup.json) go after a day. A row-less folder WITH backup.json is a
 * complete set (for example after a restore) and follows normal retention. Then files in `files/` that no remaining
 * set's manifest lists go, but only once every remaining manifest has been decrypted and read.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import type { OpsConfig } from './config';
import type { BackupKey } from './crypto';
import { type BackupKind, SET_FILES, readSet } from './manifest';
import { loadOpsSettings } from './settings';

const DAY_MS = 86_400_000;

export type ExpirySet = {
  name: string;
  runId: string;
  kind: BackupKind;
  /** When the set finished; for an incomplete set, its folder-name timestamp. */
  finishedAt: Date;
  succeeded: boolean;
  incomplete: boolean;
};

/** The names of the sets to remove. Pure: ages are measured against `now`. */
export function chooseExpired(sets: ExpirySet[], retentionDays: number, now: Date): string[] {
  const newest = (list: ExpirySet[]): ExpirySet | undefined =>
    [...list].sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime() || (a.name < b.name ? 1 : -1))[0];
  const good = sets.filter((s) => s.succeeded && !s.incomplete);
  const keep = new Set<string>();
  const latest = newest(good);
  const latestPre = newest(good.filter((s) => s.kind === 'pre_update'));
  if (latest) keep.add(latest.name);
  if (latestPre) keep.add(latestPre.name);

  return sets
    .filter((s) => {
      if (keep.has(s.name)) return false;
      const age = now.getTime() - s.finishedAt.getTime();
      return age > (s.incomplete ? DAY_MS : retentionDays * DAY_MS);
    })
    .map((s) => s.name);
}

const SET_NAME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z-(daily|manual|pre_update)-([0-9a-f-]{36})(-incomplete)?$/;

/** Reads `2026-11-21T0200Z-daily-<run id>[-incomplete]`; null for any other folder name. */
export function parseSetName(name: string): { at: Date; kind: BackupKind; runId: string; incomplete: boolean } | null {
  const m = SET_NAME.exec(name);
  if (!m) return null;
  const at = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  return { at, kind: m[6] as BackupKind, runId: m[7], incomplete: m[8] !== undefined };
}

/** backup.json's kind and finish time, or null when it is missing. Present but unreadable still counts as a set. */
function readSummary(dir: string): { kind?: BackupKind; finishedAt?: Date } | null {
  const file = join(dir, SET_FILES.summary);
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { kind?: unknown; finishedAt?: unknown };
    const kind = j.kind === 'daily' || j.kind === 'manual' || j.kind === 'pre_update' ? j.kind : undefined;
    const t = typeof j.finishedAt === 'string' ? new Date(j.finishedAt) : undefined;
    return { kind, finishedAt: t && !Number.isNaN(t.getTime()) ? t : undefined };
  } catch {
    return {};
  }
}

/** recordingFailed is present (true) only when an expired_at update or the audit event could not be written. */
export type ExpiryResult = { sets: number; files: number; filesSkipped: boolean; recordingFailed?: true };

export async function expireBackups(pool: Pool, config: OpsConfig, key: BackupKey, now: Date): Promise<ExpiryResult> {
  const setsDir = join(config.backupDir, 'kainow', 'sets');
  const filesDir = join(config.backupDir, 'kainow', 'files');
  const { backupRetentionDays } = await loadOpsSettings(pool);

  const folders = existsSync(setsDir) ? readdirSync(setsDir) : [];
  const parsed = folders.flatMap((name) => {
    const p = parseSetName(name);
    return p ? [{ name, ...p }] : [];
  });
  const rows = new Map<string, { outcome: string; finishedAt: Date | null }>();
  if (parsed.length > 0) {
    const r = await pool.query(`SELECT id, outcome, finished_at FROM backup_runs WHERE id = ANY($1::uuid[])`, [parsed.map((p) => p.runId)]);
    for (const x of r.rows as Array<{ id: string; outcome: string; finished_at: Date | null }>) {
      rows.set(x.id, { outcome: x.outcome, finishedAt: x.finished_at });
    }
  }

  const sets: ExpirySet[] = parsed.map((p) => {
    const row = rows.get(p.runId);
    const unfinished: ExpirySet = { name: p.name, runId: p.runId, kind: p.kind, finishedAt: p.at, succeeded: false, incomplete: true };
    if (p.incomplete) return unfinished;
    if (!row) {
      // No row (for example after a restore): complete if it has backup.json, and then a succeeded set by its own summary.
      const summary = readSummary(join(setsDir, p.name));
      if (!summary) return unfinished;
      return { ...unfinished, kind: summary.kind ?? p.kind, finishedAt: summary.finishedAt ?? p.at, succeeded: true, incomplete: false };
    }
    return { ...unfinished, finishedAt: row.finishedAt ?? p.at, succeeded: row.outcome === 'succeeded', incomplete: false };
  });

  // 1. Sets.
  const removed: ExpirySet[] = [];
  for (const name of chooseExpired(sets, backupRetentionDays, now)) {
    try {
      await rm(join(setsDir, name), { recursive: true, force: true });
      removed.push(sets.find((s) => s.name === name) as ExpirySet);
    } catch {
      // Left for the next run.
    }
  }
  const removedNames = new Set(removed.map((s) => s.name));

  // 2. Files: read every remaining manifest first; one that cannot be read means no file is removed this run.
  const referenced = new Set<string>();
  let filesSkipped = false;
  for (const s of sets) {
    if (removedNames.has(s.name)) continue;
    const dir = join(setsDir, s.name);
    if (!existsSync(join(dir, SET_FILES.summary)) && !s.succeeded) continue; // never finished: no manifest to list
    try {
      const { manifest } = await readSet(dir, key);
      for (const f of manifest.sourceFiles) referenced.add(f.sha256);
    } catch {
      filesSkipped = true;
      break;
    }
  }
  let files = 0;
  if (!filesSkipped && existsSync(filesDir)) {
    for (const shard of await readdir(filesDir)) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      for (const f of await readdir(join(filesDir, shard))) {
        const m = /^([0-9a-f]{64})\.enc$/.exec(f);
        if (!m || m[1].slice(0, 2) !== shard || referenced.has(m[1])) continue;
        try {
          await unlink(join(filesDir, shard, f));
          files++;
        } catch {
          // Left for the next run.
        }
      }
    }
  }

  // 3. Recording, best effort: the folders and files are already gone, so a database error here must not abort.
  let recordingFailed = false;
  for (const s of removed) {
    try {
      await pool.query(`UPDATE backup_runs SET expired_at = $2 WHERE id = $1 AND expired_at IS NULL`, [s.runId, now]);
    } catch {
      recordingFailed = true;
    }
  }
  const result: ExpiryResult = { sets: removed.length, files, filesSkipped };
  if (result.sets > 0 || result.files > 0 || result.filesSkipped) {
    try {
      await writeAudit(pool, { at: now, action: 'ops.backup_expired', subjectType: 'backup_run', detail: { ...result } });
    } catch {
      recordingFailed = true;
    }
  }
  if (recordingFailed) result.recordingFailed = true;
  return result;
}
