import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { runMigrations } from './migrate';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('go-live schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    userId = await seedUser(pool, 'a@example.org');
  });

  test('the 11 steps are seeded in order, untouched', async () => {
    const { rows } = await pool.query(
      `SELECT key, position, ticked_by, ticked_at, note, skipped FROM golive_steps ORDER BY position`,
    );
    assert.deepEqual(
      rows.map((r) => [r.position, r.key]),
      [
        [1, 'organisation'], [2, 'logos'], [3, 'second_admin'], [4, 'recovery'], [5, 'mailbox'], [6, 'test_email'],
        [7, 'calendar'], [8, 'backups'], [9, 'department'], [10, 'users'], [11, 'project'],
      ],
    );
    for (const r of rows) {
      assert.equal(r.ticked_by, null);
      assert.equal(r.ticked_at, null);
      assert.equal(r.note, null);
      assert.equal(r.skipped, false);
    }
  });

  test('one checklist row, not closed, and no second row', async () => {
    const { rows } = await pool.query(`SELECT id, closed_at FROM golive_checklist`);
    assert.deepEqual(rows, [{ id: 1, closed_at: null }]);
    assert.equal(await sqlState(pool, `INSERT INTO golive_checklist (id) VALUES (2)`), '23514');
  });

  test('a note over 200 characters is rejected', async () => {
    assert.equal(await sqlState(pool, `UPDATE golive_steps SET note = $1 WHERE key = 'recovery'`, ['x'.repeat(201)]), '23514');
    assert.equal(await sqlState(pool, `UPDATE golive_steps SET note = $1 WHERE key = 'recovery'`, ['x'.repeat(200)]), 'ok');
  });

  test('step positions are unique', async () => {
    assert.equal(await sqlState(pool, `UPDATE golive_steps SET position = 1 WHERE key = 'logos'`), '23505');
  });

  test('golive_events is append-only and checks its action', async () => {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO golive_events (id, step_key, action, actor_id, note, at) VALUES ($1, 'recovery', 'ticked', $2, 'n', now())`,
      [id, userId],
    );
    assert.equal(await sqlState(pool, `INSERT INTO golive_events (id, action, at) VALUES ($1, 'closed', now())`, [uuidv7()]), 'ok');
    assert.equal(await sqlState(pool, `INSERT INTO golive_events (id, action, at) VALUES ($1, 'bogus', now())`, [uuidv7()]), '23514');
    assert.notEqual(await sqlState(pool, `UPDATE golive_events SET note = 'x'`), 'ok');
    assert.notEqual(await sqlState(pool, `DELETE FROM golive_events`), 'ok');
  });

  test('notices_from exists and is null', async () => {
    const { rows } = await pool.query(`SELECT notices_from FROM notification_settings`);
    assert.deepEqual(rows, [{ notices_from: null }]);
  });
});
