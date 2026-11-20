/**
 * The restore drill (spec 8.1, D112): restores a backup set into a temporary database `kainow_drill_<id>` on the same
 * server, checks it, and records the result in the live database's `restore_drills`.
 *
 *   restore-drill [--set <name>|latest] [--keep] [--sample <n>]
 *   restore-drill --drop <kainow_drill_...>
 *
 * Output and stored text are fixed: a failure is a check result or a code plus OPS_FAILURES text, never raw error output.
 * The drill database's connection string is built here and never printed. The last output line of a drill is
 * `run <id> <outcome>`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Pool, type PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import type { ProtectedKey } from '../quarantine/protected-key';
import { exitOf, feed } from './backup';
import { type FailureCode, OPS_FAILURES, codeMigrationLevel, withBackupLock } from './common';
import type { OpsConfig } from './config';
import { type BackupKey, BackupCryptoError, decryptStream, loadBackupKey, sha256Stream } from './crypto';
import { type BackupSummary, type Manifest, SET_FILES, readSet } from './manifest';
import { notifyAdmins } from './notify';
import type { PgTools } from './pg-tools';
import { type Check, type CheckName, sealedChecks } from './sealed-checks';
import { loadOpsSettings } from './settings';
import { OperationsState } from './state';
import type { StatFs } from './storage-check';

export type { Check, CheckName } from './sealed-checks';
export { sealedChecks } from './sealed-checks';
export { drillAgainReason, type DrillAgainReason } from './drill-again';

export type SourceFileCheck = (manifest: Manifest, filesDir: string, key: BackupKey, sample?: number) => Promise<Check>;

export interface DrillDeps {
  pool: Pool;
  config: OpsConfig;
  tools: PgTools;
  statfs: StatFs;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
  protectedKey: ProtectedKey | null;
  checkSourceFiles?: SourceFileCheck;
  /** Space poll interval while pg_restore runs (spec: 30 s). */
  pollMs?: number;
  /** Test seam: called with the drill database just before the row counts are compared. */
  beforeRowCounts?(drill: Pool): Promise<void>;
}

export const DRILL_TEXT = {
  usage: 'Usage: npm run restore-drill -- [--set <name>|latest] [--keep] [--sample <n>] | --drop <kainow_drill_name>',
  busy: 'Another backup or drill is running',
  protective: 'Protective mode is on; run the drill once space is restored',
  noSet: 'There is no successful backup set to drill.',
  setNotFound: 'That backup set was not found, or it is not a successful backup.',
  dropRefused: 'Only a drill database (a name starting kainow_drill_) can be dropped.',
  dropFailed: 'The drill database could not be dropped.',
  checksFailed: 'The restore drill failed; see the Operations page for the checks that failed.',
  overTarget: 'Passed — over the 4-hour target.',
  recordFailed: 'The drill result could not be recorded in the database.',
  unexpected: 'The restore drill stopped unexpectedly.',
} as const;

const CHECK_ORDER: readonly CheckName[] = [
  'set_checksums',
  'decrypt',
  'migration_level',
  'space',
  'restore',
  'row_counts',
  'source_files',
  'sealed_ai_key',
  'sealed_quarantine',
  'sealed_storage_secret',
  'duration',
];

const DETAIL = {
  checksumsBad: 'A file does not match the checksum in backup.json.',
  decryptBad: 'The backup could not be decrypted.',
  migrationNewer: 'The set was made by a newer version of Kainow than this one.',
  noSpace: OPS_FAILURES.drill_no_space,
  spaceLow: OPS_FAILURES.drill_space_low,
  restoreBad: OPS_FAILURES.drill_database_failed,
  sourceNotInUse: 'Source area: not in use for this set.',
  underTarget: 'Under the 4-hour target.',
  overTarget: 'Over the 4-hour target.',
} as const;

const GB = 1024 ** 3;
const TARGET_SECONDS = 4 * 3600;
const POLL_MS = 30_000;
const LINK = '#/admin/operations';
const DRILL_DB = /^kainow_drill_[a-z0-9_]{1,50}$/;
const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Args = { kind: 'drill'; set: string; keep: boolean; sample?: number } | { kind: 'drop'; name: string };

