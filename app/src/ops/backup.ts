/**
 * The backup command (spec 5.1-5.6): a consistent pg_dump under an exported snapshot, streamed through the KNBK1
 * encryptor into a new set folder, read back and checked, then recorded in backup_runs.
 *
 * Output and stored text are fixed: a failure is a code plus OPS_FAILURES text, never raw error output, which can carry
 * paths or connection strings. The last output line is `run <id> succeeded` or `run <id> failed <code>`.
 */
import type { ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { type FailureCode, OPS_FAILURES, currentMigrationLevel, withBackupLock } from './common';
import type { OpsConfig } from './config';
import { type BackupKey, decryptStream, encryptStream, loadBackupKey, sha256Stream } from './crypto';
import { type BackupKind, type BackupSummary, type Manifest, SET_FILES, type SourceFileCopier, decryptFile } from './manifest';
import { expireBackups } from './expiry';
import { notifyAdmins } from './notify';
import type { PgTools } from './pg-tools';

export interface BackupDeps {
  pool: Pool;
  config: OpsConfig;
  tools: PgTools;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
  /** Source-area copier (Task 15). Undefined: the manifest says the source area is not in use. */
  sourceFiles?: SourceFileCopier;
  /** Test seam: called with each encrypted file's final path once it is in place, before it is read back. */
  afterWrite?(file: string): void | Promise<void>;
}

export const BACKUP_TEXT = {
  usage: 'Usage: npm run backup -- [--kind daily|manual|pre_update] [--new-key]',
  busy: 'Another backup or drill is running',
} as const;

const KINDS: readonly BackupKind[] = ['daily', 'manual', 'pre_update'];
const OPERATIONS_LINK = '#/admin/operations';

/** A failure with a known code, raised by the steps below. */
class OpsFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(OPS_FAILURES[code]);
  }
}

/** Where the run is, which decides the code of an unexpected error there. */
type Stage = 'folder' | 'key' | 'snapshot' | 'dump' | 'manifest' | 'verify' | 'summary' | 'record';
const STAGE_DEFAULT: Record<Stage, FailureCode> = {
  folder: 'folder_not_writable',
  key: 'key_invalid',
  snapshot: 'database_unreachable',
  dump: 'dump_failed',
  manifest: 'folder_not_writable',
  verify: 'verify_failed',
  summary: 'folder_not_writable',
  record: 'database_unreachable',
};
const WRITING: ReadonlySet<Stage> = new Set(['folder', 'dump', 'manifest', 'summary']);

