import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { runMigrations } from './migrate';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

describe('search schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
  let otherId: string;
  let projectId: string;
  let itemId: string;
  let proposalId: string;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });

  /** An already approved proposal, as the origin that authorised records must have. */
  async function seedOrigin(kind: string): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'Origin', $4, now(), 'approved', $4, now())`,
      [id, projectId, kind, userId],
    );
    return id;
  }

  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    userId = await seedUser(pool, 'a@example.org');
    otherId = await seedUser(pool, 'b@example.org');
    projectId = await seedProject(pool, {
      status: 'active',
      members: [
        { userId, role: 'pm' },
        { userId: otherId, role: 'member' },
      ],
    });

    const sourceId = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'Kickoff notes', $2, now(), $3)`, [sourceId, userId, projectId]);
    const versionIds: string[] = [];
    for (const n of [1, 2]) {
      const id = uuidv7();
      versionIds.push(id);
      await pool.query(
        `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
         VALUES ($1, $2, $3, 'paste', $4, 'x', 10, $5, now())`,
        [id, sourceId, n, `Version ${n} text`, userId],
      );
    }
    const runId = uuidv7();
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [runId, versionIds[1], userId]);
    itemId = uuidv7();
    await pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Original wording', 'a quote', 0, 7, 1, now())`,
      [itemId, runId, versionIds[1]],
    );
    await pool.query(`INSERT INTO extraction_item_edits (id, item_id, text, edited_by, edited_at) VALUES ($1, $2, 'Edited wording', $3, now())`, [uuidv7(), itemId, userId]);

    proposalId = uuidv7();
    await pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'action', 'Human idea', $3, now())`, [proposalId, projectId, userId]);

    const taskId = uuidv7();
    await pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, authorised_by, authorised_at)
       VALUES ($1, $2, 0, 'New', $3, '2026-12-01', $3, now())`,
      [taskId, projectId, userId],
    );
    await pool.query(
      `INSERT INTO task_events (id, task_id, kind, detail, actor_id, at) VALUES ($1, $2, 'amended', '{"title":{"from":"Old title","to":"New"}}', $3, now())`,
      [uuidv7(), taskId, userId],
    );

    await pool.query(
      `INSERT INTO decisions (id, project_id, statement, rationale, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'We decided', 'Because', $3, $4, now())`,
      [uuidv7(), projectId, await seedOrigin('decision'), userId],
    );
    const questionId = uuidv7();
    await pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'What now?', $3, $4, $3, now())`,
      [questionId, projectId, userId, await seedOrigin('question')],
    );
    await pool.query(`INSERT INTO question_answers (id, question_id, answer, author_id, at) VALUES ($1, $2, 'Like this', $3, now())`, [uuidv7(), questionId, userId]);
    await pool.query(
      `INSERT INTO risks (id, project_id, description, severity, mitigation, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'It may slip', 'high', 'Add slack', $3, $4, now())`,
      [uuidv7(), projectId, await seedOrigin('risk'), userId],
    );
  });

  test('pg_trgm is installed', async () => {
    const { rows } = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    assert.equal(rows.length, 1);
  });

  test('the view returns every searchable kind', async () => {
    const { rows } = await pool.query(`SELECT DISTINCT kind FROM search_documents ORDER BY kind`);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['ai_proposal', 'decision', 'human_proposal', 'note', 'person', 'project', 'question', 'risk', 'task'],
    );
  });

  test('earlier wording is marked', async () => {
    const versions = (
      await pool.query(`SELECT version_no, version_count, is_current, ref_title FROM search_documents WHERE kind = 'note' AND version_no IS NOT NULL ORDER BY version_no`)
    ).rows;
    assert.deepEqual(versions, [
      { version_no: 1, version_count: 2, is_current: false, ref_title: 'Kickoff notes' },
      { version_no: 2, version_count: 2, is_current: true, ref_title: 'Kickoff notes' },
    ]);
    const old = (await pool.query(`SELECT match_note, is_current, ref_title FROM search_documents WHERE kind = 'task' AND text = 'Old title'`)).rows;
    assert.deepEqual(old, [{ match_note: 'Matched wording before an amendment', is_current: false, ref_title: 'New' }]);
    const ai = (await pool.query(`SELECT text, is_current, match_note, ref_title FROM search_documents WHERE kind = 'ai_proposal' ORDER BY is_current`)).rows;
    assert.deepEqual(ai, [
      { text: 'Original wording\na quote', is_current: false, match_note: 'Matched earlier wording', ref_title: 'Edited wording' },
      { text: 'Edited wording', is_current: true, match_note: null, ref_title: 'Edited wording' },
    ]);
  });

  test('approved proposals and revoked or held people are not in the view', async () => {
    const count = async (kind: string) => (await pool.query(`SELECT count(*)::int AS n FROM search_documents WHERE kind = $1`, [kind])).rows[0].n as number;
    assert.equal(await count('person'), 2);
    assert.equal(await count('human_proposal'), 1);
    await pool.query(`UPDATE extraction_items SET review_status = 'approved', reviewed_by = $1, reviewed_at = now() WHERE id = $2`, [userId, itemId]);
    await pool.query(`UPDATE human_proposals SET review_status = 'approved', reviewed_by = $1, reviewed_at = now() WHERE id = $2`, [userId, proposalId]);
    await pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $1 WHERE user_id = $1`, [userId]);
    await pool.query(`UPDATE memberships SET held_at = now() WHERE user_id = $1`, [otherId]);
    assert.equal(await count('ai_proposal'), 0);
    assert.equal(await count('human_proposal'), 0);
    assert.equal(await count('person'), 0);
    // A hold that has since been restored shows the person again.
    await pool.query(`UPDATE memberships SET restored_at = now() + interval '1 minute' WHERE user_id = $1`, [otherId]);
    assert.equal(await count('person'), 1);
  });

  test('each searched table has its trigram index', async () => {
    const { rows } = await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'search\\_%\\_trgm' ORDER BY indexname`);
    const tables = [
      'projects', 'users', 'sources', 'source_versions', 'extraction_items', 'extraction_item_edits', 'human_proposals',
      'tasks', 'task_events', 'decisions', 'questions', 'question_answers', 'risks',
    ];
    assert.deepEqual(rows.map((r) => r.indexname as string).sort(), tables.map((t) => `search_${t}_trgm`).sort());
  });
});
