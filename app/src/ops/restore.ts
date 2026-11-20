/**
 * Restore into a new, empty installation (spec 8.2, D112).
 *
 *   restore --set <name>|latest --reason "<why>"
 *
 * Run with only the database service started: it never needs the API or the worker. It refuses unless the target database
 * is empty (no table in public, no pgboss schema), runs the drill's refusals and checks first (spec 8.1 steps 1-2a), restores
 * with pg_restore, compares the row counts, then runs afterRestore in one transaction.
 *
 * Output and stored text are fixed: never a key, a secret, a connection string, a host path or file content.
 * Once pg_restore has started, any failure (a decryption error included) leaves a partial database: afterRestore never runs
 * on it, and the operator is told to recreate the target empty before trying again.
 */
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { refuseSecrets } from '../discussion/messages';
import { afterRestore, restoredText } from './after-restore';
import { OPS_FAILURES, withBackupLock } from './common';
import type { OpsConfig } from './config';
import { loadBackupKey } from './crypto';
import { checkSet, chooseSet, quoteIdent, restoreDump, safeStat } from './drill';
import { SET_FILES } from './manifest';
import type { PgTools } from './pg-tools';
import { OPS_DEFAULTS } from './settings';
import type { StatFs } from './storage-check';

export interface RestoreDeps {
  /** The target database: the new installation's own (DATABASE_URL). */
  pool: Pool;
  config: OpsConfig;
  tools: PgTools;
  statfs: StatFs;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
  /** Whether the protected key is mounted (spec 8.2 step 7: the output repeats the warning). */
  protectedKeyPresent: boolean;
  /** Space poll interval while pg_restore runs (spec: 30 s). */
  pollMs?: number;
}

const RECREATE = 'Recreate the target database empty before trying again.';
/** Said whenever the run may have stopped between pg_restore committing and the post-steps committing. */
const INTERRUPTED =
  'If an earlier restore into it was interrupted, its Kainow tables are not safe to start: do not start Kainow on it; drop and recreate the target database empty, then run restore again.';

export const RESTORE_TEXT = {
  usage: 'Usage: npm run restore -- --set <name>|latest --reason "<why>"',
  noReason: 'Give a reason with --reason "<why>".',
  notEmpty: `The target database is not empty, so nothing was changed: a restore only goes into a new, empty installation. ${INTERRUPTED}`,
  busy: 'Another backup, drill or restore is running',
  noSet: 'There is no successful backup set to restore.',
  setNotFound: 'That backup set was not found, or it is not a successful backup.',
  wrongKey: (keyId: string) => `This backup was made with key ${keyId}; mount that key to restore it`,
  checksumsBad: 'A file does not match the checksum in backup.json. Nothing was restored.',
  manifestBad: 'The backup could not be decrypted. Nothing was restored.',
  migrationNewer: 'The set was made by a newer version of Kainow than this one. Nothing was restored.',
  noSpace: 'There is not enough free space on the database disk to restore this backup. Nothing was restored.',
  decryptFailed: `The backup could not be decrypted while restoring; the restore was rolled back. ${RECREATE}`,
  spaceLow: `Free space ran too low during the restore; the restore was rolled back. ${RECREATE}`,
  restoreFailed: `The restore into the target database failed. ${RECREATE}`,
  rowCounts: (tables: string[]) => `Row counts differ from the backup: ${tables.join(', ')}. ${RECREATE}`,
  afterFailed: `The restored database could not be put into protective read-only mode. ${RECREATE}`,
  unexpected: `The restore stopped unexpectedly. Do not start Kainow on the target database: drop and recreate it empty, then run restore again.`,
  noProtectedKey:
    'No protected key is mounted: sealed AI keys and the storage secret cannot be opened until it is mounted from its recovery copy.',
  next: 'Next: start Kainow with docker compose up -d --build. It starts read-only; an Administrator signs in, checks, and chooses Resume normal use.',
  done: restoredText,
} as const;

const GB = 1024 ** 3;
const MAX_REASON = 1_000;

type Args = { set: string; reason: string };

function parseArgs(argv: string[]): Args | 'usage' | 'no_reason' {
  let set = 'latest';
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') {
      const v = argv[++i];
      if (!v) return 'usage';
      set = v;
    } else if (a === '--reason') {
      const v = argv[++i];
      if (v === undefined) return 'no_reason';
      reason = v;
    } else return 'usage';
  }
  const text = reason?.trim() ?? '';
  if (text === '' || text.length > MAX_REASON) return 'no_reason';
  return { set, reason: text };
}

/** The target's database name, for pg_restore -d. Never printed. */
function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Empty: no table in public and no pgboss schema (spec 8.2 step 2). */
async function targetEmpty(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') = 0
        AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') AS empty`,
  );
  return rows[0].empty === true;
}

