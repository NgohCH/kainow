import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { MVP_SPEND_SETTINGS } from './mvp-settings';
import { SpendSettingsService, describeSettings } from './spend.settings';

/** Usage: npm run apply-mvp-spend-settings. Saves the values approved in docs/MVP-DECISIONS.md. */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: loadDatabaseConfig().databaseUrl });
  try {
    await new SpendSettingsService(pool, () => new Date()).apply(MVP_SPEND_SETTINGS, null);
    console.log('Saved the approved MVP spend settings:');
    console.log(JSON.stringify(describeSettings(MVP_SPEND_SETTINGS), null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
