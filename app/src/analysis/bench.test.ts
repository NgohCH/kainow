import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Pool } from 'pg';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';
import { assertBenchDatabase, runBench, seedBench } from './bench-cli';

describe('bench seeding guard', () => {
  test('accepts only databases whose name ends in _bench', () => {
    assert.equal(assertBenchDatabase('postgres://postgres:x@127.0.0.1:55432/kainow_bench'), 'kainow_bench');
    for (const name of ['kainow', 'kainow_test', 'kainow_prod', 'kainow_test_old', 'kainow_benchmark', 'postgres', 'test', '']) {
      assert.throws(() => assertBenchDatabase(`postgres://postgres:x@127.0.0.1:55432/${name}`), /must end in _bench/, name);
    }
    assert.throws(() => assertBenchDatabase('not a url'), /must end in _bench|DATABASE_URL/);
  });

  test('the refusal never prints the password and happens before any connection is made', async () => {
    await assert.rejects(
      runBench('postgres://postgres:s3cret-pass@127.0.0.1:1/kainow'),
      (err: Error) => /must end in _bench/.test(err.message) && !err.message.includes('s3cret-pass'),
    );
  });
});

describe('bench seeding on a test database', { skip: SKIP_NO_DB }, () => {
  test('seedBench refuses a _test database before writing anything (I6)', async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl() });
    try {
      await pool.query(`DROP TABLE IF EXISTS bench_meta`);
      await assert.rejects(seedBench(pool, () => undefined), /must end in _bench/);
      assert.equal((await pool.query(`SELECT to_regclass('bench_meta') AS t`)).rows[0].t, null, 'no table was created');
    } finally {
      await pool.end();
    }
  });
});

describe('probe-minutes message parsing', () => {
  test('blocks separated by a blank line are messages; "Name: " marks the author', async () => {
    const { parseMessages } = await import('./probe-minutes-cli');
    const [a, b, c] = parseMessages('Ada Member: We ship on Friday.\n\nSaya setuju.\r\n\r\n\r\nSam: Priya sends the budget by 20 November.\n');
    assert.deepEqual([a.no, a.authorName, a.body], [1, 'Ada Member', 'We ship on Friday.']);
    assert.deepEqual([b.no, b.authorName, b.body], [2, 'Participant', 'Saya setuju.']);
    assert.deepEqual([c.no, c.authorName, c.body], [3, 'Sam', 'Priya sends the budget by 20 November.']);
  });
});