function parseArgs(argv: string[]): Args | null {
  let set = 'latest';
  let keep = false;
  let sample: number | undefined;
  let drop: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') keep = true;
    else if (a === '--set') {
      const v = argv[++i];
      if (!v) return null;
      set = v;
    } else if (a === '--sample') {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v) || Number(v) < 1) return null;
      sample = Number(v);
    } else if (a === '--drop') {
      const v = argv[++i];
      if (!v) return null;
      drop = v;
    } else return null;
  }
  if (drop !== undefined) return argv.length === 2 ? { kind: 'drop', name: drop } : null;
  return { kind: 'drill', set, keep, sample };
}

/** The drill database's connection string: the live one with another database name. Never printed. */
function drillUrl(databaseUrl: string, name: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function dropDatabase(pool: Pool, name: string): Promise<void> {
  if (!DRILL_DB.test(name)) throw new Error('refused');
  await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
    return h.digest('hex');
  } catch {
    return null;
  }
}

/** A sink that discards. */
const discard = () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });

/** The default source-file check (step 6): decrypt each copied file from files/ and compare its SHA-256. */
export const checkSourceFilesDefault: SourceFileCheck = async (manifest, filesDir, key, sample) => {
  const copied = manifest.sourceFiles.filter((f) => f.copied);
  let pick = copied;
  if (sample !== undefined && sample < copied.length) {
    pick = [...copied].sort(() => Math.random() - 0.5).slice(0, sample);
  }
  let bad = 0;
  for (const f of pick) {
    const plain = sha256Stream();
    try {
      await pipeline(createReadStream(join(filesDir, f.sha256.slice(0, 2), `${f.sha256}.enc`)), decryptStream(key), plain, discard());
      if (plain.digest() !== f.sha256) bad++;
    } catch {
      bad++; // a BackupCryptoError included: the file does not count
    }
  }
  const scope = sample !== undefined ? `Sampled ${pick.length} of ${copied.length} files.` : `${pick.length} files checked.`;
  if (bad > 0) return { name: 'source_files', result: 'failed', detail: `${scope} ${bad} did not match.` };
  return { name: 'source_files', result: 'passed', detail: scope };
};

type ChosenSet = { name: string; dir: string; summary: BackupSummary; runId: string | null; folderLabel: string | null };

/** R7: a set with backup.json and no run row is a complete, succeeded set. -incomplete sets never count. */
async function chooseSet(pool: Pool, setsDir: string, wanted: string): Promise<ChosenSet | null> {
  let names: string[];
  if (wanted === 'latest') {
    try {
      names = readdirSync(setsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => SET_NAME.test(n) && !n.endsWith('-incomplete'))
        .sort()
        .reverse();
    } catch {
      return null;
    }
  } else {
    if (!SET_NAME.test(wanted) || wanted.endsWith('-incomplete')) return null;
    names = [wanted];
  }
  for (const name of names) {
    const dir = join(setsDir, name);
    let summary: BackupSummary;
    try {
      summary = JSON.parse(readFileSync(join(dir, SET_FILES.summary), 'utf8')) as BackupSummary;
    } catch {
      continue;
    }
    if (summary?.formatVersion !== 1 || typeof summary.runId !== 'string' || typeof summary.keyId !== 'string') continue;
    const row = UUID.test(summary.runId)
      ? ((await pool.query(`SELECT id, outcome, folder_label FROM backup_runs WHERE id = $1`, [summary.runId])).rows[0] as
          | { id: string; outcome: string; folder_label: string | null }
          | undefined)
      : undefined;
    if (row && row.outcome !== 'succeeded') continue;
    return { name, dir, summary, runId: row ? row.id : null, folderLabel: row ? row.folder_label : null };
  }
  return null;
}

class DrillState {
  readonly checks = new Map<CheckName, Check>();
  code: FailureCode | null = null;
  set(c: Check): void {
    this.checks.set(c.name, c);
  }
  failed(name: CheckName, detail: string, code?: FailureCode): void {
    this.set({ name, result: 'failed', detail });
    if (code && !this.code) this.code = code;
  }
  list(): Check[] {
    return CHECK_ORDER.map((n) => this.checks.get(n) ?? { name: n, result: 'not_tested' });
  }
  anyFailed(): boolean {
    return [...this.checks.values()].some((c) => c.result === 'failed' && c.name !== 'duration');
  }
}

