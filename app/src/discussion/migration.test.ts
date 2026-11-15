import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

describe('migration 0024 (discussion)', { skip: SKIP_NO_DB }, () => {
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

  async function audience(mode = 'project'): Promise<string> {
    const id = uuidv7();
    await pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, $3, now())`, [id, projectId, mode]);
    return id;
  }

  async function thread(kind: 'discussion' | 'meeting' = 'discussion'): Promise<string> {
    const id = uuidv7();
    const aud = await audience();
    await pool.query(
      `INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, meeting_date, state, created_by, created_at)
       VALUES ($1, $2, $3, 'Alpha thread', $4, $5, $6, $7, now())`,
      [id, projectId, kind, aud, kind === 'meeting' ? '2026-11-11' : null, kind === 'meeting' ? 'open' : null, userId],
    );
    return id;
  }

  async function message(threadId: string): Promise<{ messageId: string; versionId: string }> {
    const messageId = uuidv7();
    const versionId = uuidv7();
    await pool.query(
      `INSERT INTO discussion_messages (id, thread_id, message_no, author_id, created_at) VALUES ($1, $2, 1, $3, now())`,
      [messageId, threadId, userId],
    );
    await pool.query(
      `INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, 1, 'Hello', 'abc', now())`,
      [versionId, messageId],
    );
    return { messageId, versionId };
  }

  test('existing sources get a Project-wide audience and kind notes', async () => {
    // Build a database at migration 0023, add a source (with and without a project), then apply 0024.
    const oldDir = mkdtempSync(path.join(tmpdir(), 'kainow-mig-'));
    mkdirSync(oldDir, { recursive: true });
    for (const f of readdirSync(migrationsDir)) {
      if (f.endsWith('.sql') && f < '0024') copyFileSync(path.join(migrationsDir, f), path.join(oldDir, f));
    }
    await resetPublicSchema(pool);
    await runMigrations(pool, oldDir);
    const u = await seedUser(pool, 'old@example.org');
    const p = await seedProject(pool, { status: 'active', members: [{ userId: u, role: 'pm' }] });
    const inProject = uuidv7();
    const orphan = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'In project', $2, now(), $3)`, [inProject, u, p]);
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at) VALUES ($1, 'No project', $2, now())`, [orphan, u]);

    await runMigrations(pool, migrationsDir);

    const { rows } = await pool.query(
      `SELECT s.id, s.kind, s.publication, s.project_id AS source_project, a.mode, a.project_id AS audience_project
         FROM sources s JOIN audiences a ON a.id = s.audience_id`,
    );
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.kind, 'notes');
      assert.equal(r.publication, 'published');
      assert.equal(r.mode, 'project');
      assert.equal(r.audience_project, r.source_project);
    }
    assert.equal(rows.find((r) => r.id === orphan).audience_project, null);
    const nulls = await pool.query(`SELECT count(*)::int AS n FROM sources WHERE audience_id IS NULL`);
    assert.equal(nulls.rows[0].n, 0);
  });

  test('a source inserted without an audience gets a Project-wide one; audience_id stays NOT NULL', async () => {
    const id = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'T', $2, now(), $3)`, [id, userId, projectId]);
    const { rows } = await pool.query(`SELECT a.mode, a.project_id FROM sources s JOIN audiences a ON a.id = s.audience_id WHERE s.id = $1`, [id]);
    assert.equal(rows[0].mode, 'project');
    assert.equal(rows[0].project_id, projectId);
    const col = await pool.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'sources' AND column_name = 'audience_id'`);
    assert.equal(col.rows[0].is_nullable, 'NO');
  });

  test('minutes and discussion sources without an audience are refused', async () => {
    const threadId = await thread('meeting');
    for (const kind of ['minutes', 'discussion']) {
      assert.equal(
        await sqlState(pool, `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, thread_id) VALUES ($1, 'X', $2, now(), $3, $4, $5)`, [uuidv7(), userId, projectId, kind, threadId]),
        '23502',
        kind,
      );
    }
    assert.equal(
      await sqlState(pool, `INSERT INTO sources (id, title, created_by, created_at, project_id, thread_id) VALUES ($1, 'X', $2, now(), $3, $4)`, [uuidv7(), userId, projectId, threadId]),
      '23502',
    );
  });

  test('message_versions and minutes_drafts are immutable', async () => {
    const threadId = await thread('meeting');
    const { versionId } = await message(threadId);
    assert.equal(await sqlState(pool, `UPDATE message_versions SET body = 'x' WHERE id = $1`, [versionId]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM message_versions WHERE id = $1`, [versionId]), '23001');

    const draftId = uuidv7();
    await pool.query(
      `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, created_by, created_at)
       VALUES ($1, $2, 1, 'human', 'Minutes', 1, $3, now())`,
      [draftId, threadId, userId],
    );
    assert.equal(await sqlState(pool, `UPDATE minutes_drafts SET body = 'x' WHERE id = $1`, [draftId]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM minutes_drafts WHERE id = $1`, [draftId]), '23001');
  });

  test('discussion_events, audience_events, feedback_events, analysis_settings_changes are append-only', async () => {
    const threadId = await thread();
    const audId = await audience();
    const feedbackId = uuidv7();
    await pool.query(
      `INSERT INTO ai_feedback (id, project_id, target_kind, target_id, category, note, reporter_id, created_at)
       VALUES ($1, $2, 'analysis_run', $3, 'incorrect', 'Wrong', $4, now())`,
      [feedbackId, projectId, uuidv7(), userId],
    );
    const ids = { d: uuidv7(), a: uuidv7(), f: uuidv7(), s: uuidv7() };
    await pool.query(`INSERT INTO discussion_events (id, thread_id, actor_id, action, at) VALUES ($1, $2, $3, 'thread_started', now())`, [ids.d, threadId, userId]);
    await pool.query(
      `INSERT INTO audience_events (id, audience_id, actor_id, from_mode, to_mode, reason, at) VALUES ($1, $2, $3, 'project', 'restricted', 'Sensitive', now())`,
      [ids.a, audId, userId],
    );
    await pool.query(`INSERT INTO feedback_events (id, feedback_id, actor_id, action, to_status, at) VALUES ($1, $2, $3, 'reported', 'open', now())`, [ids.f, feedbackId, userId]);
    await pool.query(
      `INSERT INTO analysis_settings_changes (id, project_id, field, from_value, to_value, reason, actor_id, at) VALUES ($1, NULL, 'quiet_minutes', '5', '10', 'Quieter', $2, now())`,
      [ids.s, userId],
    );
    for (const [table, id] of [
      ['discussion_events', ids.d],
      ['audience_events', ids.a],
      ['feedback_events', ids.f],
      ['analysis_settings_changes', ids.s],
    ]) {
      assert.equal(await sqlState(pool, `UPDATE ${table} SET at = now() WHERE id = $1`, [id]), '23001', `${table} update`);
      assert.equal(await sqlState(pool, `DELETE FROM ${table} WHERE id = $1`, [id]), '23001', `${table} delete`);
    }
  });

  test('one queued or running analysis run per thread', async () => {
    const threadId = await thread();
    const insert = (status: string) =>
      sqlState(
        pool,
        `INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, failure_code, created_at)
         VALUES ($1, $2, 'proposals', 'button', $3, $4, $5, now())`,
        [uuidv7(), threadId, userId, status, status === 'failed' ? 'x' : null],
      );
    assert.equal(await insert('queued'), 'ok');
    assert.equal(await insert('queued'), '23505');
    assert.equal(await insert('running'), '23505');
    assert.equal(await insert('failed'), 'ok');
  });

  test('analysis_settings quiet_minutes outside 5..30 is refused', async () => {
    const insert = (n: number) => sqlState(pool, `INSERT INTO analysis_settings (id, quiet_minutes, updated_at) VALUES (1, $1, now())`, [n]);
    assert.equal(await insert(4), '23514');
    assert.equal(await insert(31), '23514');
    assert.equal(await insert(5), 'ok');
    assert.equal(await sqlState(pool, `INSERT INTO project_analysis_settings (project_id, quiet_minutes, updated_at) VALUES ($1, 3, now())`, [projectId]), '23514');
    assert.equal(await sqlState(pool, `INSERT INTO project_analysis_settings (project_id, updated_at) VALUES ($1, now())`, [projectId]), 'ok');
  });

  test('audiences.mode must be project or restricted', async () => {
    assert.equal(await sqlState(pool, `INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'secret', now())`, [uuidv7(), projectId]), '23514');
    assert.equal(await sqlState(pool, `INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'restricted', now())`, [uuidv7(), projectId]), 'ok');
  });

  test('discussion sources and versions may have no creator; notes may not', async () => {
    const threadId = await thread();
    const aud = await audience();
    const sourceId = uuidv7();
    assert.equal(
      await sqlState(pool, `INSERT INTO sources (id, title, created_at, project_id, audience_id, kind, thread_id) VALUES ($1, 'Transcript', now(), $2, $3, 'discussion', $4)`, [sourceId, projectId, aud, threadId]),
      'ok',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO sources (id, title, created_at, project_id) VALUES ($1, 'Notes', now(), $2)`, [uuidv7(), projectId]),
      '23514',
    );
    const version = (origin: string, by: string | null) =>
      sqlState(
        pool,
        `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
         VALUES ($1, $2, $3, $4, 'T', 'h', 1, $5, now())`,
        [uuidv7(), sourceId, Math.floor(Math.random() * 1e6) + 1, origin, by],
      );
    assert.equal(await version('discussion', null), 'ok');
    assert.equal(await version('meeting', userId), 'ok');
    assert.equal(await version('meeting', null), '23514');
    assert.equal(await version('paste', null), '23514');
  });

  test('extraction runs may have no requester only when started by an event', async () => {
    const sourceId = uuidv7();
    const versionId = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'N', $2, now(), $3)`, [sourceId, userId, projectId]);
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'paste', 'T', 'h', 1, $3, now())`,
      [versionId, sourceId, userId],
    );
    const run = (trigger: string) =>
      sqlState(pool, `INSERT INTO extraction_runs (id, source_version_id, requested_by, trigger, status, created_at) VALUES ($1, $2, NULL, $3, 'succeeded', now())`, [uuidv7(), versionId, trigger]);
    assert.equal(await run('request'), '23514');
    assert.equal(await run('minutes_published'), 'ok');
    assert.equal(await run('other'), '23514');
  });

  test('a meeting thread needs a date and state', async () => {
    const aud = await audience();
    assert.equal(
      await sqlState(pool, `INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, created_by, created_at) VALUES ($1, $2, 'meeting', 'M', $3, $4, now())`, [uuidv7(), projectId, aud, userId]),
      '23514',
    );
  });
});
