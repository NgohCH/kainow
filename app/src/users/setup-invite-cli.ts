import { Pool } from 'pg';
import { createCodeSender } from '../auth/code-senders';
import { loadConfig } from '../config';
import { SetupService } from '../organisation/setup.service';

/**
 * Usage: npm run setup-invite -- person@example.org "Display Name"
 * Emails a one-time link that makes the first Enterprise Administrator. Refused once an Administrator is active.
 */
async function main(): Promise<void> {
  const [email, displayName] = process.argv.slice(2);
  if (!email || !displayName) throw new Error('Usage: npm run setup-invite -- <email> "<display name>"');
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const setup = new SetupService(pool, config, createCodeSender(config.email));
    const sent = await setup.issue({ email, displayName }, new Date());
    console.log(`Setup invitation sent to ${sent.email}. It expires on ${sent.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