function folderPresent(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function classify(err: unknown, stage: Stage, backupDir: string): FailureCode {
  if (err instanceof OpsFailure) return err.code;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'no_space';
  // A share that drops mid-run shows up as some write error; name it for what it is.
  if (WRITING.has(stage) && !folderPresent(backupDir)) return 'folder_missing';
  return STAGE_DEFAULT[stage];
}

/** `2026-11-21T0200Z`: sorts by time. */
export function setStamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 13)}${iso.slice(14, 16)}Z`;
}

function kainowVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv: string[]): { kind: BackupKind; newKey: boolean } | null {
  let kind: BackupKind = 'manual';
  let newKey = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--new-key') newKey = true;
    else if (argv[i] === '--kind') {
      const v = argv[++i];
      if (!KINDS.includes(v as BackupKind)) return null;
      kind = v as BackupKind;
    } else return null;
  }
  return { kind, newKey };
}

/** Resolves with the exit code, or null when the process could not be started. Never rejects. */
function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c: number | null) => {
      if (!done) {
        done = true;
        resolve(c);
      }
    };
    child.on('error', () => finish(null));
    child.on('close', (c) => finish(c));
  });
}

/**
 * A sink that feeds a child's stdin but keeps consuming after the child stops reading (pg_restore --list may exit
 * once it has the table of contents), so the whole stream is still hashed. The child's exit code is the judge.
 */
function feed(stdin: Writable): Writable {
  let open = true;
  stdin.on('error', () => (open = false));
  stdin.on('close', () => (open = false));
  return new Writable({
    write(chunk: Buffer, _e, cb) {
      if (!open) return cb();
      if (stdin.write(chunk)) return cb();
      const done = () => {
        stdin.off('drain', done);
        stdin.off('close', done);
        cb();
      };
      stdin.once('drain', done);
      stdin.once('close', done);
    },
    final(cb) {
      if (open) stdin.end();
      cb();
    },
  });
}

async function countTables(client: PoolClient): Promise<Manifest['tables']> {
  const { rows } = await client.query(
    `SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'pgboss') ORDER BY schemaname, tablename`,
  );
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const tables: Manifest['tables'] = [];
  for (const r of rows as Array<{ schemaname: string; tablename: string }>) {
    const n = await client.query(`SELECT count(*) AS n FROM ${quote(r.schemaname)}.${quote(r.tablename)}`);
    tables.push({ schema: r.schemaname, table: r.tablename, rows: Number(n.rows[0].n) });
  }
  return tables;
}

type Written = { sha256: string; bytes: number; plainSha256: string };

async function writeDump(tools: PgTools, snapshot: string, key: BackupKey, tmp: string): Promise<Written> {
  const child = tools.dump(['--format=custom', `--snapshot=${snapshot}`, '--no-owner']);
  const exited = exitOf(child);
  child.stderr?.resume(); // never printed: it can name hosts and databases
  const plain = sha256Stream();
  const enc = sha256Stream();
  try {
    if (!child.stdout) throw new OpsFailure('dump_failed');
    await pipeline(child.stdout, plain, encryptStream(key), enc, createWriteStream(tmp, { flags: 'wx' }));
  } catch (err) {
    child.kill();
    await exited;
    throw err;
  }
  if ((await exited) !== 0) throw new OpsFailure('dump_failed');
  return { sha256: enc.digest(), plainSha256: plain.digest(), bytes: statSync(tmp).size };
}

async function writeEncrypted(plain: Buffer, key: BackupKey, tmp: string): Promise<{ sha256: string; bytes: number }> {
  const enc = sha256Stream();
  await pipeline(Readable.from([plain]), encryptStream(key), enc, createWriteStream(tmp, { flags: 'wx' }));
  return { sha256: enc.digest(), bytes: statSync(tmp).size };
}

/** Decrypts the dump in full, checks both hashes, and has pg_restore --list read it. Any mismatch is verify_failed. */
async function verifyDump(tools: PgTools, file: string, key: BackupKey, expected: Written): Promise<void> {
  const list = tools.list();
  const exited = exitOf(list);
  list.stdout?.resume();
  list.stderr?.resume();
  const enc = sha256Stream();
  const plain = sha256Stream();
  try {
    if (!list.stdin) throw new OpsFailure('verify_failed');
    await pipeline(createReadStream(file), enc, decryptStream(key), plain, feed(list.stdin));
  } catch {
    list.kill();
    await exited;
    throw new OpsFailure('verify_failed');
  }
  const code = await exited;
  if (code !== 0 || enc.digest() !== expected.sha256 || plain.digest() !== expected.plainSha256) {
    throw new OpsFailure('verify_failed');
  }
}

export async function runBackup(argv: string[], deps: BackupDeps): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    deps.err(BACKUP_TEXT.usage);
    return 2;
  }
  try {
    const result = await withBackupLock(deps.pool, () => backupLocked(args.kind, args.newKey, deps));
    if (result === 'busy') {
      deps.err(BACKUP_TEXT.busy);
      return 1;
    }
    return result;
  } catch {
    // Only reaching the database (connect, lock, the first row) can end up here; nothing could be recorded.
    deps.err(OPS_FAILURES.database_unreachable);
    return 1;
  }
}

async function backupLocked(kind: BackupKind, newKey: boolean, deps: BackupDeps): Promise<number> {
  const { pool, config } = deps;
  const runId = uuidv7();
  const startedAt = deps.now();
  const setName = `${setStamp(startedAt)}-${kind}-${runId}`;
  await pool.query(
    `INSERT INTO backup_runs (id, kind, started_at, outcome, set_name, folder_label) VALUES ($1, $2, $3, 'running', $4, $5)`,
    [runId, kind, startedAt, setName, config.folderLabel],
  );

  const setsDir = join(config.backupDir, 'kainow', 'sets');
  const setDir = join(setsDir, setName);
  let setCreated = false;
  let stage: Stage = 'folder';
  try {
    // 3. The folder (present and writable, via a probe file) and the key.
    if (!folderPresent(config.backupDir)) throw new OpsFailure('folder_missing');
    await mkdir(setsDir, { recursive: true });
    const probe = join(config.backupDir, 'kainow', `.probe-${runId}`);
    await writeFile(probe, 'kainow');
    await unlink(probe);

    stage = 'key';
    const loaded = loadBackupKey(config.backupKeyFile);
    if ('error' in loaded) throw new OpsFailure(loaded.error);
    const key = loaded;
    let previous: string | undefined;
    try {
      previous = (
        await pool.query(
          `SELECT key_id FROM backup_runs WHERE outcome = 'succeeded' AND key_id IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1`,
        )
      ).rows[0]?.key_id as string | undefined;
    } catch {
      throw new OpsFailure('database_unreachable');
    }
    const keyChanged = previous !== undefined && previous !== key.id;
    if (keyChanged && !newKey) throw new OpsFailure('key_changed');

    stage = 'folder';
    await mkdir(setDir);
    setCreated = true;

    // 4-5. Count rows and dump under one exported snapshot; the transaction stays open until pg_dump is done.
    stage = 'snapshot';
    const dumpTmp = join(setDir, `${SET_FILES.dump}.tmp`);
    const dumpFile = join(setDir, SET_FILES.dump);
    let tables: Manifest['tables'];
    let migrationLevel: string;
    let dump: Written;
    const snap = await pool.connect();
    let broken = false;
    try {
      await snap.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = (await snap.query('SELECT pg_export_snapshot() AS id')).rows[0].id as string;
      tables = await countTables(snap);
      migrationLevel = await currentMigrationLevel(snap);
      stage = 'dump';
      dump = await writeDump(deps.tools, snapshot, key, dumpTmp);
    } finally {
      await snap.query('ROLLBACK').catch(() => (broken = true));
      snap.release(broken);
    }
    await rename(dumpTmp, dumpFile);
    await deps.afterWrite?.(dumpFile);

    // 6. The encrypted manifest. Source files: Task 15 adds the copier; until then the source area is not in use.
    stage = 'manifest';
    const manifest: Manifest = { formatVersion: 1, runId, tables, sourceFiles: [], sourceArea: 'not_in_use' };
    const manifestPlain = Buffer.from(JSON.stringify(manifest), 'utf8');
    const manifestTmp = join(setDir, `${SET_FILES.manifest}.tmp`);
    const manifestFile = join(setDir, SET_FILES.manifest);
    const man = await writeEncrypted(manifestPlain, key, manifestTmp);
    await rename(manifestTmp, manifestFile);
    await deps.afterWrite?.(manifestFile);

    // 7. Read everything back.
    stage = 'verify';
    await verifyDump(deps.tools, dumpFile, key, dump);
    const back = await decryptFile(manifestFile, key).catch(() => {
      throw new OpsFailure('verify_failed');
    });
    if (back.sha256 !== man.sha256 || !back.plain.equals(manifestPlain)) throw new OpsFailure('verify_failed');

    // 8. backup.json last: a set without it is incomplete.
    stage = 'summary';
    const finishedAt = deps.now();
    const summary: BackupSummary = {
      formatVersion: 1,
      runId,
      kind,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      keyId: key.id,
      kainowVersion: kainowVersion(),
      migrationLevel,
      databaseBytes: dump.bytes,
      fileCount: manifest.sourceFiles.length,
      sourceArea: manifest.sourceArea,
      files: {
        [SET_FILES.dump]: { sha256: dump.sha256, bytes: dump.bytes, plainSha256: dump.plainSha256 },
        [SET_FILES.manifest]: { sha256: man.sha256, bytes: man.bytes },
      },
    };
    const summaryTmp = join(setDir, `${SET_FILES.summary}.tmp`);
    await writeFile(summaryTmp, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
    await rename(summaryTmp, join(setDir, SET_FILES.summary));

    // 9. Record the success.
    stage = 'record';
    await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE backup_runs SET outcome = 'succeeded', finished_at = $2, key_id = $3, kainow_version = $4,
           migration_level = $5, database_bytes = $6, files_total = 0, files_new = 0, files_new_bytes = 0,
           files_not_copied = 0, source_area = $7, manifest_sha256 = $8
         WHERE id = $1`,
        [runId, finishedAt, key.id, summary.kainowVersion, migrationLevel, dump.bytes, manifest.sourceArea, man.sha256],
      );
      await writeAudit(c, {
        at: finishedAt,
        action: 'ops.backup_succeeded',
        subjectType: 'backup_run',
        subjectId: runId,
        detail: { kind, setName, keyId: key.id, databaseBytes: dump.bytes },
      });
      if (keyChanged) {
        await writeAudit(c, {
          at: finishedAt,
          action: 'ops.backup_key_changed',
          subjectType: 'backup_run',
          subjectId: runId,
          detail: { previousKeyId: previous, keyId: key.id },
        });
      }
    });

    deps.out(`Backup set ${setName} written.`);
    // Expiry runs here, after a success only: a run of failures can never remove the last good copy. It never turns
    // a good backup into a failed one.
    try {
      const expired = await expireBackups(pool, config, key, deps.now());
      if (expired.sets > 0 || expired.files > 0) deps.out(`Expired ${expired.sets} old sets and ${expired.files} unused files.`);
      if (expired.recordingFailed) deps.err('Expired backups could not all be recorded in the database.');
      if (expired.filesSkipped) deps.out('Unused files were not removed this time: a backup set could not be read.');
    } catch {
      deps.err('Old backups could not be expired this time.');
    }
    deps.out(`run ${runId} succeeded`);
    return 0;
  } catch (err) {
    const code = classify(err, stage, config.backupDir);
    await recordFailure(deps, { runId, kind, code, setDir: setCreated ? setDir : null, setName });
    return 1;
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

/**
 * The failure path: the set is renamed -incomplete, the row is set failed with the code, and the audit event and one
 * backup_failed notice per Administrator are written in one transaction. If the database is gone by now, the row stays
 * running and the sweep marks it interrupted; the output still says what happened.
 */
async function recordFailure(
  deps: BackupDeps,
  f: { runId: string; kind: BackupKind; code: FailureCode; setDir: string | null; setName: string },
): Promise<void> {
  let setName = f.setName;
  if (f.setDir && existsSync(f.setDir)) {
    try {
      // A set with backup.json is complete by definition, so it goes first (a failure while recording the success).
      await rm(join(f.setDir, SET_FILES.summary), { force: true });
      await rename(f.setDir, `${f.setDir}-incomplete`);
      setName = `${f.setName}-incomplete`;
    } catch {
      // Left under its own name; it has no backup.json, so it is still incomplete.
    }
  }
  const text = OPS_FAILURES[f.code];
  const at = deps.now();
  try {
    await inTransaction(deps.pool, async (c) => {
      // Only a run still `running` is failed here; if the sweep already marked it interrupted (and notified), stop.
      const done = await c.query(
        `UPDATE backup_runs SET outcome = 'failed', finished_at = $2, failure_code = $3, failure_detail = $4, set_name = $5
         WHERE id = $1 AND outcome = 'running'`,
        [f.runId, at, f.code, text, setName],
      );
      if ((done.rowCount ?? 0) === 0) return;
      await writeAudit(c, {
        at,
        action: 'ops.backup_failed',
        subjectType: 'backup_run',
        subjectId: f.runId,
        detail: { kind: f.kind, code: f.code },
      });
      await notifyAdmins(c, { kind: 'backup_failed', summary: `Backup failed. ${text}`, link: OPERATIONS_LINK, now: at, urgent: true });
    });
  } catch {
    deps.err(OPS_FAILURES.database_unreachable);
    // The combined transaction failed as a whole; still try to leave the row failed rather than running.
    try {
      await deps.pool.query(
        `UPDATE backup_runs SET outcome = 'failed', failure_code = $2, failure_detail = $3, finished_at = $4, set_name = $5
         WHERE id = $1 AND outcome = 'running'`,
        [f.runId, f.code, text, at, setName],
      );
    } catch {
      // The database is gone; the sweep marks the row interrupted.
    }
  }
  deps.err(text);
  deps.out(`run ${f.runId} failed ${f.code}`);
}

