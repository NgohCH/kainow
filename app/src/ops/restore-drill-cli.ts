import { Pool } from 'pg';
import { loadProtectedKey } from '../quarantine/protected-key';
import { loadOpsConfig } from './config';
import { runRestoreDrill } from './drill';
import { PgTools } from './pg-tools';
import { defaultStatfs } from './storage-check';

/**
 * Usage: npm run restore-drill -- [--set <name>|latest] [--keep] [--sample <n>] | --drop <kainow_drill_name>
 * Run by the server's cron in the ops container (spec 4.2, 8.1). Exit 0 passed, 1 refused or failed, 2 usage.
 */
async function main(): Promise<number> {
  let config;
  try {
    config = loadOpsConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'The ops settings are incomplete.');
    return 2;
  }
  // The protected key opens sealed values in the drill database (step 7). Its log line is replaced by fixed text: no path.
  let keyProblem = false;
  const protectedKey = loadProtectedKey(config.protectedKeyFile, () => (keyProblem = true));
  if (keyProblem) console.error('The protected key file could not be read; sealed values present are counted as failed.');
  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', () => undefined); // an idle client dropping must not crash the run; the next query reports it
  try {
    return await runRestoreDrill(process.argv.slice(2), {
      pool,
      config,
      tools: new PgTools(config.databaseUrl),
      statfs: defaultStatfs,
      now: () => new Date(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      protectedKey,
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    // Never the raw error: it can carry paths or connection strings.
    console.error('The restore drill stopped unexpectedly.');
    process.exit(1);
  },
);
