import { Pool } from 'pg';
import { loadProtectedKey } from '../quarantine/protected-key';
import { loadOpsConfig } from './config';
import { PgTools } from './pg-tools';
import { RESTORE_TEXT, runRestore } from './restore';
import { defaultStatfs } from './storage-check';

/**
 * Usage: npm run restore -- --set <name>|latest --reason "<why>"
 * Run in the ops container with only the database started (spec 8.2): docker compose up -d db, then this, then
 * docker compose up -d --build. Exit 0 restored, 1 refused or failed, 2 usage.
 */
async function main(): Promise<number> {
  let config;
  try {
    config = loadOpsConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'The ops settings are incomplete.');
    return 2;
  }
  // Only whether the protected key is there matters here; its own log line names a path, so it is replaced.
  let keyProblem = false;
  const protectedKey = loadProtectedKey(config.protectedKeyFile, () => (keyProblem = true));
  if (keyProblem) console.error('The protected key file could not be read.');
  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', () => undefined); // an idle client dropping must not crash the run; the next query reports it
  try {
    return await runRestore(process.argv.slice(2), {
      pool,
      config,
      tools: new PgTools(config.databaseUrl),
      statfs: defaultStatfs,
      now: () => new Date(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      protectedKeyPresent: protectedKey !== null,
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    // Never the raw error: it can carry paths or connection strings.
    console.error(RESTORE_TEXT.unexpected);
    process.exit(1);
  },
);
