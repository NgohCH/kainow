import { isAbsolute } from 'node:path';
import { Pool } from 'pg';
import { defaultStatfs } from '../ops/storage-check';
import { installUpdate } from './install';
import { prepareUpdate, resolveProjectName } from './prepare';
import { RealRunner, maskSecrets } from './runner';
import { UPDATER_TEXT, runUpdaterCli } from './tick';

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
  const runner = new RealRunner(installDir);
  const now = () => new Date();
  // The running installation's project name, also when COMPOSE_PROJECT_NAME is set only in the folder's .env (which this
  // container's environment does not see): read from Compose's resolved configuration, never logged.
  const projectName = () => resolveProjectName(runner, installDir, process.env, log);
  try {
    return await runUpdaterCli(process.argv.slice(2), {
      pool,
      runner,
      installDir,
      now,
      log,
      prepare: async (u) => void (await prepareUpdate({ pool, runner, installDir, projectName: await projectName(), now, log, statfs: defaultStatfs }, u)),
      // The db container is never restarted by an install (only api, worker and migrate), so this pool's connection,
      // which holds the tick's session lock, stays up throughout.
      install: async (u) => void (await installUpdate({ pool, runner, installDir, projectName: await projectName(), now, log }, u)),
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
