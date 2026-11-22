import { Pool } from 'pg';
import { loadProtectedKey } from '../quarantine/protected-key';
import { DbStorageConnectorFactory } from '../storage/connector-factory';
import { makeStorageNotify } from '../storage/notices';
import { loadOpsConfig } from './config';
import { runRestoreSourceFiles } from './source-files';

/**
 * Usage: npm run restore-source-files
 * After a restore, when the source area itself was lost (spec 8.2 step 6): puts every stored source file that is Missing
 * at its recorded place back into the approved source area from the backup folder's file store, and lists those it
 * cannot find there. Run in the ops container, which has the backup key, the protected key and network access to the
 * storage provider. Exit 0 every missing file put back (or none missing), 1 refused or some not put back, 2 usage.
 */
async function main(): Promise<number> {
  let config;
  try {
    config = loadOpsConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'The ops settings are incomplete.');
    return 2;
  }
  // The storage connection's secret is sealed with the protected key. Its log line is replaced by fixed text: no path.
  let keyProblem = false;
  const protectedKey = loadProtectedKey(config.protectedKeyFile, () => (keyProblem = true));
  if (keyProblem) console.error('The protected key file could not be read; the source area cannot be reached without it.');
  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', () => undefined);
  const clock = () => new Date();
  try {
    return await runRestoreSourceFiles(process.argv.slice(2), {
      pool,
      config,
      storage: {
        pool,
        connectors: new DbStorageConnectorFactory(pool, clock, protectedKey),
        key: protectedKey,
        clock,
        notify: makeStorageNotify(pool, clock),
        log: () => undefined,
      },
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
    console.error('restore-source-files stopped unexpectedly.');
    process.exit(1);
  },
);
