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

describe('due dates and alternatives schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
  let versionId: string;
  let runId: string;

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
    versionId = uuidv7();
    runId = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at) VALUES ($1, 'T', $2, now())`, [sourceId, userId]);
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'paste', 'Notes.', 'x', 6, $3, now())`,
      [versionId, sourceId, userId],
    );
    await pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`,
      [runId, versionId, userId],
    );
  });

  async function insertItem(extra: { dueEvent?: string; alternatives?: string[] } = {}): Promise<string> {
    const id = uuidv7();
    if (extra.dueEvent === undefined && extra.alternatives === undefined) {
      await pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
         VALUES ($1, $2, $3, 0, 'question', 'Q?', 'Notes.', 0, 6, 1, now())`,
        [id, runId, versionId],
      );
    } else {
      await pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, due_event, alternatives, created_at)
         VALUES ($1, $2, $3, 0, 'question', 'Q?', 'Notes.', 0, 6, 1, $4, $5, now())`,
        [id, runId, versionId, extra.dueEvent ?? null, extra.alternatives ?? []],
      );
    }
    return id;
  }

  test("a new item's due_event and alternatives cannot be changed", async () => {
    const id = await insertItem({ dueEvent: 'after approval', alternatives: ['A', 'B'] });
    assert.equal(await sqlState(pool, `UPDATE extraction_items SET due_event = 'x' WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `UPDATE extraction_items SET alternatives = '{C}' WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `UPDATE extraction_items SET review_status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, userId]), 'ok');
  });

  test('meeting dates are append-only', async () => {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO source_version_meeting_dates (id, source_version_id, meeting_date, set_by, set_at) VALUES ($1, $2, '2026-11-04', $3, now())`,
      [id, versionId, userId],
    );
    assert.equal(await sqlState(pool, `UPDATE source_version_meeting_dates SET meeting_date = '2026-11-05' WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM source_version_meeting_dates WHERE id = $1`, [id]), '23001');
  });

  test('a reviewer due is dates or an event, not both', async () => {
    const itemId = await insertItem();
    const edit = (earliest: string | null, latest: string | null, event: string | null) =>
      sqlState(
        pool,
        `INSERT INTO extraction_item_edits (id, item_id, text, due_earliest, due_latest, due_event, edited_by, edited_at)
         VALUES ($1, $2, 'Q?', $3, $4, $5, $6, now())`,
        [uuidv7(), itemId, earliest, latest, event, userId],
      );
    assert.equal(await edit('2026-11-10', '2026-11-12', 'approval'), '23514');
    assert.equal(await edit('2026-11-12', '2026-11-10', null), '23514');
    assert.equal(await edit(null, '2026-11-10', null), '23514');
    assert.equal(await edit('2026-11-10', '2026-11-12', null), 'ok');
    assert.equal(await edit(null, null, 'approval'), 'ok');
  });

  test('rows from before the migration load with empty new fields', async () => {
    const id = await insertItem();
    const { rows } = await pool.query(`SELECT due_event, alternatives FROM extraction_items WHERE id = $1`, [id]);
    assert.equal(rows[0].due_event, null);
    assert.deepEqual(rows[0].alternatives, []);
    const run = await pool.query(`SELECT meeting_date FROM extraction_runs WHERE id = $1`, [runId]);
    assert.equal(run.rows[0].meeting_date, null);
  });
});
