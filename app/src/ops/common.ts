/** Shared scaffolding for the ops commands: the backup-folder lock, fixed failure texts and migration level. */
import type { ChildProcess } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

/**
 * Fixed failure codes and texts (spec 4.3). Stored and printed instead of raw error output, which can carry paths or
 * connection strings. Texts never contain a path or a port.
 */
export const OPS_FAILURES = {
  folder_missing: 'The backup folder is missing or not mounted.',
  folder_not_writable: 'The backup folder cannot be written.',
  key_missing: 'The backup key file is missing.',
  key_invalid: 'The backup key file is not the right size.',
  key_changed: 'The backup key is not the one used for the last successful backup.',
  no_space: 'The backup folder has run out of space.',
  dump_failed: 'The database copy failed.',
  verify_failed: 'Reading back the backup did not match what was written.',
  source_files_failed: 'Some source files could not be copied.',
  protected_key_missing: 'Source files are in use, but no protected key is available.',
  database_unreachable: 'The database could not be reached.',
  drill_no_space: 'There was not enough space to run the restore drill.',
  drill_space_low: 'Free space ran too low during the restore drill.',
  drill_database_failed: 'The drill could not create or write its temporary database.',
  interrupted: 'The run was interrupted before it finished.',
} as const;

export type FailureCode = keyof typeof OPS_FAILURES;

/**
 * The longest a pg_dump or pg_restore child may run before it is killed and the run recorded failed (R22): the same
 * 6 hours after which the sweep calls a run interrupted (D111).
 */
export const TOOL_TIMEOUT_MS = 6 * 3_600_000;

/**
 * Server-side backstop on the backup-folder lock connection, which is idle by design for the whole run. If the command
 * is stuck where its own 6-hour child limit cannot end it (a process blocked in uninterruptible I/O on a stalled share),
 * PostgreSQL ends the session and the lock goes with it. 13 hours: above a dump plus its read-back (6 hours each at most)
 * with an hour to spare, so a normal run, however slow, never meets it.
 */
export const LOCK_IDLE_SESSION_TIMEOUT = '13h';

/**
 * Server-side backstop on the backup's snapshot connection, idle in its transaction while pg_dump runs. 390 min (6 h 30 min):
 * above the 6-hour pg_dump limit, so it only ends a transaction the command itself failed to end; pg_dump has imported
 * the snapshot long before, so ending it never harms a dump that is still running.
 */
export const SNAPSHOT_IDLE_TIMEOUT = '390min';

/**
 * Kills a child process after `ms` (SIGKILL: a hung tool may ignore a polite signal) and calls onTimeout first.
 * Returns the cancel function, to call once the child is done.
 */
export function killAfter(child: ChildProcess, ms: number, onTimeout: () => void): () => void {
  const timer = setTimeout(() => {
    onTimeout();
    child.kill('SIGKILL');
  }, ms);
  return () => clearTimeout(timer);
}

/**
 * Waits for a child's exit for at most `ms`, so a process stuck past SIGKILL (uninterruptible I/O) cannot hold the run:
 * the run still records its failure and releases the lock.
 */
export function settle<T>(exited: Promise<T>, ms = 30_000): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  return Promise.race([exited, late]).finally(() => clearTimeout(timer));
}

/** Whether two paths are on the same file system (device), as far as can be told; false when either cannot be read. */
export function onSameDisk(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/**
 * Runs fn while holding the backup-folder advisory lock (a session lock on one constant key), or returns 'busy' at once
 * when another backup or drill holds it. The lock connection carries idle_session_timeout (LOCK_IDLE_SESSION_TIMEOUT)
 * while fn runs, so a command stuck for good cannot keep the lock for ever.
 */
export async function withBackupLock<T>(
  pool: Pool,
  fn: () => Promise<T>,
  options: { idleSessionTimeout?: string } = {},
): Promise<T | 'busy'> {
  const client = await pool.connect();
  let broken = false;
  // The backstop ends the session from the server side; without a listener that error would end the process.
  const onError = () => (broken = true);
  client.on('error', onError);
  try {
    const got = await client.query(`SELECT pg_try_advisory_lock(hashtext('kainow.backup-folder')) AS ok`);
    if (!got.rows[0].ok) return 'busy';
    try {
      await client.query(`SELECT set_config('idle_session_timeout', $1, false)`, [options.idleSessionTimeout ?? LOCK_IDLE_SESSION_TIMEOUT]);
      return await fn();
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('kainow.backup-folder'))`);
        await client.query('RESET idle_session_timeout');
      } catch {
        broken = true; // the session ends with the connection, which releases the lock
      }
    }
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** The highest applied migration, by name as recorded (for example 0033_operations.sql). */
export async function currentMigrationLevel(db: Pick<Pool, 'query'>): Promise<string> {
  const r = await db.query('SELECT max(name) AS level FROM schema_migrations');
  return (r.rows[0]?.level as string | null) ?? '';
}

/** The highest migration file this code ships, named the same way, so the two can be compared. */
export function codeMigrationLevel(dir: string = MIGRATIONS_DIR): string {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return files[files.length - 1] ?? '';
}