export async function runRestore(argv: string[], deps: RestoreDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args === 'usage') {
    deps.err(RESTORE_TEXT.usage);
    return 2;
  }
  if (args === 'no_reason') {
    deps.err(RESTORE_TEXT.noReason);
    return 2;
  }
  try {
    // The reason is stored in the audit event: refused like every reason box when it looks like a credential (D75 wording).
    refuseSecrets(args.reason);
  } catch (err) {
    deps.err(err instanceof Error ? err.message : RESTORE_TEXT.noReason);
    return 1;
  }
  try {
    if (!(await targetEmpty(deps.pool))) {
      deps.err(RESTORE_TEXT.notEmpty);
      return 1;
    }
    const result = await withBackupLock(deps.pool, () => restoreLocked(args, deps));
    if (result === 'busy') {
      deps.err(RESTORE_TEXT.busy);
      return 1;
    }
    return result;
  } catch {
    deps.err(OPS_FAILURES.database_unreachable);
    return 1;
  }
}

async function restoreLocked(args: Args, deps: RestoreDeps): Promise<number> {
  const { pool, config } = deps;
  // Checked again under the lock: a second restore into the same target must find it full.
  if (!(await targetEmpty(pool))) {
    deps.err(RESTORE_TEXT.notEmpty);
    return 1;
  }
  // The drill's refusals (spec 8.1 step 1). Protective mode is not one: the target has no state yet.
  const loaded = loadBackupKey(config.backupKeyFile);
  if ('error' in loaded) {
    deps.err(OPS_FAILURES[loaded.error]);
    return 1;
  }
  const key = loaded;
  const chosen = await chooseSet(join(config.backupDir, 'kainow', 'sets'), args.set, null);
  if (!chosen) {
    deps.err(args.set === 'latest' ? RESTORE_TEXT.noSet : RESTORE_TEXT.setNotFound);
    return 1;
  }
  if (chosen.summary.keyId !== key.id) {
    deps.err(RESTORE_TEXT.wrongKey(chosen.summary.keyId));
    return 1;
  }

  // The drill's set checks (spec 8.1 step 2).
  const checked = await checkSet(chosen, key);
  if (!checked.ok) {
    deps.err(
      checked.check === 'set_checksums' ? RESTORE_TEXT.checksumsBad : checked.check === 'decrypt' ? RESTORE_TEXT.manifestBad : RESTORE_TEXT.migrationNewer,
    );
    return 1;
  }
  const manifest = checked.manifest;

  // Space (spec 8.1 step 2a). There is no live database to measure, so the set's database size stands in for it, and the
  // safe floor is the default (the target has no settings yet). The poll during pg_restore is the guard that matters.
  const floor = OPS_DEFAULTS.safeFloorGb * GB;
  const stat = safeStat(deps.statfs, config.dbDataDir);
  if (!stat || stat.free < chosen.summary.databaseBytes * 1.2 + floor + 2 * GB) {
    deps.err(RESTORE_TEXT.noSpace);
    return 1;
  }

  // Restore (spec 8.2 step 4). From here a failure leaves a partial database.
  deps.out(`Restoring backup set ${chosen.name}.`);
  let restored: Awaited<ReturnType<typeof restoreDump>>;
  try {
    restored = await restoreDump(deps, databaseName(config.databaseUrl), join(chosen.dir, SET_FILES.dump), key, floor, { singleTransaction: true });
  } catch {
    restored = 'failed';
  }
  if (restored !== 'ok') {
    deps.err(restored === 'crypto' ? RESTORE_TEXT.decryptFailed : restored === 'space_low' ? RESTORE_TEXT.spaceLow : RESTORE_TEXT.restoreFailed);
    return 1;
  }

  const differ: string[] = [];
  for (const t of manifest.tables) {
    let n: number | null = null;
    try {
      n = Number((await pool.query(`SELECT count(*) AS n FROM ${quoteIdent(t.schema)}.${quoteIdent(t.table)}`)).rows[0].n);
    } catch {
      n = null;
    }
    if (n !== t.rows) differ.push(`${t.schema}.${t.table}`);
  }
  if (differ.length > 0) {
    deps.err(RESTORE_TEXT.rowCounts(differ));
    return 1;
  }
  deps.out(`Row counts match for ${manifest.tables.length} tables.`);

  // After restoring, in one transaction (spec 8.2 step 5).
  const setTime = new Date(chosen.summary.startedAt);
  const now = deps.now();
  let result: Awaited<ReturnType<typeof afterRestore>>;
  try {
    result = await inTransaction(pool, (c) => afterRestore(c, { setTime, setName: chosen.name, reason: args.reason, now, summary: chosen.summary }));
  } catch {
    deps.err(RESTORE_TEXT.afterFailed);
    return 1;
  }
  const ended = Object.values(result.work).reduce((a, b) => a + b, 0);
  deps.out(`Emails not sent: ${result.emails}. Jobs cancelled: ${result.jobs}. Work ended: ${ended}.`);
  deps.out(RESTORE_TEXT.done(setTime));
  if (!deps.protectedKeyPresent) deps.out(RESTORE_TEXT.noProtectedKey);
  deps.out(RESTORE_TEXT.next);
  deps.out(`set ${chosen.name} restored`);
  return 0;
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    try {
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    c.release(broken);
  }
}
