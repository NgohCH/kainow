import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('migration 0029 (dashboards, leadership, preferences, access settings)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let adaId: string;
  let boId: string;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    adaId = await seedUser(pool, 'ada@example.org');
    boId = await seedUser(pool, 'bo@example.org');
  });

  async function grant(userId: string, grantedBy: string, scope = 'organisation'): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, expires_on, reason, granted_by, granted_at)
       VALUES ($1, $2, $3, '2026-11-01', '2026-11-30', 'quarterly review', $4, now())`,
      [id, userId, scope, grantedBy],
    );
    return id;
  }

  test('access_settings has one row with the defaults', async () => {
    const rows = (
      await pool.query(
        `SELECT archive_after_months, grant_default_days, grant_max_days, invitation_valid_days, analytics_export_allowed FROM access_settings`,
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].archive_after_months, rows[0].grant_default_days, rows[0].grant_max_days, rows[0].invitation_valid_days, rows[0].analytics_export_allowed],
      [12, 30, 90, 7, true],
    );
  });

  test('a second access_settings row is refused', async () => {
    assert.equal(await sqlState(pool, `INSERT INTO access_settings DEFAULT VALUES`), '23505');
    assert.equal(await sqlState(pool, `INSERT INTO access_settings (id) VALUES (false)`), '23514');
  });

  test('bounds are enforced by CHECK', async () => {
    const set = (sql: string) => sqlState(pool, `UPDATE access_settings SET ${sql}`);
    assert.equal(await set('archive_after_months = 61'), '23514');
    assert.equal(await set('archive_after_months = 0'), '23514');
    assert.equal(await set('invitation_valid_days = 0'), '23514');
    assert.equal(await set('invitation_valid_days = 31'), '23514');
    assert.equal(await set('grant_default_days = 91'), '23514');
    assert.equal(await set('grant_max_days = 366'), '23514');
    assert.equal(await set('grant_default_days = 60, grant_max_days = 45'), '23514');
    assert.equal(await set('grant_default_days = 60, grant_max_days = 60'), 'ok');
  });

  test('leadership grant to oneself is refused', async () => {
    assert.equal(
      await sqlState(
        pool,
        `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, reason, granted_by, granted_at) VALUES ($1, $2, 'organisation', '2026-11-01', 'me', $2, now())`,
        [uuidv7(), adaId],
      ),
      '23514',
    );
    await grant(adaId, boId);
  });

  test('grant checks: scope, dates, reason', async () => {
    const insert = (scope: string, start: string, end: string | null, reason: string) =>
      sqlState(
        pool,
        `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, expires_on, reason, granted_by, granted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [uuidv7(), adaId, scope, start, end, reason, boId],
      );
    assert.equal(await insert('everything', '2026-11-01', null, 'x'), '23514');
    assert.equal(await insert('organisation', '2026-11-10', '2026-11-09', 'x'), '23514');
    assert.equal(await insert('organisation', '2026-11-10', '2026-11-10', 'x'), 'ok');
    assert.equal(await insert('organisation', '2026-11-10', null, '   '), '23514');
  });

  test('scope link tables need real departments, projects and grants', async () => {
    const id = await grant(adaId, boId, 'departments');
    assert.equal(await sqlState(pool, `INSERT INTO leadership_grant_departments (grant_id, department_id) VALUES ($1, $2)`, [id, uuidv7()]), '23503');
    assert.equal(await sqlState(pool, `INSERT INTO leadership_grant_projects (grant_id, project_id) VALUES ($1, $2)`, [id, uuidv7()]), '23503');
    assert.equal(await sqlState(pool, `INSERT INTO leadership_grant_departments (grant_id, department_id) VALUES (NULL, NULL)`), '23502');
    assert.equal(await sqlState(pool, `INSERT INTO leadership_grant_projects (grant_id, project_id) VALUES (NULL, NULL)`), '23502');
  });

  test('grant events: kinds, reason and append-only', async () => {
    const id = await grant(adaId, boId);
    const event = (kind: string, reason = 'ok') =>
      sqlState(pool, `INSERT INTO leadership_grant_events (id, grant_id, kind, actor_id, at, reason) VALUES ($1, $2, $3, $4, now(), $5)`, [uuidv7(), id, kind, boId, reason]);
    assert.equal(await event('granted'), 'ok');
    assert.equal(await event('end_changed'), 'ok');
    assert.equal(await event('revoked'), 'ok');
    assert.equal(await event('deleted'), '23514');
    assert.equal(await event('granted', '  '), '23514');
    assert.equal(await sqlState(pool, `UPDATE leadership_grant_events SET reason = 'x'`), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM leadership_grant_events`), '23001');
  });

  test('access_settings_changes is append-only', async () => {
    const insert = (reason: string) =>
      sqlState(
        pool,
        `INSERT INTO access_settings_changes (id, actor_id, at, reason, previous, next) VALUES ($1, $2, now(), $3, '{}', '{}')`,
        [uuidv7(), adaId, reason],
      );
    assert.equal(await insert('  '), '23514');
    assert.equal(await insert('policy review'), 'ok');
    assert.equal(await sqlState(pool, `UPDATE access_settings_changes SET reason = 'x'`), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM access_settings_changes`), '23001');
  });

  test('grants are never deleted', async () => {
    const id = await grant(adaId, boId);
    assert.equal(await sqlState(pool, `DELETE FROM leadership_grants WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `TRUNCATE leadership_grants CASCADE`), '23001');
  });

  test('scope link rows are never deleted', async () => {
    const id = await grant(adaId, boId, 'departments');
    const dept = await seedDepartment(pool, 'Scope test dept');
    const project = await seedProject(pool, { members: [{ userId: adaId, role: 'pm' }] });
    assert.equal(await sqlState(pool, `INSERT INTO leadership_grant_departments (grant_id, department_id) VALUES ($1, $2)`, [id, dept]), 'ok');
    assert.equal(await sqlState(pool, `DELETE FROM leadership_grant_departments WHERE grant_id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `TRUNCATE leadership_grant_departments`), '23001');
    assert.equal(await sqlState(pool, `INSERT INTO leadership_grant_projects (grant_id, project_id) VALUES ($1, $2)`, [id, project]), 'ok');
    assert.equal(await sqlState(pool, `DELETE FROM leadership_grant_projects WHERE grant_id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `TRUNCATE leadership_grant_projects`), '23001');
  });

  test('revocation fields travel together', async () => {
    const id = await grant(adaId, boId);
    assert.equal(await sqlState(pool, `UPDATE leadership_grants SET revoked_at = now() WHERE id = $1`, [id]), '23514');
    assert.equal(
      await sqlState(pool, `UPDATE leadership_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = 'role changed' WHERE id = $1`, [id, boId]),
      'ok',
    );
  });

  test('analytics view names: 1 to 100 characters after trim, unique per user', async () => {
    const insert = (user: string, name: string) =>
      sqlState(
        pool,
        `INSERT INTO analytics_views (id, user_id, name, config, created_at, updated_at) VALUES ($1, $2, $3, '{}', now(), now())`,
        [uuidv7(), user, name],
      );
    assert.equal(await insert(adaId, '   '), '23514');
    assert.equal(await insert(adaId, 'a'.repeat(101)), '23514');
    assert.equal(await insert(adaId, 'a'.repeat(100)), 'ok');
    assert.equal(await insert(adaId, 'a'.repeat(100)), '23505');
    assert.equal(await insert(boId, 'a'.repeat(100)), 'ok');
  });

  test('user_preferences is one row per user; measure indexes exist', async () => {
    const insert = () => sqlState(pool, `INSERT INTO user_preferences (user_id, prefs, updated_at) VALUES ($1, '{}', now())`, [adaId]);
    assert.equal(await insert(), 'ok');
    assert.equal(await insert(), '23505');
    const names = (await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map((r) => r.indexname as string);
    for (const n of ['tasks_project_status_idx', 'risks_project_status_severity_idx', 'change_requests_pending_idx']) {
      assert.ok(names.includes(n), n);
    }
  });
});
