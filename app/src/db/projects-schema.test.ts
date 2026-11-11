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

describe('projects and roles schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
  let departmentId: string;
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
    userId = uuidv7();
    await pool.query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, 'a@example.org', 'A', 'enterprise_administrator')`, [userId]);
    departmentId = uuidv7();
    await pool.query(`INSERT INTO departments (id, name, created_by, created_at) VALUES ($1, 'Registry', $2, now())`, [departmentId, userId]);
    projectId = uuidv7();
    await pool.query(
      `INSERT INTO projects (id, name, purpose, owning_department_id, status, created_by, created_at) VALUES ($1, 'P', 'Purpose', $2, 'draft', $3, now())`,
      [projectId, departmentId, userId],
    );
  });

  test('transitions and membership events are append-only', async () => {
    const t = uuidv7();
    await pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, 'draft', 'planned', $3, now())`, [t, projectId, userId]);
    assert.equal(await sqlState(pool, `UPDATE project_transitions SET reason = 'x' WHERE id = $1`, [t]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM project_transitions WHERE id = $1`, [t]), '23001');
    const m = uuidv7();
    await pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'pm', '2026-11-08')`, [m, projectId, userId]);
    const e = uuidv7();
    await pool.query(`INSERT INTO membership_events (id, membership_id, kind, actor_id, at) VALUES ($1, $2, 'appointed', $3, now())`, [e, m, userId]);
    assert.equal(await sqlState(pool, `UPDATE membership_events SET reason = 'x' WHERE id = $1`, [e]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM membership_events WHERE id = $1`, [e]), '23001');
  });

  test('a project has at most one open stage period', async () => {
    const open = (stage: string) =>
      sqlState(pool, `INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, $3, now(), $4)`, [uuidv7(), projectId, stage, userId]);
    assert.equal(await open('Initiation'), 'ok');
    assert.equal(await open('Planning'), '23505');
  });

  test('the closure outcome is set exactly when the project is closed', async () => {
    assert.equal(await sqlState(pool, `UPDATE projects SET status = 'closed' WHERE id = $1`, [projectId]), '23514');
    assert.equal(await sqlState(pool, `UPDATE projects SET closure_outcome = 'abandoned' WHERE id = $1`, [projectId]), '23514');
    assert.equal(await sqlState(pool, `UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [projectId]), 'ok');
  });

  test('a membership cannot expire before it starts, and is unique per person and role', async () => {
    const ins = (role: string, s: string, e: string | null) =>
      sqlState(pool, `INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on) VALUES ($1, $2, $3, $4, $5, $6)`, [uuidv7(), projectId, userId, role, s, e]);
    assert.equal(await ins('member', '2026-11-10', '2026-11-09'), '23514');
    assert.equal(await ins('member', '2026-11-10', '2026-11-10'), 'ok');
    assert.equal(await ins('member', '2026-11-11', null), '23505');
    assert.equal(await ins('superuser', '2026-11-11', null), '23514');
  });

  test('active department names are unique ignoring case; a retired one does not block', async () => {
    const add = (name: string) => sqlState(pool, `INSERT INTO departments (id, name, created_by, created_at) VALUES ($1, $2, $3, now())`, [uuidv7(), name, userId]);
    assert.equal(await add('registry'), '23505');
    await pool.query(`UPDATE departments SET status = 'retired' WHERE id = $1`, [departmentId]);
    assert.equal(await add('registry'), 'ok');
  });

  test('an eligible domain is unique while not removed', async () => {
    const add = () => sqlState(pool, `INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.com', $2, now())`, [uuidv7(), userId]);
    assert.equal(await add(), 'ok');
    assert.equal(await add(), '23505');
    await pool.query(`UPDATE eligible_domains SET removed_by = $1, removed_at = now()`, [userId]);
    assert.equal(await add(), 'ok');
  });

  test('member accounts exist; notes may have no project; invitation tokens are unique', async () => {
    assert.equal(await sqlState(pool, `INSERT INTO users (id, email, display_name, role) VALUES ($1, 'b@example.org', 'B', 'member')`, [uuidv7()]), 'ok');
    const src = uuidv7();
    assert.equal(await sqlState(pool, `INSERT INTO sources (id, title, created_by, created_at) VALUES ($1, 'T', $2, now())`, [src, userId]), 'ok');
    assert.equal(await sqlState(pool, `UPDATE sources SET project_id = $2 WHERE id = $1`, [src, projectId]), 'ok');
    const inv = () =>
      sqlState(
        pool,
        `INSERT INTO invitations (id, project_id, email, role, starts_on, invited_by, token_hash, issued_at, expires_at)
         VALUES ($1, $2, 'c@example.org', 'member', '2026-11-08', $3, 'samehash', now(), now() + interval '7 days')`,
        [uuidv7(), projectId, userId],
      );
    assert.equal(await inv(), 'ok');
    assert.equal(await inv(), '23505');
  });
});
