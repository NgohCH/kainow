import { Pool } from 'pg';
import { runningVersion } from '../common/version';
import { codeMigrationLevel, currentMigrationLevel } from '../ops/common';
import { runPostCheck } from './install';

/**
 * Usage: node dist/updater/post-check-cli.js --expect X.Y.Z
 * Run by the updater in a one-off `api` container after an update (10b spec 5.5 step 8): exit 0 only when the database's
 * migration level equals this code's and this code's version is X.Y.Z; 1 otherwise (or the database could not be read);
 * 2 usage.
 */
async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL must be set; run this through compose.yaml.');
    return 2;
  }
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on('error', () => undefined);
  try {
    return await runPostCheck(process.argv.slice(2), {
      migrationLevel: () => currentMigrationLevel(pool),
      codeLevel: () => codeMigrationLevel(),
      version: runningVersion,
      log: (line) => console.log(line),
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    // Never the raw error: it can carry connection strings.
    console.error('The post-update check could not read the database.');
    process.exit(1);
  },
);
