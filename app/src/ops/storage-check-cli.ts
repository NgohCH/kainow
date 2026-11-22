import { Pool } from 'pg';
import { loadOpsConfig } from './config';
import { sourceAreaReading } from './source-files';
import { runStorageCheck } from './storage-check';

/** Usage: npm run storage-check. Run every few minutes by the server's cron in the ops container (spec 7.1). */
async function main(): Promise<number> {
  let config;
  try {
    config = loadOpsConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'The ops settings are incomplete.');
    return 2;
  }
  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', () => undefined);
  try {
    return await runStorageCheck(process.argv.slice(2), {
      pool,
      config,
      now: () => new Date(),
      // Database only: used and quota as the Storage page gets them (no call to the provider from here).
      sourceArea: () => sourceAreaReading(pool),
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
    console.error('The storage check stopped unexpectedly.');
    process.exit(1);
  },
);
