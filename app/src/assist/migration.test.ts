import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('migration 0026 (ai assist)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
  let projectId: string;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    userId = await seedUser(pool, 'ada@example.org');
    projectId = await seedProject(pool, { status: 'active', members: [{ userId, role: 'pm' }] });
  });

  async function passage(body = 'We decided the vendor'): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body)
       VALUES ($1, $2, 'source_version', $3, 0, '§Decisions, paragraph 1', 0, $4, $5)`,
      [id, projectId, uuidv7(), body.length, body],
    );
    return id;
  }

  async function request(kind = 'question'): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at)
       VALUES ($1, $2, $3, $4, 'queued', 'personal', now())`,
      [id, projectId, kind, userId],
    );
    return id;
  }

  test('passages are immutable', async () => {
    const id = await passage();
    assert.equal(await sqlState(pool, `UPDATE passages SET body = 'x' WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM passages WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `TRUNCATE passages CASCADE`), '23001');
    assert.equal(
      await sqlState(
        pool,
        `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body)
         VALUES ($1, $2, 'message_version', $3, 0, 'm', 0, 1, 'x')`,
        [uuidv7(), projectId, uuidv7()],
      ),
      'ok',
    );
    assert.equal(
      await sqlState(
        pool,
        `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body)
         VALUES ($1, $2, 'record', $3, 0, 'm', 0, 1, 'x')`,
        [uuidv7(), projectId, uuidv7()],
      ),
      '23514',
    );
  });

  test('generated vectors stem English and keep exact words', async () => {
    const id = await passage('We decided the vendor');
    const english = await pool.query(`SELECT 1 FROM passages WHERE id = $1 AND english @@ to_tsquery('english', 'deciding')`, [id]);
    assert.equal(english.rowCount, 1);
    const simple = await pool.query(`SELECT 1 FROM passages WHERE id = $1 AND simple @@ to_tsquery('simple', 'vendor')`, [id]);
    assert.equal(simple.rowCount, 1);
    const none = await pool.query(`SELECT 1 FROM passages WHERE id = $1 AND simple @@ to_tsquery('simple', 'decision')`, [id]);
    assert.equal(none.rowCount, 0);
  });

  test('report_draft_versions and summary_versions are immutable', async () => {
    const reqId = await request('report');
    const draftId = uuidv7();
    await pool.query(
      `INSERT INTO report_drafts (id, project_id, kind, title, created_by, created_at) VALUES ($1, $2, 'status', 'Status', $3, now())`,
      [draftId, projectId, userId],
    );
    const versionId = uuidv7();
    await pool.query(
      `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, request_id, created_at) VALUES ($1, $2, 1, 'ai', 'Body', $3, now())`,
      [versionId, draftId, reqId],
    );
    assert.equal(await sqlState(pool, `UPDATE report_draft_versions SET body = 'x' WHERE id = $1`, [versionId]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM report_draft_versions WHERE id = $1`, [versionId]), '23001');
    // ai needs a request, human needs an author, version numbers are unique.
    assert.equal(
      await sqlState(pool, `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, created_at) VALUES ($1, $2, 2, 'ai', 'B', now())`, [uuidv7(), draftId]),
      '23514',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, created_at) VALUES ($1, $2, 2, 'human', 'B', now())`, [uuidv7(), draftId]),
      '23514',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, created_by, created_at) VALUES ($1, $2, 1, 'human', 'B', $3, now())`, [uuidv7(), draftId, userId]),
      '23505',
    );

    const aud = uuidv7();
    await pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'restricted', now())`, [aud, projectId]);
    const sourceId = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id, audience_id) VALUES ($1, 'Restricted', $2, now(), $3, $4)`, [sourceId, userId, projectId, aud]);
    const summaryId = uuidv7();
    await pool.query(
      `INSERT INTO summaries (id, project_id, original_source_id, intended_audience, created_by, created_at) VALUES ($1, $2, $3, '{"mode":"project"}', $4, now())`,
      [summaryId, projectId, sourceId, userId],
    );
    const svId = uuidv7();
    await pool.query(
      `INSERT INTO summary_versions (id, summary_id, version_no, origin, body, request_id, created_at) VALUES ($1, $2, 1, 'ai', 'S', $3, now())`,
      [svId, summaryId, await request('summary')],
    );
    assert.equal(await sqlState(pool, `UPDATE summary_versions SET body = 'x' WHERE id = $1`, [svId]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM summary_versions WHERE id = $1`, [svId]), '23001');

    // Exactly one original.
    assert.equal(
      await sqlState(pool, `INSERT INTO summaries (id, project_id, intended_audience, created_by, created_at) VALUES ($1, $2, '{}', $3, now())`, [uuidv7(), projectId, userId]),
      '23514',
    );

    // Marks: only intended_* may change, and only once.
    await pool.query(`INSERT INTO summary_marks (version_id, phrase, kind) VALUES ($1, 'Project Falcon', 'name')`, [svId]);
    assert.equal(await sqlState(pool, `UPDATE summary_marks SET phrase = 'x' WHERE version_id = $1`, [svId]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM summary_marks WHERE version_id = $1`, [svId]), '23001');
    assert.equal(await sqlState(pool, `UPDATE summary_marks SET intended_by = $2, intended_at = now() WHERE version_id = $1`, [svId, userId]), 'ok');
    assert.equal(await sqlState(pool, `UPDATE summary_marks SET intended_by = $2, intended_at = now() WHERE version_id = $1`, [svId, userId]), '23001');
  });

  test('ai_assist_events is append-only', async () => {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, at) VALUES ($1, $2, $3, 'asked', 'request', $4, now())`,
      [id, projectId, userId, uuidv7()],
    );
    assert.equal(await sqlState(pool, `UPDATE ai_assist_events SET reason = 'x' WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM ai_assist_events WHERE id = $1`, [id]), '23001');
    assert.equal(
      await sqlState(pool, `INSERT INTO ai_assist_events (id, project_id, action, target_kind, target_id, at) VALUES ($1, $2, 'bogus', 'request', $3, now())`, [uuidv7(), projectId, uuidv7()]),
      '23514',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO ai_assist_events (id, project_id, action, target_kind, target_id, at) VALUES ($1, $2, 'summary_confirmed', 'summary', $3, now())`, [uuidv7(), projectId, uuidv7()]),
      'ok',
    );
  });

  test('ai_request_material allows only cited and dropped_at_start to change', async () => {
    const reqId = await request();
    const pid = await passage();
    await pool.query(`INSERT INTO ai_request_material (request_id, ordinal, marker, passage_id, location) VALUES ($1, 1, '[1]', $2, 'loc')`, [reqId, pid]);
    await pool.query(
      `INSERT INTO ai_request_material (request_id, ordinal, marker, record_kind, record_id, snapshot, location) VALUES ($1, 2, '[2]', 'task', $2, 'Task: x', 'Task')`,
      [reqId, uuidv7()],
    );
    assert.equal(await sqlState(pool, `UPDATE ai_request_material SET cited = true, dropped_at_start = true WHERE request_id = $1`, [reqId]), 'ok');
    assert.equal(await sqlState(pool, `UPDATE ai_request_material SET marker = '[9]' WHERE request_id = $1 AND ordinal = 1`, [reqId]), '23001');
    assert.equal(await sqlState(pool, `UPDATE ai_request_material SET snapshot = 'changed' WHERE request_id = $1 AND ordinal = 2`, [reqId]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM ai_request_material WHERE request_id = $1`, [reqId]), '23001');
    // Exactly one of passage / record.
    assert.equal(
      await sqlState(pool, `INSERT INTO ai_request_material (request_id, ordinal, marker, location) VALUES ($1, 3, '[3]', 'l')`, [reqId]),
      '23514',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO ai_request_material (request_id, ordinal, marker, passage_id, record_kind, record_id, snapshot, location) VALUES ($1, 4, '[4]', $2, 'task', $3, 's', 'l')`, [reqId, pid, uuidv7()]),
      '23514',
    );
  });

  test('a summary source needs no thread', async () => {
    const aud = uuidv7();
    await pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'project', now())`, [aud, projectId]);
    assert.equal(
      await sqlState(pool, `INSERT INTO sources (id, title, created_by, created_at, project_id, audience_id, kind) VALUES ($1, 'Summary', $2, now(), $3, $4, 'summary')`, [uuidv7(), userId, projectId, aud]),
      'ok',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO sources (id, title, created_by, created_at, project_id, audience_id, kind) VALUES ($1, 'Minutes', $2, now(), $3, $4, 'minutes')`, [uuidv7(), userId, projectId, aud]),
      '23514',
    );
    const sid = (await pool.query(`SELECT id FROM sources WHERE kind = 'summary'`)).rows[0].id;
    assert.equal(
      await sqlState(
        pool,
        `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at) VALUES ($1, $2, 1, 'summary', 'Text', 'abc', 4, $3, now())`,
        [uuidv7(), sid, userId],
      ),
      'ok',
    );
  });

  test('thread scope needs a thread id', async () => {
    const insert = (scope: string, thread: string | null) =>
      sqlState(
        pool,
        `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, scope_thread_id, created_at) VALUES ($1, $2, 'question', $3, 'queued', $4, $5, now())`,
        [uuidv7(), projectId, userId, scope, thread],
      );
    assert.equal(await insert('thread', null), '23514');
    const aud = uuidv7();
    await pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'project', now())`, [aud, projectId]);
    const threadId = uuidv7();
    await pool.query(
      `INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, created_by, created_at) VALUES ($1, $2, 'discussion', 'T', $3, $4, now())`,
      [threadId, projectId, aud, userId],
    );
    assert.equal(await insert('thread', threadId), 'ok');
    assert.equal(await insert('personal', threadId), '23514');
  });

  test('ai_feedback accepts the new target kinds', async () => {
    for (const kind of ['answer', 'report_version', 'summary_version']) {
      assert.equal(
        await sqlState(
          pool,
          `INSERT INTO ai_feedback (id, project_id, target_kind, target_id, category, note, reporter_id, created_at) VALUES ($1, $2, $3, $4, 'other', 'n', $5, now())`,
          [uuidv7(), projectId, kind, uuidv7(), userId],
        ),
        'ok',
        kind,
      );
    }
  });
});
