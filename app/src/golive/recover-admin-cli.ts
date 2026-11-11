import { Pool } from 'pg';
import { createCodeSender } from '../auth/code-senders';
import { loadConfig } from '../config';
import { PgBossEmailNudge } from '../email/nudge';
import { runRecoverAdmin } from './recover-admin';

/**
 * Usage: npm run recover-admin -- person@example.org "Display Name" --reason "<why>" [--disable-active-administrators] [--dry-run]
 * Administrator recovery, when no Administrator can sign in. See INSTALL.md, "Recovery custodian".
 */
async function main(): Promise<number> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  // Tells the worker that notices and hold alerts are queued; the worker's own tick sends them otherwise.
  const nudge = new PgBossEmailNudge(config);
  try {
    return await runRecoverAdmin(process.argv.slice(2), {
      pool,
      config,
      sender: createCodeSender(config.email),
      now: new Date(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      nudge,
    });
  } finally {
    await nudge.onApplicationShutdown();
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
