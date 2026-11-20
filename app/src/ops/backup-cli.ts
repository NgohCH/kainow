import { Pool } from 'pg';
import { runBackup } from './backup';
import { loadOpsConfig } from './config';
import { PgTools } from './pg-tools';

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
  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', () => undefined); // an idle client dropping must not crash the run; the next query reports it
  try {
    return await runBackup(process.argv.slice(2), {
      pool,
      config,
      tools: new PgTools(config.databaseUrl),
      now: () => new Date(),
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
