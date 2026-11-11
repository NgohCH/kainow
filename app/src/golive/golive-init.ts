import type { Pool } from 'pg';
import type { CodeSender } from '../auth/tokens';
import type { AppConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SetupService } from '../organisation/setup.service';

export const GOLIVE_INIT_REFUSAL = 'This database already holds users or projects. golive-init only prepares a new, empty database.';
export const GOLIVE_INIT_NOT_KAINOW = "This database holds tables that are not Kainow's. golive-init only prepares a new, empty database.";

/** The operator's way out when the setup email fails: the database is ready, so only a new link is needed. */
export function setupEmailFailed(person: { email: string; displayName: string }): string {
  const args = `${person.email} "${person.displayName}"`;
  return (
    'The database is ready, but the setup email could not be sent: the email service did not accept it. ' +
    `Send a new link with: npm run setup-invite -- ${args} ` +
    `(under Docker Compose: docker compose run --rm api node dist/users/setup-invite-cli.js ${args})`
  );
}

/**
 * A wrong DATABASE_URL must not prepare someone else's database: the public schema must hold no tables at all,
 * or hold Kainow's migrations table.
 */
async function isKainowOrBlank(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS tables, bool_or(c.relname = 'schema_migrations') AS kainow
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
  );
  return rows[0].tables === 0 || rows[0].kainow === true;
}

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
 * Administrator's setup link. Refuses any database that already holds users or projects, or tables of another
 * application. Never deletes anything. If the email fails, the database stays prepared and the error says how to
 * send a new link.
 */
export async function goliveInit(
  pool: Pool,
  config: AppConfig,
  sender: CodeSender,
  migrationsDir: string,
  now: Date,
  person: { email: string; displayName: string },
): Promise<{ link: string; email: string; expiresAt: Date }> {
  if (!(await isKainowOrBlank(pool))) throw new Error(GOLIVE_INIT_NOT_KAINOW);
  if (!(await isEmpty(pool))) throw new Error(GOLIVE_INIT_REFUSAL);
  await runMigrations(pool, migrationsDir);
  if (!(await isEmpty(pool))) throw new Error(GOLIVE_INIT_REFUSAL);
  await pool.query('UPDATE notification_settings SET notices_from = $1 WHERE id = 1', [now]);
  // The invitation is saved before the email goes; only a failure of the email itself is reported this way.
  let sendFailed = false;
  const guarded: CodeSender = {
    send: (email, code, minutes) => sender.send(email, code, minutes),
    sendSetupInvitation: async (email, link, expiresAt, kind) => {
      try {
        await sender.sendSetupInvitation(email, link, expiresAt, kind);
      } catch (err) {
        sendFailed = true;
        throw err;
      }
    },
  };
  try {
    return await new SetupService(pool, config, guarded).issue(person, now);
  } catch (err) {
    // The cause is not printed: a mail server's answer can carry account details.
    if (sendFailed) throw new Error(setupEmailFailed(person));
    throw err;
  }
}
