import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import {
  LOCK_IDLE_SESSION_TIMEOUT,
  SNAPSHOT_IDLE_TIMEOUT,
  TOOL_TIMEOUT_MS,
  codeMigrationLevel,
  currentMigrationLevel,
  withBackupLock,
} from './common';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

describe('ops lock and migration level', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
  });
  after(async () => {
    await pool.end();
  });

  test('a second lock while the first is held is busy, and the lock frees afterwards', async () => {
    const inner = await withBackupLock(pool, async () => withBackupLock(pool, async () => 'ran'));
    assert.equal(inner, 'busy');
    assert.equal(await withBackupLock(pool, async () => 'ran'), 'ran');
  });

  test('the lock is released when fn throws', async () => {
    await assert.rejects(withBackupLock(pool, async () => Promise.reject(new Error('boom'))), /boom/);
    assert.equal(await withBackupLock(pool, async () => 'ok'), 'ok');
  });

  test('R22 backstop: a holder stuck for good loses the lock when the server ends its idle lock session', async () => {
    // A 1-second idle_session_timeout stands in for the 13-hour one. While fn is stuck, the server ends the lock session;
    // another run then gets the lock, and the stuck holder's own exit does not crash on the dropped connection.
    const stuck = withBackupLock(
      pool,
      async () => {
        await sleep(2500);
        return 'late';
      },
      { idleSessionTimeout: '1s' },
    );
    await sleep(1800);
    assert.equal(await withBackupLock(pool, async () => 'second'), 'second', 'the lock went with the ended session');
    assert.equal(await stuck, 'late');
    assert.equal(await withBackupLock(pool, async () => 'third'), 'third');
  });

  test('the lock session goes back to the pool without the idle limit', async () => {
    const solo = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      assert.equal(await withBackupLock(solo, async () => 'ran'), 'ran');
      assert.equal((await solo.query('SHOW idle_session_timeout')).rows[0].idle_session_timeout, '0');
    } finally {
      await solo.end();
    }
  });

  test('the default limits: 6 hours for pg tools, above it for the server-side backstops', () => {
    assert.equal(TOOL_TIMEOUT_MS, 6 * 3_600_000);
    assert.equal(LOCK_IDLE_SESSION_TIMEOUT, '13h');
    assert.equal(SNAPSHOT_IDLE_TIMEOUT, '390min');
  });

  test('current migration level matches the code after migrating', async () => {
    assert.equal(await currentMigrationLevel(pool), codeMigrationLevel());
  });
});
