import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { leadershipGrantState, leadershipProjectIds } from './grants';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

describe('leadershipGrantState', () => {
  const g = { startsOn: '2026-11-10', expiresOn: '2026-11-12' as string | null, revokedAt: null as string | null };
  test('scheduled before start, active from start to the last day inclusive, ended after', () => {
    assert.equal(leadershipGrantState(g, '2026-11-09'), 'scheduled');
    assert.equal(leadershipGrantState(g, '2026-11-10'), 'active');
    assert.equal(leadershipGrantState(g, '2026-11-12'), 'active');
    assert.equal(leadershipGrantState(g, '2026-11-13'), 'ended');
  });
  test('no end date never ends; revoked wins over every other state', () => {
    assert.equal(leadershipGrantState({ ...g, expiresOn: null }, '2030-01-01'), 'active');
    assert.equal(leadershipGrantState({ ...g, revokedAt: '2026-11-11T00:00:00Z' }, '2026-11-11'), 'revoked');
    assert.equal(leadershipGrantState({ ...g, revokedAt: '2026-11-11T00:00:00Z' }, '2026-12-01'), 'revoked');
  });
});

describe('leadershipProjectIds', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let admin: string;
  let leader: string;
  let deptA: string;
  let deptB: string;
  let pa: string;
  let pb: string;
  let pc: string;
  const TODAY = '2026-11-19';

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    admin = await seedUser(pool, 'admin@example.org', 'enterprise_administrator');
    leader = await seedUser(pool, 'leader@example.org');
    deptA = await seedDepartment(pool, 'Alpha Unit');
    deptB = await seedDepartment(pool, 'Beta Unit');
    pa = await seedProject(pool, { status: 'active', members: [], departmentId: deptA });
    pb = await seedProject(pool, { status: 'active', members: [], departmentId: deptB });
    pc = await seedProject(pool, { status: 'active', members: [], departmentId: deptB });
  });

  async function grant(kind: string, opts: { depts?: string[]; projects?: string[]; startsOn?: string; expiresOn?: string | null; revoked?: boolean } = {}) {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, expires_on, reason, granted_by, granted_at, revoked_at, revoked_by, revoke_reason)
       VALUES ($1, $2, $3, $4, $5, 'Reason', $6, now(), $7, $8, $9)`,
      [id, leader, kind, opts.startsOn ?? '2026-11-01', opts.expiresOn === undefined ? null : opts.expiresOn, admin, opts.revoked ? new Date() : null, opts.revoked ? admin : null, opts.revoked ? 'Ended' : null],
    );
    for (const d of opts.depts ?? []) await pool.query(`INSERT INTO leadership_grant_departments (grant_id, department_id) VALUES ($1, $2)`, [id, d]);
    for (const p of opts.projects ?? []) await pool.query(`INSERT INTO leadership_grant_projects (grant_id, project_id) VALUES ($1, $2)`, [id, p]);
    return id;
  }

  test('null with no grant', async () => {
    assert.equal(await leadershipProjectIds(pool, leader, TODAY), null);
  });

  test('organisation scope covers every project', async () => {
    await grant('organisation');
    assert.deepEqual((await leadershipProjectIds(pool, leader, TODAY))?.sort(), [pa, pb, pc].sort());
  });

  test('department scope covers its owned projects, and named scope the named ones', async () => {
    await grant('departments', { depts: [deptB] });
    assert.deepEqual((await leadershipProjectIds(pool, leader, TODAY))?.sort(), [pb, pc].sort());
    await resetGrants();
    await grant('projects', { projects: [pa] });
    assert.deepEqual(await leadershipProjectIds(pool, leader, TODAY), [pa]);
  });

  const resetGrants = async () => {
    await pool.query(`UPDATE leadership_grants SET revoked_at = now(), revoked_by = $1, revoke_reason = 'x'`, [admin]);
  };

  test('union of two grants', async () => {
    await grant('departments', { depts: [deptA] });
    await grant('projects', { projects: [pc] });
    assert.deepEqual((await leadershipProjectIds(pool, leader, TODAY))?.sort(), [pa, pc].sort());
  });

  test('scheduled, ended and revoked grants add nothing', async () => {
    await grant('organisation', { startsOn: '2026-11-20' });
    await grant('organisation', { startsOn: '2026-11-01', expiresOn: '2026-11-18' });
    await grant('organisation', { revoked: true });
    assert.equal(await leadershipProjectIds(pool, leader, TODAY), null);
    await grant('projects', { projects: [pb], expiresOn: TODAY });
    assert.deepEqual(await leadershipProjectIds(pool, leader, TODAY), [pb]);
  });

  test('disabled account has no scope', async () => {
    await grant('organisation');
    await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [leader]);
    assert.equal(await leadershipProjectIds(pool, leader, TODAY), null);
  });

  test('an Active grant with a department scope and no projects is an empty list, not null', async () => {
    const empty = await seedDepartment(pool, 'Empty Unit');
    await grant('departments', { depts: [empty] });
    assert.deepEqual(await leadershipProjectIds(pool, leader, TODAY), []);
  });
});
