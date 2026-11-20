import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { codeMigrationLevel, currentMigrationLevel, withBackupLock } from './common';

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

  test('current migration level matches the code after migrating', async () => {
    assert.equal(await currentMigrationLevel(pool), codeMigrationLevel());
  });
});
