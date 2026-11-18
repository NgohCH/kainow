import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { MVP_SPEND_SETTINGS } from './mvp-settings';
import { SpendSettingsService, describeSettings } from './spend.settings';

/** The reason recorded with the settings this command saves (spec 7.1: every change carries a reason). */
export const INSTALL_REASON = 'Initial settings saved by the install command (npm run apply-mvp-spend-settings).';

/**
 * Usage: npm run apply-mvp-spend-settings. Saves the values approved in docs/MVP-DECISIONS.md when no settings are saved
 * yet. Run again, it changes nothing: delegation, the ceiling and the policy an Administrator has set since are kept.
 */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: loadDatabaseConfig().databaseUrl });
  try {
    if (await new SpendSettingsService(pool, () => new Date()).insertIfAbsent(MVP_SPEND_SETTINGS, null, INSTALL_REASON)) {
      console.log('Saved the approved MVP spend settings:');
      console.log(JSON.stringify(describeSettings(MVP_SPEND_SETTINGS), null, 2));
    } else {
      console.log('Spend settings are already saved; nothing was changed. Change them in Administrator › AI.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