export async function runRestoreDrill(argv: string[], deps: DrillDeps): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    deps.err(DRILL_TEXT.usage);
    return 2;
  }
  try {
    if (args.kind === 'drop') return await drop(args.name, deps);
    if (await new OperationsState(deps.pool, 0).isProtective()) {
      deps.err(DRILL_TEXT.protective);
      return 1;
    }
    const result = await withBackupLock(deps.pool, () => drillLocked(args, deps));
    if (result === 'busy') {
      deps.err(DRILL_TEXT.busy);
      return 1;
    }
    return result;
  } catch {
    deps.err(OPS_FAILURES.database_unreachable);
    return 1;
  }
}

async function drop(name: string, deps: DrillDeps): Promise<number> {
  if (!DRILL_DB.test(name)) {
    deps.err(DRILL_TEXT.dropRefused);
    return 1;
  }
  try {
    await dropDatabase(deps.pool, name);
    await deps.pool.query(`UPDATE restore_drills SET kept_database = NULL WHERE kept_database = $1`, [name]);
  } catch {
    deps.err(DRILL_TEXT.dropFailed);
    return 1;
  }
  deps.out(`Drill database ${name} dropped.`);
  return 0;
}

async function drillLocked(args: Extract<Args, { kind: 'drill' }>, deps: DrillDeps): Promise<number> {
  const { pool, config } = deps;
  // 1. Refusals: none of these records anything.
  const loaded = loadBackupKey(config.backupKeyFile);
  if ('error' in loaded) {
    deps.err(OPS_FAILURES[loaded.error]);
    return 1;
  }
  const key = loaded;
  const setsDir = join(config.backupDir, 'kainow', 'sets');
  const chosen = await chooseSet(pool, setsDir, args.set);
  if (!chosen) {
    deps.err(args.set === 'latest' ? DRILL_TEXT.noSet : DRILL_TEXT.setNotFound);
    return 1;
  }
  if (chosen.summary.keyId !== key.id) {
    deps.err(`This backup was made with key ${chosen.summary.keyId}; mount that key to drill it`);
    return 1;
  }

  const runId = uuidv7();
  const startedAt = deps.now();
  const sampled = args.sample !== undefined;
  await pool.query(
    `INSERT INTO restore_drills (id, backup_run_id, set_name, started_at, outcome, sampled, key_id, folder_label)
     VALUES ($1, $2, $3, $4, 'running', $5, $6, $7)`,
    [runId, chosen.runId, chosen.name, startedAt, sampled, key.id, chosen.folderLabel ?? config.folderLabel],
  );
  deps.out(`Drilling backup set ${chosen.name}.`);

  const st = new DrillState();
  const dbName = `kainow_drill_${runId.replace(/-/g, '').slice(-12)}`;
  let created = false;
  let durationSeconds: number | null = null;
  let kept: string | null = null;
  try {
    await steps(args, deps, chosen, key, st, dbName, () => (created = true), (s) => (durationSeconds = s));
  } catch {
    // Anything unexpected: the stage that was running fails as the drill database's failure, never with raw text.
    if (!st.anyFailed()) st.failed('restore', DETAIL.restoreBad, 'drill_database_failed');
  } finally {
    if (created) {
      if (args.keep) kept = dbName;
      else {
        try {
          await dropDatabase(pool, dbName);
        } catch {
          kept = dbName; // listed until dropped by hand
          deps.err(DRILL_TEXT.dropFailed);
        }
      }
    }
  }
  return record(deps, { runId, setName: chosen.name, sampled, st, durationSeconds, kept });
}

