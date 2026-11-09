import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
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

describe('organisation schema', { skip: SKIP_NO_DB }, () => {
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
    userId = uuidv7();
    await pool.query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, 'a@example.org', 'A', 'enterprise_administrator')`, [userId]);
  });

  test('a second organisation row is refused', async () => {
    const add = (id: number) => sqlState(pool, `INSERT INTO organisation (id, name, updated_by, updated_at) VALUES ($1, 'Example Organisation', $2, now())`, [id, userId]);
    assert.equal(await add(1), 'ok');
    assert.equal(await add(2), '23514');
  });

  test('only one setup invitation may be open', async () => {
    const add = () =>
      sqlState(
        pool,
        `INSERT INTO setup_invitations (id, user_id, email, token_hash, created_at, expires_at) VALUES ($1, $2, 'a@example.org', $3, now(), now() + interval '7 days')`,
        [uuidv7(), userId, uuidv7()],
      );
    assert.equal(await add(), 'ok');
    assert.equal(await add(), '23505');
    await pool.query(`UPDATE setup_invitations SET superseded_at = now()`);
    assert.equal(await add(), 'ok');
  });

  test('a logo over 512 KB is refused', async () => {
    const add = (size: number) =>
      sqlState(
        pool,
        `INSERT INTO organisation_logos (shape, content, mime, width, height, byte_size, uploaded_by, uploaded_at) VALUES ('square', '\\x00', 'image/png', 64, 64, $1, $2, now())`,
        [size, userId],
      );
    assert.equal(await add(524289), '23514');
    assert.equal(await add(524288), 'ok');
  });
});
