import type { Pool } from 'pg';
import type { CodeSender } from '../auth/tokens';
import type { AppConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SetupService } from '../organisation/setup.service';

export const GOLIVE_INIT_REFUSAL = 'This database already holds users or projects. golive-init only prepares a new, empty database.';

/** True when the table is missing (a brand-new database) or holds no rows. */
async function emptyOrMissing(pool: Pool, table: 'users' | 'projects'): Promise<boolean> {
  const exists = (await pool.query(`SELECT to_regclass($1) AS t`, [`public.${table}`])).rows[0].t;
  if (!exists) return true;
  return (await pool.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount === 0;
}

async function isEmpty(pool: Pool): Promise<boolean> {
  return (await emptyOrMissing(pool, 'users')) && (await emptyOrMissing(pool, 'projects'));
}

/**
 * Prepares a new, empty database for go-live: migrates it, starts notices from `now` and emails the first
 * Administrator's setup link. Refuses any database that already holds users or projects. Never deletes anything.
 */
export async function goliveInit(
  pool: Pool,
  config: AppConfig,
  sender: CodeSender,
  migrationsDir: string,
  now: Date,
  person: { email: string; displayName: string },
): Promise<{ link: string; email: string; expiresAt: Date }> {
  if (!(await isEmpty(pool))) throw new Error(GOLIVE_INIT_REFUSAL);
  await runMigrations(pool, migrationsDir);
  if (!(await isEmpty(pool))) throw new Error(GOLIVE_INIT_REFUSAL);
  await pool.query('UPDATE notification_settings SET notices_from = $1 WHERE id = 1', [now]);
  return new SetupService(pool, config, sender).issue(person, now);
}
