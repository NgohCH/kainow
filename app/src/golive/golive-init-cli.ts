import { Pool } from 'pg';
import { createCodeSender } from '../auth/code-senders';
import { loadConfig } from '../config';
import { goliveInit } from './golive-init';

/**
 * Usage: npm run golive-init -- person@example.org "Display Name"
 * Prepares a new, empty database for go-live and emails the first Administrator's setup link.
 */
async function main(): Promise<void> {
  const [email, displayName] = process.argv.slice(2);
  if (!email || !displayName) throw new Error('Usage: npm run golive-init -- <email> "<display name>"');
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const sent = await goliveInit(pool, config, createCodeSender(config.email), config.migrationsDir, new Date(), { email, displayName });
    console.log(`Setup invitation sent to ${sent.email}. It expires on ${sent.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
    console.log('Open the link in the email to start the go-live checklist.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
