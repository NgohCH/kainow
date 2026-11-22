import { isAbsolute } from 'node:path';
import { Pool } from 'pg';
import { RealRunner, maskSecrets } from './runner';
import { UPDATER_TEXT, runUpdaterCli, type TickUpdate } from './tick';

/**
 * Usage: node dist/updater/updater-cli.js tick | recover [--yes]
 * Run in the updater container (compose.yaml, profile updater): `tick` by the server's cron every five minutes
 * (10b spec 5.2), `recover` by the operator after a failed update (spec 5.9).
 * Exit 0 done, 1 failed, 2 usage or settings missing.
 */
async function main(): Promise<number> {
  const log = (line: string) => console.log(`${new Date().toISOString()} ${maskSecrets(line)}`);
  const databaseUrl = process.env.DATABASE_URL;
  const installDir = process.env.KAINOW_INSTALL_DIR;
  if (!databaseUrl || !installDir || !isAbsolute(installDir)) {
    log('DATABASE_URL and KAINOW_INSTALL_DIR (an absolute path) must be set; run this through compose.yaml.');
    log(UPDATER_TEXT.usage);
    return 2;
  }
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on('error', () => undefined); // an idle client dropping must not crash the run; the next query reports it
  // Preparing (Task 8) and installing (Task 9) are not in this version yet.
  const notYet = (what: string) => async (u: TickUpdate) => log(`${what} the update to ${u.tag} is not available in this version yet.`);
  try {
    return await runUpdaterCli(process.argv.slice(2), {
      pool,
      runner: new RealRunner(installDir),
      installDir,
      now: () => new Date(),
      log,
      prepare: notYet('Preparing'),
      install: notYet('Installing'),
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    // Never the raw error: it can carry paths or connection strings.
    console.error('The updater command stopped unexpectedly.');
    process.exit(1);
  },
);
