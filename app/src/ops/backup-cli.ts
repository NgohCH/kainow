import { Pool } from 'pg';
import { loadProtectedKey } from '../quarantine/protected-key';
import { DbStorageConnectorFactory } from '../storage/connector-factory';
import { runBackup } from './backup';
import { loadOpsConfig } from './config';
import { PgTools } from './pg-tools';
import { StoredSourceFiles } from './source-files';

/**
 * Usage: npm run backup -- [--kind daily|manual|pre_update] [--new-key]
 * Run by the server's cron in the ops container (spec 4.2). Exit 0 succeeded, 1 refused or failed, 2 usage.
 */
async function main(): Promise<number> {
  let config;
  try {
    config = loadOpsConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'The ops settings are incomplete.');
    return 2;
  }
  // The protected key opens the storage connection's secret, so the source area's files can be downloaded (spec 4.1).
  // Its log line is replaced by fixed text: no path.
  let keyProblem = false;
  const protectedKey = loadProtectedKey(config.protectedKeyFile, () => (keyProblem = true));
  if (keyProblem) console.error('The protected key file could not be read; a backup of the source area will fail.');
  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', () => undefined); // an idle client dropping must not crash the run; the next query reports it
  const clock = () => new Date();
  try {
    return await runBackup(process.argv.slice(2), {
      pool,
      config,
      tools: new PgTools(config.databaseUrl),
      // Used only once a source area is in use (an approved one, or files stored in it); otherwise nothing is read.
      sourceFiles: new StoredSourceFiles(new DbStorageConnectorFactory(pool, clock, protectedKey), protectedKey !== null),
      now: clock,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    // Never the raw error: it can carry paths or connection strings.
    console.error('The backup command stopped unexpectedly.');
    process.exit(1);
  },
);
