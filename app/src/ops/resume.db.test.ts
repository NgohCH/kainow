import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { codeMigrationLevel } from './common';
import { resume, resumeChecks } from './resume';
import { OPS_DEFAULTS } from './settings';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const GB = 1024 ** 3;
const MIN = 60_000;
const NOW = new Date('2026-11-21T12:00:00Z');
const FLOOR = OPS_DEFAULTS.safeFloorGb * GB;

/** The 409 body, or a failure when the call did not refuse with 409. */
async function conflict(p: Promise<unknown>): Promise<{ code: string; message: string; failing?: string[] }> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ConflictException, `expected 409, got ${String(err)}`);
    return err.getResponse() as { code: string; message: string; failing?: string[] };
  }
  assert.fail('expected a 409 refusal');
}

describe('resume from protective mode', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let a1: string;
  let a2: string;
  let member: string;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    a1 = await seedUser(pool, 'resume-a1@example.org', 'enterprise_administrator');
    a2 = await seedUser(pool, 'resume-a2@example.org', 'enterprise_administrator');
    member = await seedUser(pool, 'resume-m@example.org');
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    for (const t of ['notifications', 'email_outbox', 'storage_readings', 'backup_runs']) await pool.query(`DELETE FROM ${t}`);
    await pool.query(`UPDATE operations_state SET protective = true, reason = 'low_space', since = $1, detail = '{}', changed_by = NULL`, [new Date(NOW.getTime() - 60 * MIN)]);
  });

  const reading = async (ageMs: number, free: number | null, unavailable = false) =>
    pool.query(
      `INSERT INTO storage_readings (id, at, location, total_bytes, free_bytes, used_bytes, unavailable) VALUES ($1, $2, 'database_disk', $3, $4, $5, $6)`,
      [uuidv7(), new Date(NOW.getTime() - ageMs), unavailable ? null : 100 * GB, free, free === null ? null : 100 * GB - free, unavailable],
    );
  const failing = async () => (await resumeChecks(pool, NOW, OPS_DEFAULTS)).filter((c) => !c.ok).map((c) => c.name);
  const state = async () => (await pool.query('SELECT protective, reason, since, changed_by FROM operations_state')).rows[0];

  test('the five checks are named and ordered; all pass with a fresh reading at the floor and no backup running', async () => {
    await reading(MIN, FLOOR);
    const checks = await resumeChecks(pool, NOW, OPS_DEFAULTS);
    assert.deepEqual(checks, [
      { name: 'reading_fresh', ok: true },
      { name: 'space_above_floor', ok: true },
      { name: 'database', ok: true },
      { name: 'migrations_current', ok: true },
      { name: 'no_backup_running', ok: true },
    ]);
  });

  test('no reading at all fails both reading checks', async () => {
    assert.deepEqual(await failing(), ['reading_fresh', 'space_above_floor']);
  });

  test('fresh means strictly younger than 10 minutes; only the latest reading counts', async () => {
    await reading(10 * MIN, 50 * GB);
    assert.deepEqual(await failing(), ['reading_fresh'], 'exactly 10 minutes old is not fresh');
    await reading(10 * MIN - 1, FLOOR - 1);
    assert.deepEqual(await failing(), ['space_above_floor'], 'the newer reading is below the floor');
  });

  test('an unmeasurable latest reading fails the space check', async () => {
    await reading(MIN, null, true);
    assert.deepEqual(await failing(), ['space_above_floor']);
  });

  test('the floor is the setting in GB of 1024^3 bytes', async () => {
    await reading(MIN, 7 * GB - 1);
    assert.deepEqual((await resumeChecks(pool, NOW, { ...OPS_DEFAULTS, safeFloorGb: 7 })).filter((c) => !c.ok).map((c) => c.name), ['space_above_floor']);
    await reading(MIN - 1, 7 * GB);
    assert.deepEqual((await resumeChecks(pool, NOW, { ...OPS_DEFAULTS, safeFloorGb: 7 })).filter((c) => !c.ok).map((c) => c.name), []);
  });

  test('a running backup and a migration level that does not match the code fail their checks', async () => {
    await reading(MIN, 50 * GB);
    await pool.query(`INSERT INTO backup_runs (id, kind, started_at, outcome) VALUES ($1, 'daily', $2, 'running')`, [uuidv7(), NOW]);
    assert.deepEqual(await failing(), ['no_backup_running']);
    assert.deepEqual((await resumeChecks(pool, NOW, OPS_DEFAULTS, '9999_future.sql')).filter((c) => !c.ok).map((c) => c.name), ['migrations_current', 'no_backup_running']);
    assert.ok(codeMigrationLevel().length > 0);
  });

  test('a database that does not answer fails every check instead of throwing', async () => {
    const dead = { query: async () => Promise.reject(new Error('connection refused')) };
    const checks = await resumeChecks(dead as unknown as Pool, NOW, OPS_DEFAULTS);
    assert.deepEqual(checks.map((c) => c.ok), [false, false, false, false, false]);
  });

  test('refuses with 409 naming reading_fresh when there is no fresh reading, and changes nothing', async () => {
    await reading(30 * MIN, 50 * GB);
    const body = await conflict(resume(pool, a1, 'Disk extended', NOW));
    assert.equal(body.code, 'resume_checks_failed');
    assert.deepEqual(body.failing, ['reading_fresh']);
    assert.equal((await state()).protective, true);
    assert.equal((await pool.query(`SELECT 1 FROM operations_state_changes WHERE action = 'resumed'`)).rows.length, 0);
    assert.equal((await pool.query(`SELECT 1 FROM audit_events WHERE action = 'ops.protective_resumed'`)).rows.length, 0);
  });

  test('refuses with 409 naming space_above_floor when the fresh reading is below the floor', async () => {
    await reading(MIN, FLOOR - 1);
    assert.deepEqual((await conflict(resume(pool, a1, 'Disk extended', NOW))).failing, ['space_above_floor']);
    assert.equal((await state()).protective, true);
  });

  test('refuses with 409 naming no_backup_running while a backup runs', async () => {
    await reading(MIN, 50 * GB);
    await pool.query(`INSERT INTO backup_runs (id, kind, started_at, outcome) VALUES ($1, 'manual', $2, 'running')`, [uuidv7(), NOW]);
    assert.deepEqual((await conflict(resume(pool, a1, 'Disk extended', NOW))).failing, ['no_backup_running']);
  });

  test('a fresh reading at the floor and no running backup: the mode ends, recorded and audited, the other administrators told', async () => {
    await reading(MIN, FLOOR);
    let invalidated = 0;
    const r = await resume(pool, a1, '  Disk extended by 50 GB  ', NOW, { state: { invalidate: () => invalidated++ } });
    assert.deepEqual(r, { resumed: true, at: NOW });
    assert.equal(invalidated, 1);
    const s = await state();
    assert.deepEqual([s.protective, s.reason, s.since, s.changed_by], [false, null, null, a1]);
    const change = (await pool.query(`SELECT at, actor_id, reason, detail FROM operations_state_changes WHERE action = 'resumed'`)).rows;
    assert.equal(change.length, 1);
    assert.deepEqual([change[0].at.getTime(), change[0].actor_id, change[0].reason, change[0].detail.previousReason], [NOW.getTime(), a1, 'Disk extended by 50 GB', 'low_space']);
    const audit = (await pool.query(`SELECT actor_user_id, subject_type, detail FROM audit_events WHERE action = 'ops.protective_resumed'`)).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].actor_user_id, audit[0].subject_type, audit[0].detail.reason], [a1, 'operations_state', 'Disk extended by 50 GB']);
    const notices = (await pool.query(`SELECT user_id, urgent FROM notifications WHERE kind = 'protective_mode_resumed'`)).rows;
    assert.deepEqual(notices, [{ user_id: a2, urgent: true }], 'the other administrator only');
    assert.equal((await pool.query(`SELECT 1 FROM email_outbox WHERE kind = 'protective_mode_resumed'`)).rows.length, 1);

    // Done once: a second Resume finds the mode off.
    assert.equal((await conflict(resume(pool, a2, 'Again', NOW))).code, 'not_protective');
  });

  test('a non-administrator is refused with 403, before anything else', async () => {
    await reading(MIN, 50 * GB);
    await assert.rejects(resume(pool, member, 'Disk extended', NOW), ForbiddenException);
    await assert.rejects(resume(pool, uuidv7(), 'Disk extended', NOW), ForbiddenException);
    // A disabled administrator is refused too.
    const gone = await seedUser(pool, `resume-gone-${uuidv7().slice(-8)}@example.org`, 'enterprise_administrator');
    await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [gone]);
    await assert.rejects(resume(pool, gone, 'Disk extended', NOW), ForbiddenException);
    assert.equal((await state()).protective, true);
  });

  test('resume is refused while the reason is update (409), and changes nothing', async () => {
    await reading(MIN, 50 * GB);
    await pool.query(`UPDATE operations_state SET reason = 'update', detail = '{"version":"1.0.1"}'`);
    const resumedBefore = (await pool.query(`SELECT count(*)::int AS n FROM operations_state_changes WHERE action = 'resumed'`)).rows[0].n;
    const body = await conflict(resume(pool, a1, 'Disk extended', NOW));
    assert.equal(body.code, 'update_in_progress');
    assert.match(body.message, /update/i);
    const s = await state();
    assert.equal(s.protective, true);
    assert.equal(s.reason, 'update');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM operations_state_changes WHERE action = 'resumed'`)).rows[0].n, resumedBefore);
  });

  test('a reason is required', async () => {
    await reading(MIN, 50 * GB);
    await assert.rejects(resume(pool, a1, '   ', NOW), BadRequestException);
    await assert.rejects(resume(pool, a1, undefined, NOW), BadRequestException);
    assert.equal((await state()).protective, true);
  });
});