async function steps(
  args: Extract<Args, { kind: 'drill' }>,
  deps: DrillDeps,
  chosen: ChosenSet,
  key: BackupKey,
  st: DrillState,
  dbName: string,
  markCreated: () => void,
  setDuration: (s: number) => void,
): Promise<void> {
  const { pool, config } = deps;
  // 2. Check the set: checksums, then the manifest, then the migration level.
  const dumpFile = join(chosen.dir, SET_FILES.dump);
  const files = chosen.summary.files ?? ({} as BackupSummary['files']);
  const dumpSha = await fileSha256(dumpFile);
  const manSha = await fileSha256(join(chosen.dir, SET_FILES.manifest));
  if (!dumpSha || !manSha || dumpSha !== files[SET_FILES.dump]?.sha256 || manSha !== files[SET_FILES.manifest]?.sha256) {
    st.failed('set_checksums', DETAIL.checksumsBad);
    return;
  }
  st.set({ name: 'set_checksums', result: 'passed' });

  let manifest: Manifest;
  try {
    manifest = (await readSet(chosen.dir, key)).manifest;
  } catch {
    st.failed('decrypt', DETAIL.decryptBad);
    return;
  }

  if ((chosen.summary.migrationLevel ?? '') > codeMigrationLevel()) {
    st.failed('migration_level', DETAIL.migrationNewer);
    return;
  }
  st.set({ name: 'migration_level', result: 'passed' });

  // 2a. Space before restoring: the live database's size x 1.2, plus the safe floor, plus 2 GB.
  const floor = (await loadOpsSettings(pool)).safeFloorGb * GB;
  const size = Number((await pool.query('SELECT pg_database_size(current_database())::text AS n')).rows[0].n);
  const stat = safeStat(deps.statfs, config.dbDataDir);
  if (!stat || stat.free < size * 1.2 + floor + 2 * GB) {
    st.failed('space', DETAIL.noSpace, 'drill_no_space');
    return;
  }
  st.set({ name: 'space', result: 'passed' });

  // 3. The temporary database.
  try {
    await pool.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  } catch {
    st.failed('restore', DETAIL.restoreBad, 'drill_database_failed');
    return;
  }
  markCreated();

  // 4. Restore; the clock starts here.
  const clockStart = deps.now();
  const restored = await restore(deps, dbName, dumpFile, key, floor);
  if (restored === 'crypto') {
    st.failed('decrypt', DETAIL.decryptBad);
    return;
  }
  st.set({ name: 'decrypt', result: 'passed' });
  if (restored === 'space_low') {
    st.failed('restore', DETAIL.spaceLow, 'drill_space_low');
    return;
  }
  if (restored === 'failed') {
    st.failed('restore', DETAIL.restoreBad, 'drill_database_failed');
    return;
  }
  st.set({ name: 'restore', result: 'passed' });

  const drillPool = new Pool({ connectionString: drillUrl(config.databaseUrl, dbName), max: 2 });
  drillPool.on('error', () => undefined);
  try {
    // 5. Row counts.
    await deps.beforeRowCounts?.(drillPool);
    const differ: string[] = [];
    for (const t of manifest.tables) {
      let n: number | null = null;
      try {
        n = Number((await drillPool.query(`SELECT count(*) AS n FROM ${quoteIdent(t.schema)}.${quoteIdent(t.table)}`)).rows[0].n);
      } catch {
        n = null;
      }
      if (n !== t.rows) differ.push(`${t.schema}.${t.table}`);
    }
    if (differ.length > 0) st.failed('row_counts', `Row counts differ: ${differ.join(', ')}.`);
    else st.set({ name: 'row_counts', result: 'passed', detail: `${manifest.tables.length} tables match.` });

    // 6. Source files.
    if (manifest.sourceArea !== 'included') {
      st.set({ name: 'source_files', result: 'not_tested', detail: DETAIL.sourceNotInUse });
    } else {
      const checker = deps.checkSourceFiles ?? checkSourceFilesDefault;
      let c: Check;
      try {
        c = await checker(manifest, join(config.backupDir, 'kainow', 'files'), key, args.sample);
      } catch {
        c = { name: 'source_files', result: 'failed', detail: DETAIL.decryptBad };
      }
      st.set({ ...c, name: 'source_files' });
    }

    // 7. Sealed values.
    for (const c of await sealedChecks(drillPool, deps.protectedKey)) st.set(c);
  } finally {
    await drillPool.end().catch(() => undefined);
  }

  // 8. Time.
  const seconds = Math.max(0, Math.round((deps.now().getTime() - clockStart.getTime()) / 1000));
  setDuration(seconds);
  st.set(
    seconds < TARGET_SECONDS
      ? { name: 'duration', result: 'passed', detail: DETAIL.underTarget }
      : { name: 'duration', result: 'failed', detail: DETAIL.overTarget },
  );
}

