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

describe('roles completion schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
  let departmentId: string;
  let projectId: string;
  let membershipId: string;

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
    membershipId = uuidv7();
    await pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'pm', '2026-11-08')`, [membershipId, projectId, userId]);
  });

  test('accounts can be Invited, and memberships can be held and restored', async () => {
    assert.equal(await sqlState(pool, `INSERT INTO users (id, email, display_name, role, status) VALUES ($1, 'b@example.org', 'B', 'member', 'invited')`, [uuidv7()]), 'ok');
    assert.equal(await sqlState(pool, `INSERT INTO users (id, email, display_name, role, status) VALUES ($1, 'c@example.org', 'C', 'member', 'pending')`, [uuidv7()]), '23514');
    assert.equal(
      await sqlState(pool, `UPDATE memberships SET held_at = now(), held_by = $2, hold_reason = 'Account disabled', restored_at = now(), restored_by = $2, restore_reason = 'Cleared' WHERE id = $1`, [membershipId, userId]),
      'ok',
    );
    for (const kind of ['held', 'finding']) {
      assert.equal(await sqlState(pool, `INSERT INTO membership_events (id, membership_id, kind, actor_id, at) VALUES ($1, $2, $3, $4, now())`, [uuidv7(), membershipId, kind, userId]), 'ok', kind);
    }
  });

  test('history tables are append-only', async () => {
    const f = uuidv7();
    await pool.query(`INSERT INTO membership_findings (id, membership_id, finding, recommendation, recorded_by, at) VALUES ($1, $2, 'Checked', 'restore', $3, now())`, [f, membershipId, userId]);
    const g = uuidv7();
    await pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-09', '2026-12-09', $3, now())`,
      [g, projectId, userId],
    );
    const ge = uuidv7();
    await pool.query(`INSERT INTO grant_events (id, grant_id, kind, actor_id, at) VALUES ($1, $2, 'requested', $3, now())`, [ge, g, userId]);
    const a = uuidv7();
    await pool.query(`INSERT INTO project_archive_events (id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, 'archived', $3, 'Done', now())`, [a, projectId, userId]);
    const d = uuidv7();
    await pool.query(
      `INSERT INTO project_department_changes (id, project_id, from_department_id, to_department_id, actor_id, reason, files_decision, at)
       VALUES ($1, $2, $3, $3, $4, 'Reorganised', 'kept_in_place', now())`,
      [d, projectId, departmentId, userId],
    );
    for (const [table, id] of [['membership_findings', f], ['grant_events', ge], ['project_archive_events', a], ['project_department_changes', d]]) {
      assert.equal(await sqlState(pool, `UPDATE ${table} SET at = now() WHERE id = $1`, [id]), '23001', `${table} update`);
      assert.equal(await sqlState(pool, `DELETE FROM ${table} WHERE id = $1`, [id]), '23001', `${table} delete`);
    }
  });

  test('grants have a known kind and an end on or after their start', async () => {
    const grant = (kind: string, ends: string) =>
      sqlState(
        pool,
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at)
         VALUES ($1, $2, $3, $4, 'p', 's', '2026-11-09', $5, $3, now())`,
        [uuidv7(), projectId, userId, kind, ends],
      );
    assert.equal(await grant('oversight', '2026-11-09'), 'ok');
    assert.equal(await grant('auditor', '2026-12-09'), '23514');
    assert.equal(await grant('audit', '2026-11-08'), '23514');
  });

  test('a handover is an invitation for the Project Manager role', async () => {
    const invite = (kind: string, role: string, outgoing: string | null) =>
      sqlState(
        pool,
        `INSERT INTO invitations (id, project_id, email, role, starts_on, invited_by, token_hash, issued_at, expires_at, kind, outgoing_membership_id, outgoing_role)
         VALUES ($1, $2, $3, $4, '2026-11-09', $5, $6, now(), now() + interval '7 days', $7, $8, $9)`,
        [uuidv7(), projectId, `${uuidv7()}@example.org`, role, userId, uuidv7(), kind, outgoing ? membershipId : null, outgoing],
      );
    assert.equal(await invite('handover', 'pm', 'leave'), 'ok');
    assert.equal(await invite('handover', 'member', 'member'), '23514');
    assert.equal(await invite('role', 'member', null), 'ok');
    assert.equal(await invite('handover', 'pm', 'owner'), '23514');
  });
});
