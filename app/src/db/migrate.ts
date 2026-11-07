import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

/** Arbitrary constant so only one process migrates at a time. */
const MIGRATION_LOCK_KEY = 7201107;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies SQL files named NNNN_description.sql in order. Each file runs in its own transaction
 * and its checksum is recorded. A file that was already applied but has since changed, or an
 * applied file that is missing from disk, stops the run: history is not silently rewritten.
 */
export async function runMigrations(pool: Pool, dir: string): Promise<MigrationResult> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text PRIMARY KEY,
         checksum   text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const name of done.keys()) {
      if (!files.includes(name)) {
        throw new Error(`Applied migration ${name} is missing from ${dir}`);
      }
    }

    const result: MigrationResult = { applied: [], skipped: [] };
    for (const name of files) {
      // Line ends are not part of the migration: a Windows checkout (CRLF) and a Linux one (LF) are the same file.
      const sql = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(name);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${name} was changed after it was applied`);
        }
        result.skipped.push(name);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
      }
      result.applied.push(name);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
