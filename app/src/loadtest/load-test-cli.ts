import { Pool } from 'pg';
import { runLoadTest } from './run';

/**
 * npm run load-test -- --seed | --users 10 --minutes 30 --api-log <file>. Against a TEST installation only: it refuses any
 * database that is not empty (seed) or not the seeded load-test organisation (run). See docs/operations/load-test.md.
 */
async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL must name the test installation database.');
    return 2;
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  pool.on('error', () => undefined);
  try {
    return await runLoadTest(process.argv.slice(2), {
      pool,
      env: process.env,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      now: () => new Date(),
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error('The load test stopped unexpectedly.');
    process.exit(1);
  },
);
