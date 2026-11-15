import { Pool } from 'pg';
import { backfillPassages } from './passage-index';

/**
 *   DATABASE_URL=postgres://... npm run backfill-passages
 *
 * Indexes every existing source version and message version that has no passages yet. Safe to run again.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to the migrated database.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  try {
    const r = await backfillPassages(pool, (m) => console.log(m));
    console.log(`done: ${r.versions} versions, ${r.passages} passages, ${r.ms} ms`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
