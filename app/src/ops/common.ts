/** Shared scaffolding for the ops commands: the backup-folder lock, fixed failure texts and migration level. */
import { readdirSync } from 'node:fs';
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
 * Runs fn while holding the backup-folder advisory lock (a session lock on one constant key), or returns 'busy' at once
 * when another backup or drill holds it.
 */
export async function withBackupLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T | 'busy'> {
  const client = await pool.connect();
  let broken = false;
  try {
    const got = await client.query(`SELECT pg_try_advisory_lock(hashtext('kainow.backup-folder')) AS ok`);
    if (!got.rows[0].ok) return 'busy';
    try {
      return await fn();
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('kainow.backup-folder'))`);
      } catch {
        broken = true; // the session ends with the connection, which releases the lock
      }
    }
  } finally {
    client.release(broken);
  }
}

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** The highest applied migration, by name as recorded (for example 0032_operations.sql). */
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
