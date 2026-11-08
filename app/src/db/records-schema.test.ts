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

describe('records schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
  let projectId: string;
  let proposalId: string;

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
    const dept = uuidv7();
    await pool.query(`INSERT INTO departments (id, name, created_by, created_at) VALUES ($1, 'Registry', $2, now())`, [dept, userId]);
    projectId = uuidv7();
    await pool.query(
      `INSERT INTO projects (id, name, purpose, owning_department_id, status, created_by, created_at) VALUES ($1, 'P', 'Purpose', $2, 'active', $3, now())`,
      [projectId, dept, userId],
    );
    proposalId = uuidv7();
    await pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'action', 'Do it', $3, now())`,
      [proposalId, projectId, userId],
    );
  });

  const task = (over: { id?: string; depth?: number; parent?: string | null; origin?: string | null } = {}) =>
    sqlState(
      pool,
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, 'T', $5, '2026-11-20', $6, $5, now())`,
      [over.id ?? uuidv7(), projectId, over.parent ?? null, over.depth ?? 0, userId, over.origin === undefined ? proposalId : over.origin],
    );

  test('one proposal makes at most one top-level task; subtasks go two levels deep', async () => {
    const top = uuidv7();
    assert.equal(await task({ id: top }), 'ok');
    assert.equal(await task(), '23505', 'a second task from the same proposal');
    const child = uuidv7();
    assert.equal(await task({ id: child, depth: 1, parent: top, origin: null }), 'ok');
    const grandchild = uuidv7();
    assert.equal(await task({ id: grandchild, depth: 2, parent: child, origin: null }), 'ok');
    assert.equal(await task({ depth: 3, parent: grandchild, origin: null }), '23514');
    assert.equal(await task({ depth: 1, parent: null, origin: null }), '23514', 'a subtask needs a parent');
  });

  test('a decision, question or risk comes from exactly one origin', async () => {
    const decision = (item: string | null, proposal: string | null) =>
      sqlState(
        pool,
        `INSERT INTO decisions (id, project_id, statement, origin_item_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'S', $3, $4, $5, now())`,
        [uuidv7(), projectId, item, proposal, userId],
      );
    assert.equal(await decision(null, null), '23514');
    assert.equal(await decision(null, proposalId), 'ok');
    assert.equal(await decision(null, proposalId), '23505');
    const p2 = uuidv7();
    await pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', 'R', $3, now())`, [p2, projectId, userId]);
    assert.equal(
      await sqlState(pool, `INSERT INTO risks (id, project_id, description, severity, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'R', 'severe', $3, $4, now())`, [uuidv7(), projectId, p2, userId]),
      '23514',
    );
  });

  test('history tables are append-only', async () => {
    const t = uuidv7();
    await task({ id: t });
    const e = uuidv7();
    await pool.query(`INSERT INTO task_events (id, task_id, kind, to_status, actor_id, at) VALUES ($1, $2, 'authorised', 'not_started', $3, now())`, [e, t, userId]);
    const q = uuidv7();
    const p3 = uuidv7();
    await pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'question', 'Q?', $3, now())`, [p3, projectId, userId]);
    await pool.query(`INSERT INTO questions (id, project_id, text, requester_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'Q?', $3, $4, $3, now())`, [q, projectId, userId, p3]);
    const a = uuidv7();
    await pool.query(`INSERT INTO question_answers (id, question_id, answer, author_id, at) VALUES ($1, $2, 'Yes', $3, now())`, [a, q, userId]);
    const r = uuidv7();
    await pool.query(`INSERT INTO record_events (id, record_kind, record_id, kind, actor_id, at) VALUES ($1, 'question', $2, 'answered', $3, now())`, [r, q, userId]);
    for (const [table, id] of [['task_events', e], ['question_answers', a], ['record_events', r]]) {
      assert.equal(await sqlState(pool, `UPDATE ${table} SET at = now() WHERE id = $1`, [id]), '23001', table);
      assert.equal(await sqlState(pool, `DELETE FROM ${table} WHERE id = $1`, [id]), '23001', table);
    }
  });
});
