import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { closeEpisode, openEpisode } from './alerts';
import { freshBackup } from './status';
import { runOpsSweep } from './sweep-ops';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date('2026-11-21T12:00:00Z');
const H = 3_600_000;
const MIN = 60_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('the ops part of the sweep', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let a1: string;
  let a2: string;
  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    a1 = await seedUser(pool, 'sweep-ops-a1@example.org', 'enterprise_administrator');
    a2 = await seedUser(pool, 'sweep-ops-a2@example.org', 'enterprise_administrator');
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM email_outbox');
    await pool.query('DELETE FROM ops_alerts');
    await pool.query('DELETE FROM storage_readings');
    await pool.query('DELETE FROM storage_daily');
    await pool.query('DELETE FROM restore_drills');
    await pool.query('DELETE FROM backup_runs');
    await pool.query(`DELETE FROM audit_events WHERE action LIKE 'ops.%'`).catch(() => undefined);
  });

  const addRun = async (outcome: 'running' | 'succeeded' | 'failed', startedAt: Date, finishedAt: Date | null = null): Promise<string> => {
    const id = uuidv7();
    await pool.query(`INSERT INTO backup_runs (id, kind, started_at, finished_at, outcome) VALUES ($1, 'daily', $2, $3, $4)`, [
      id,
      startedAt,
      finishedAt,
      outcome,
    ]);
    return id;
  };
  const addReading = (location: string, at: Date) =>
    pool.query(`INSERT INTO storage_readings (id, at, location, total_bytes, free_bytes, used_bytes) VALUES ($1, $2, $3, 100, 50, 50)`, [
      uuidv7(),
      at,
      location,
    ]);
  const notices = async (kind: string): Promise<Array<{ user_id: string; summary: string; link: string }>> =>
    (await pool.query(`SELECT user_id, summary, link FROM notifications WHERE kind = $1 ORDER BY user_id, summary`, [kind])).rows;
  const openCount = async (kind: string): Promise<number> =>
    (await pool.query('SELECT count(*)::int AS n FROM ops_alerts WHERE closed_at IS NULL AND kind = $1', [kind])).rows[0].n;

  test('two sweeps with the target exceeded send one notice per administrator', async () => {
    await addRun('succeeded', ago(26 * H), ago(26 * H));
    await runOpsSweep(pool, NOW);
    await runOpsSweep(pool, new Date(NOW.getTime() + MIN));
    const rows = await notices('backup_target_exceeded');
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [a1, a2].sort());
    assert.equal(rows[0].link, '#/admin/operations');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'backup_target_exceeded'`)).rows[0].n, 2);
    assert.equal(await openCount('backup_target_exceeded'), 1);
  });

  test('concurrent sweeps still send one notice per administrator', async () => {
    await addRun('succeeded', ago(26 * H), ago(26 * H));
    await Promise.all([runOpsSweep(pool, NOW), runOpsSweep(pool, NOW), runOpsSweep(pool, NOW)]);
    assert.equal((await notices('backup_target_exceeded')).length, 2);
  });

  test('a success closes the episode and sends backup_recovered once', async () => {
    await addRun('succeeded', ago(26 * H), ago(26 * H));
    await runOpsSweep(pool, NOW);
    const later = new Date(NOW.getTime() + 10 * MIN);
    await addRun('succeeded', NOW, new Date(NOW.getTime() + 5 * MIN));
    await runOpsSweep(pool, later);
    await runOpsSweep(pool, new Date(later.getTime() + MIN));
    assert.equal((await notices('backup_recovered')).length, 2);
    assert.equal(await openCount('backup_target_exceeded'), 0);
    assert.equal((await notices('backup_target_exceeded')).length, 2);
  });

  const register = async (at: Date): Promise<void> => {
    await pool.query(
      `INSERT INTO organisation (id, name, registered_at, updated_at) VALUES (1, 'Example Organisation', $1, $1)
       ON CONFLICT (id) DO UPDATE SET registered_at = $1`,
      [at],
    );
  };

  test('no backup yet: quiet until the organisation was registered more than 24 hours ago', async () => {
    await register(ago(23 * H));
    await runOpsSweep(pool, NOW);
    assert.equal((await notices('backup_target_exceeded')).length, 0);
    await register(ago(25 * H));
    await runOpsSweep(pool, NOW);
    await runOpsSweep(pool, new Date(NOW.getTime() + MIN));
    assert.deepEqual((await notices('backup_target_exceeded')).map((r) => r.user_id).sort(), [a1, a2].sort());
  });

  test('interrupted runs and drills are marked failed once, with an audit event each', async () => {
    const run = await addRun('running', ago(6 * H + 1000));
    const young = await addRun('running', ago(5 * H));
    await addRun('succeeded', ago(2 * H), ago(2 * H));
    const drill = uuidv7();
    await pool.query(`INSERT INTO restore_drills (id, started_at, outcome) VALUES ($1, $2, 'running')`, [drill, ago(7 * H)]);
    await runOpsSweep(pool, NOW);
    await runOpsSweep(pool, NOW);
    const r = (await pool.query('SELECT outcome, failure_code, failure_detail, finished_at FROM backup_runs WHERE id = $1', [run])).rows[0];
    assert.equal(r.outcome, 'failed');
    assert.equal(r.failure_code, 'interrupted');
    assert.equal(r.failure_detail, 'The run was interrupted before it finished.');
    assert.ok(r.finished_at);
    assert.equal((await pool.query('SELECT outcome FROM backup_runs WHERE id = $1', [young])).rows[0].outcome, 'running');
    const d = (await pool.query('SELECT outcome, failure_code FROM restore_drills WHERE id = $1', [drill])).rows[0];
    assert.deepEqual(d, { outcome: 'failed', failure_code: 'interrupted' });
    const audits = await pool.query(`SELECT action, subject_id FROM audit_events WHERE action LIKE 'ops.%interrupted' ORDER BY action`);
    assert.deepEqual(audits.rows, [
      { action: 'ops.backup_interrupted', subject_id: run },
      { action: 'ops.restore_drill_interrupted', subject_id: drill },
    ]);
    assert.equal((await notices('backup_failed')).length, 2);
  });

  test('a storage reading 31 minutes old gives one storage_check_missing per location', async () => {
    await addReading('database_disk', ago(31 * MIN));
    await addReading('backup_disk', ago(31 * MIN));
    await runOpsSweep(pool, NOW);
    await runOpsSweep(pool, NOW);
    const rows = await notices('storage_check_missing');
    assert.equal(rows.length, 4, 'two locations times two administrators');
    assert.ok(rows.every((r) => r.link === '#/admin/operations'));
    assert.equal(new Set(rows.map((r) => r.summary)).size, 2);
  });

  test('a reading 30 minutes old is not missing, and a fresh reading closes the episode', async () => {
    await addReading('database_disk', ago(30 * MIN));
    await addReading('backup_disk', ago(40 * MIN));
    await runOpsSweep(pool, NOW);
    assert.equal((await notices('storage_check_missing')).length, 2, 'backup_disk only');
    await addReading('backup_disk', NOW);
    await runOpsSweep(pool, NOW);
    assert.equal(await openCount('storage_check_missing'), 0);
  });

  test('no reading ever: nothing without a backup run, one notice per location with one', async () => {
    await runOpsSweep(pool, NOW);
    assert.equal((await notices('storage_check_missing')).length, 0);
    await addRun('succeeded', ago(H), ago(H));
    await runOpsSweep(pool, NOW);
    assert.equal((await notices('storage_check_missing')).length, 4);
  });

  test('readings older than the retention period are deleted; daily rows stay', async () => {
    await pool.query('UPDATE operations_settings SET diagnostic_retention_days = 7');
    await addReading('database_disk', ago(7 * 24 * H + 1000));
    await addReading('database_disk', ago(7 * 24 * H - 1000));
    await pool.query(`INSERT INTO storage_daily (day, location, max_used_bytes, min_free_bytes, total_bytes) VALUES ('2026-01-01', 'database_disk', 1, 1, 2)`);
    await runOpsSweep(pool, NOW);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_readings')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_daily')).rows[0].n, 1);
    await pool.query('UPDATE operations_settings SET diagnostic_retention_days = 30');
  });

  test('openEpisode and closeEpisode report only real changes', async () => {
    assert.equal(await openEpisode(pool, 'x_kind', 'database_disk', NOW), true);
    assert.equal(await openEpisode(pool, 'x_kind', 'database_disk', NOW), false);
    assert.equal(await openEpisode(pool, 'x_kind', null, NOW), true);
    assert.equal(await openEpisode(pool, 'x_kind', null, NOW), false);
    assert.equal(await closeEpisode(pool, 'x_kind', null, NOW), true);
    assert.equal(await closeEpisode(pool, 'x_kind', null, NOW), false);
    assert.equal(await openEpisode(pool, 'x_kind', null, NOW), true, 'a new episode can follow a closed one');
  });

  test('freshBackup is ok only for a success within 24 hours', async () => {
    assert.deepEqual(await freshBackup(pool, NOW), { ok: false });
    await addRun('succeeded', ago(25 * H), ago(24 * H + 1000));
    assert.equal((await freshBackup(pool, NOW)).ok, false);
    const id = await addRun('succeeded', ago(2 * H), ago(H));
    const f = await freshBackup(pool, NOW);
    assert.equal(f.ok, true);
    assert.equal(f.runId, id);
    assert.equal(f.finishedAt?.toISOString(), ago(H).toISOString());
  });
});
