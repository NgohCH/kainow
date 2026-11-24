import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { runMigrations } from './migrate';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

/** The SQLSTATE a statement fails with, or 'ok' when it succeeds. */
async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('interface redesign schema (organisation colour, proposal correction)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
  let itemId: string;

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
    await pool.query(`INSERT INTO users (id, email, display_name, role, status, created_at) VALUES ($1, 'a@example.org', 'A', 'enterprise_administrator', 'active', now())`, [userId]);
    const sourceId = uuidv7();
    const versionId = uuidv7();
    const runId = uuidv7();
    itemId = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at) VALUES ($1, 'T', $2, now())`, [sourceId, userId]);
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'paste', 'Notes.', 'x', 6, $3, now())`,
      [versionId, sourceId, userId],
    );
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [runId, versionId, userId]);
    await pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'question', 'Q?', 'Notes.', 0, 6, 1, now())`,
      [itemId, runId, versionId],
    );
    await pool.query(`INSERT INTO organisation (id, name, updated_at) VALUES (1, 'Example Organisation', now())`);
  });

  const setColour = (colour: string | null) => sqlState(pool, `UPDATE organisation SET colour = $1 WHERE id = 1`, [colour]);

  test('organisation colour is optional lower-case hex', async () => {
    assert.equal(await setColour('#b0182e'), 'ok');
    assert.equal(await setColour(null), 'ok');
    assert.equal(await setColour('#B0182E'), '23514');
    assert.equal(await setColour('red'), '23514');
    assert.equal(await setColour('#b0182'), '23514');
  });

  const insertEdit = (kind: string | null, reason: string | null) =>
    sqlState(
      pool,
      `INSERT INTO extraction_item_edits (id, item_id, text, kind, reason, edited_by, edited_at) VALUES ($1, $2, 'Q?', $3, $4, $5, now())`,
      [uuidv7(), itemId, kind, reason, userId],
    );

  test('an edit may correct the kind, with a reason of 1 to 500 characters', async () => {
    assert.equal(await insertEdit('decision', 'x'.repeat(500)), 'ok');
    assert.equal(await insertEdit(null, null), 'ok');
    assert.equal(await insertEdit('task', 'because'), '23514');
    assert.equal(await insertEdit('decision', 'x'.repeat(501)), '23514');
    assert.equal(await insertEdit('decision', ''), '23514');
  });

  test('a corrected edit row is still append-only', async () => {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO extraction_item_edits (id, item_id, text, kind, reason, edited_by, edited_at) VALUES ($1, $2, 'Q?', 'risk', 'It is a risk', $3, now())`,
      [id, itemId, userId],
    );
    await assert.rejects(pool.query(`UPDATE extraction_item_edits SET reason = 'other' WHERE id = $1`, [id]), /extraction_item_edits is append-only/);
  });
});