function safeStat(statfs: StatFs, path: string): { total: number; free: number } | null {
  try {
    const s = statfs(path);
    return s && Number.isFinite(s.free) ? s : null;
  } catch {
    return null;
  }
}

/**
 * Streams the decrypted dump into pg_restore, checking free space every pollMs. Any BackupCryptoError is 'crypto': what
 * pg_restore read before it is never treated as a restore.
 */
async function restore(deps: DrillDeps, dbName: string, dumpFile: string, key: BackupKey, floor: number): Promise<'ok' | 'crypto' | 'space_low' | 'failed'> {
  const child = deps.tools.restore(['--no-owner', '--exit-on-error', '-d', dbName]);
  const exited = exitOf(child);
  child.stdout?.resume();
  child.stderr?.resume(); // never printed: it can name hosts and databases
  const abort = new AbortController();
  let low = false;
  const timer = setInterval(() => {
    const s = safeStat(deps.statfs, deps.config.dbDataDir);
    // An unreadable poll is not a low reading; the next poll decides.
    if (!low && s && s.free < floor + 2 * GB) {
      low = true;
      abort.abort();
      child.kill();
    }
  }, deps.pollMs ?? POLL_MS);
  try {
    try {
      if (!child.stdin) return 'failed';
      await pipeline(createReadStream(dumpFile), decryptStream(key), feed(child.stdin), { signal: abort.signal });
    } catch (err) {
      child.kill();
      await exited;
      if (err instanceof BackupCryptoError) return 'crypto';
      return low ? 'space_low' : 'failed';
    }
    const code = await exited;
    if (low) return 'space_low';
    return code === 0 ? 'ok' : 'failed';
  } finally {
    clearInterval(timer);
  }
}

async function inTransaction(pool: Pool, fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    try {
      await fn(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    c.release(broken);
  }
}

/** 10. Record the result, its audit event and (on failure) the urgent notice together. */
async function record(
  deps: DrillDeps,
  r: { runId: string; setName: string; sampled: boolean; st: DrillState; durationSeconds: number | null; kept: string | null },
): Promise<number> {
  const checks = r.st.list();
  const failed = r.st.anyFailed() || checks.find((c) => c.name === 'restore')?.result !== 'passed' || checks.find((c) => c.name === 'row_counts')?.result !== 'passed';
  const over = !failed && checks.find((c) => c.name === 'duration')?.result === 'failed';
  const outcome = failed ? 'failed' : over ? 'passed_over_target' : 'passed';
  const code = failed ? r.st.code : null;
  const at = deps.now();
  for (const c of checks) deps.out(`${c.name}: ${c.result}${c.detail ? ` (${c.detail})` : ''}`);
  try {
    await inTransaction(deps.pool, async (c) => {
      await c.query(
        `UPDATE restore_drills SET outcome = $2, finished_at = $3, duration_seconds = $4, checks = $5, failure_code = $6, kept_database = $7
          WHERE id = $1`,
        [r.runId, outcome, at, r.durationSeconds, JSON.stringify(checks), code, r.kept],
      );
      await writeAudit(c, {
        at,
        action: failed ? 'ops.restore_drill_failed' : 'ops.restore_drill_passed',
        subjectType: 'restore_drill',
        subjectId: r.runId,
        detail: {
          setName: r.setName,
          outcome,
          sampled: r.sampled,
          durationSeconds: r.durationSeconds,
          ...(code ? { code } : {}),
          ...(failed ? { failedChecks: checks.filter((x) => x.result === 'failed').map((x) => x.name) } : {}),
        },
      });
      if (failed) {
        await notifyAdmins(c, {
          kind: 'restore_drill_failed',
          summary: `Restore drill failed. ${code ? OPS_FAILURES[code] : DRILL_TEXT.checksFailed}`,
          link: LINK,
          now: at,
          urgent: true,
        });
      }
    });
  } catch {
    deps.err(DRILL_TEXT.recordFailed);
  }
  if (r.kept) deps.out(`Drill database ${r.kept} kept; drop it with restore-drill --drop ${r.kept}.`);
  if (failed) deps.err(code ? OPS_FAILURES[code] : DRILL_TEXT.checksFailed);
  else if (over) deps.out(DRILL_TEXT.overTarget);
  deps.out(`run ${r.runId} ${outcome}`);
  return failed ? 1 : 0;
}
