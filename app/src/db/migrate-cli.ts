import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const result = await runMigrations(pool, config.migrationsDir);
    console.log(`applied: ${result.applied.join(', ') || 'none'}`);
    console.log(`already applied: ${result.skipped.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
