import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';
import { BENCH_ENTRIES, BENCH_PEOPLE, BENCH_PROJECTS, nearestRank, runAiBench, seedAiBench } from './bench-cli';

describe('AI bench guard', () => {
  test('bench refuses a database not ending in _bench', async () => {
    for (const name of ['kainow', 'kainow_test', 'kainow_benchmark', 'postgres']) {
      await assert.rejects(runAiBench(`postgres://postgres:s3cret-pass@127.0.0.1:1/${name}`), (e: Error) => /must end in _bench/.test(e.message) && !e.message.includes('s3cret-pass'), name);
    }
  });

  test('nearest-rank percentile', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(nearestRank(xs, 0.5), 50);
    assert.equal(nearestRank(xs, 0.95), 95);
    assert.equal(nearestRank(xs, 1), 100);
    assert.equal(nearestRank([5, 1, 3], 0.5), 3);
  });
});

describe('AI bench seeding on a throwaway _bench database', { skip: SKIP_NO_DB }, () => {
  const name = `kainow_ai_${process.pid}_bench`;
  let admin: Pool;
  let pool: Pool;

  before(async () => {
    const base = new URL(testDatabaseUrl() as string);
    admin = new Pool({ connectionString: base.toString() });
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    base.pathname = `/${name}`;
    pool = new Pool({ connectionString: base.toString() });
    await runMigrations(pool, join(__dirname, '..', '..', 'migrations'));
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin?.end();
  });

  test('bench seeds 200,000 entries over 50 projects and 400 people', async () => {
    await seedAiBench(pool, () => undefined);
    assert.equal(BENCH_ENTRIES, 200_000);
    assert.equal(BENCH_PROJECTS, 50);
    assert.equal(BENCH_PEOPLE, 400);
    const q = async (sql: string) => (await pool.query(sql)).rows[0].n as number;
    assert.equal(await q(`SELECT count(*)::int AS n FROM ai_spend_entries`), 200_000);
    assert.equal(await q(`SELECT count(DISTINCT project_id)::int AS n FROM ai_spend_entries`), 50);
    assert.equal(await q(`SELECT count(DISTINCT actor_user_id)::int AS n FROM ai_spend_entries`), 400);
    assert.equal(await q(`SELECT count(*)::int AS n FROM project_ai_limits WHERE daily_mode = 'limit' AND user_monthly_mode = 'limit'`), 50);
  });

  test('seeding twice does not seed twice', async () => {
    await seedAiBench(pool, () => undefined);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ai_spend_entries`)).rows[0].n, 200_000);
  });
});
