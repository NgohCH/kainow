import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { releaseSlot, takeSlot, waitForSlot } from './slots';

describe('ai call slots', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
  });

  test('limit 1: a second holder gets null until the first releases', async () => {
    const a = await takeSlot(pool, 'req-a:1', 1, 60_000);
    assert.equal(a, 1);
    assert.equal(await takeSlot(pool, 'req-b:1', 1, 60_000), null);
    await releaseSlot(pool, a as number, 'req-a:1');
    assert.equal(await takeSlot(pool, 'req-b:1', 1, 60_000), 1);
  });

  test('limit 2 with 10 rows uses only slots 1-2', async () => {
    assert.equal(await takeSlot(pool, 'h1:1', 2, 60_000), 1);
    assert.equal(await takeSlot(pool, 'h2:1', 2, 60_000), 2);
    assert.equal(await takeSlot(pool, 'h3:1', 2, 60_000), null);
  });

  test('an expired lease is taken over; a live lease is not', async () => {
    assert.equal(await takeSlot(pool, 'crashed:1', 1, 60_000), 1);
    assert.equal(await takeSlot(pool, 'next:1', 1, 60_000), null);
    await pool.query(`UPDATE ai_call_slots SET leased_until = now() - interval '1 second' WHERE slot = 1`);
    assert.equal(await takeSlot(pool, 'next:1', 1, 60_000), 1);
    const { rows } = await pool.query(`SELECT holder FROM ai_call_slots WHERE slot = 1`);
    assert.equal(rows[0].holder, 'next:1');
  });

  test('release by another holder changes nothing', async () => {
    assert.equal(await takeSlot(pool, 'a:1', 1, 60_000), 1);
    await releaseSlot(pool, 1, 'someone-else:1');
    assert.equal(await takeSlot(pool, 'b:1', 1, 60_000), null);
    const { rows } = await pool.query(`SELECT holder FROM ai_call_slots WHERE slot = 1`);
    assert.equal(rows[0].holder, 'a:1');
  });

  test('waitForSlot returns null after maxWaitMs with a fake sleep', async () => {
    await takeSlot(pool, 'a:1', 1, 60_000);
    const sleeps: number[] = [];
    const got = await waitForSlot(pool, 'b:1', async () => 1, 60_000, {
      maxWaitMs: 5_000,
      pollMs: 1_000,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    assert.equal(got, null);
    assert.equal(sleeps.length, 5);
  });

  test('waitForSlot takes a slot freed during the wait and re-reads the limit each poll', async () => {
    await takeSlot(pool, 'a:1', 1, 60_000);
    let limit = 1;
    let polls = 0;
    const got = await waitForSlot(pool, 'b:1', async () => limit, 60_000, {
      maxWaitMs: 10_000,
      pollMs: 1_000,
      sleep: async () => {
        polls += 1;
        if (polls === 2) limit = 2;
      },
    });
    assert.equal(got, 2);
  });

  test('two pools racing for one slot: exactly one wins', async () => {
    const poolB = new Pool({ connectionString: testDatabaseUrl() });
    try {
      for (let i = 0; i < 20; i += 1) {
        await pool.query(`UPDATE ai_call_slots SET holder = NULL, leased_until = NULL`);
        const [x, y] = await Promise.all([takeSlot(pool, `x${i}:1`, 1, 60_000), takeSlot(poolB, `y${i}:1`, 1, 60_000)]);
        assert.equal([x, y].filter((v) => v === 1).length, 1);
        assert.equal([x, y].filter((v) => v === null).length, 1);
      }
    } finally {
      await poolB.end();
    }
  });
});
