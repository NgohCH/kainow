import { Pool } from 'pg';
import { createCodeSender } from '../auth/code-senders';
import { loadConfig } from '../config';
import { runRecoverAdmin } from './recover-admin';

/**
 * Usage: npm run recover-admin -- person@example.org "Display Name" --reason "<why>" [--dry-run]
 * Administrator recovery: only when no Enterprise Administrator is active. See INSTALL.md, "Recovery custodian".
 */
async function main(): Promise<number> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    return await runRecoverAdmin(process.argv.slice(2), {
      pool,
      config,
      sender: createCodeSender(config.email),
      now: new Date(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } finally {
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
