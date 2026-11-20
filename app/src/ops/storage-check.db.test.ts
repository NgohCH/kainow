import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import type { OpsConfig } from './config';
import { runStorageCheck } from './storage-check';
import { runOpsSweep } from './sweep-ops';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const GB = 1024 ** 3;
const MIN = 60_000;
const NOW = new Date('2026-11-21T12:00:00Z');
const config: OpsConfig = {
  databaseUrl: 'x',
  backupDir: '/b',
  backupKeyFile: '/k',
  dbDataDir: '/d',
  protectedKeyFile: null,
  folderLabel: '/b',
};
type Stat = { total: number; free: number } | null;

describe('storage-check', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    await seedUser(pool, 'storage-a1@example.org', 'enterprise_administrator');
    await seedUser(pool, 'storage-a2@example.org', 'enterprise_administrator');
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    for (const t of ['notifications', 'email_outbox', 'ops_alerts', 'storage_readings', 'storage_daily'])
      await pool.query(`DELETE FROM ${t}`);
    await pool.query('UPDATE operations_state SET protective = false, reason = NULL, since = NULL, detail = NULL');
  });

  const run = async (db: Stat, backup: Stat, at = NOW): Promise<number> =>
    runStorageCheck([], {
      pool,
      config,
      statfs: (p) => (p === config.dbDataDir ? db : backup),
      now: () => at,
      out: () => undefined,
      err: () => undefined,
    });
  const disk = (usedPct: number): Stat => ({ total: 100 * GB, free: Math.round((100 - usedPct) * GB) });
  const OK: Stat = disk(10);
  const notices = async (kind: string) => (await pool.query(`SELECT 1 FROM notifications WHERE kind = $1`, [kind])).rows.length;
  const open = async (kind: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM ops_alerts WHERE closed_at IS NULL AND kind = $1`, [kind])).rows[0].n;
  const audits = async (action: string) => (await pool.query(`SELECT 1 FROM audit_events WHERE action = $1`, [action])).rows.length;
  const state = async () => (await pool.query('SELECT * FROM operations_state')).rows[0];

  test('writes a reading per location with the database size', async () => {
    assert.equal(await run(OK, OK), 0);
    const rows = (await pool.query('SELECT * FROM storage_readings ORDER BY location')).rows;
    assert.deepEqual(
      rows.map((r) => r.location),
      ['backup_disk', 'database_disk'],
    );
    const d = rows.find((r) => r.location === 'database_disk');
    assert.equal(Number(d.total_bytes), 100 * GB);
    assert.equal(Number(d.used_bytes), 10 * GB);
    assert.ok(Number(d.extra.databaseBytes) > 0);
    assert.ok('kainowBytes' in rows.find((r) => r.location === 'backup_disk').extra);
  });

  test('an unmeasurable location is unavailable, never zero, and changes no episode', async () => {
    await run(disk(85), OK);
    await run(null, null, new Date(NOW.getTime() + MIN));
    const r = (await pool.query(`SELECT * FROM storage_readings WHERE location = 'database_disk' ORDER BY at DESC LIMIT 1`)).rows[0];
    assert.equal(r.unavailable, true);
    assert.equal(r.total_bytes, null);
    assert.equal(r.free_bytes, null);
    assert.equal(await open('storage_warning'), 1);
    assert.equal(await notices('storage_warning'), 2);
  });

  test('the daily summary keeps the max used and min free for the UTC+8 day', async () => {
    await run(disk(50), OK, new Date('2026-11-21T10:00:00Z'));
    await run(disk(70), OK, new Date('2026-11-21T11:00:00Z'));
    await run(disk(60), OK, new Date('2026-11-21T12:00:00Z'));
    // 16:30Z is 00:30 on the 22nd in UTC+8.
    await run(disk(40), OK, new Date('2026-11-21T16:30:00Z'));
    const rows = (
      await pool.query(`SELECT day::text AS day, max_used_bytes, min_free_bytes FROM storage_daily WHERE location = 'database_disk' ORDER BY day`)
    ).rows;
    assert.deepEqual(
      rows.map((r) => r.day),
      ['2026-11-21', '2026-11-22'],
    );
    assert.equal(Number(rows[0].max_used_bytes), 70 * GB);
    assert.equal(Number(rows[0].min_free_bytes), 30 * GB);
    assert.equal(Number(rows[1].max_used_bytes), 40 * GB);
  });

  test('crossing warning notifies once; falling back closes silently', async () => {
    await run(disk(81), OK);
    await run(disk(82), OK, new Date(NOW.getTime() + MIN));
    assert.equal(await notices('storage_warning'), 2); // one per administrator
    assert.equal(await open('storage_warning'), 1);
    await run(disk(50), OK, new Date(NOW.getTime() + 2 * MIN));
    assert.equal(await open('storage_warning'), 0);
    assert.equal(await notices('storage_warning'), 2);
  });

  test('warning to critical opens critical and keeps warning; dropping below closes both', async () => {
    const auditBase = await audits('ops.storage_level_changed');
    await run(disk(85), OK);
    await run(disk(95), OK, new Date(NOW.getTime() + MIN));
    assert.equal(await open('storage_warning'), 1);
    assert.equal(await open('storage_critical'), 1);
    assert.equal(await notices('storage_critical'), 2);
    await run(disk(95), OK, new Date(NOW.getTime() + 2 * MIN));
    assert.equal(await notices('storage_critical'), 2);
    await run(disk(10), OK, new Date(NOW.getTime() + 3 * MIN));
    assert.equal(await open('storage_warning'), 0);
    assert.equal(await open('storage_critical'), 0);
    assert.ok((await audits('ops.storage_level_changed')) > auditBase);
  });

  test('a new reading closes the check-missing episode silently', async () => {
    await pool.query(`INSERT INTO ops_alerts (id, kind, location, opened_at) VALUES ($1, 'storage_check_missing', 'backup_disk', $2)`, [uuidv7(), NOW]);
    await run(OK, OK);
    assert.equal(await open('storage_check_missing'), 0);
    assert.equal(await notices('storage_check_missing'), 0);
    await runOpsSweep(pool, new Date(NOW.getTime() + MIN)); // still fresh: stays closed
    assert.equal(await open('storage_check_missing'), 0);
  });

  test('free space below the floor enters protective mode once', async () => {
    const low: Stat = { total: 100 * GB, free: 5 * GB - 1 };
    const base = await audits('ops.protective_entered');
    const changesBase = (await pool.query('SELECT 1 FROM operations_state_changes')).rows.length;
    await run(low, OK);
    const s = await state();
    assert.equal(s.protective, true);
    assert.equal(s.reason, 'low_space');
    assert.ok(s.since);
    assert.equal(s.detail.freeBytes, 5 * GB - 1);
    assert.equal((await pool.query(`SELECT 1 FROM operations_state_changes WHERE action = 'entered' AND actor_id IS NULL AND reason = 'low_space'`)).rows.length, changesBase + 1);
    assert.equal((await audits('ops.protective_entered')) - base, 1);
    assert.equal(await notices('protective_mode_entered'), 2);
    await run(low, OK, new Date(NOW.getTime() + MIN));
    assert.equal((await pool.query('SELECT 1 FROM operations_state_changes')).rows.length, changesBase + 1);
    assert.equal((await audits('ops.protective_entered')) - base, 1);
    assert.equal(await notices('protective_mode_entered'), 2);
    // Never turned off by this command.
    await run(OK, OK, new Date(NOW.getTime() + 2 * MIN));
    assert.equal((await state()).protective, true);
  });

  test('free space exactly at the floor does not enter', async () => {
    await run({ total: 100 * GB, free: 5 * GB }, OK);
    assert.equal((await state()).protective, false);
  });

  test('a low backup disk alone never enters protective mode', async () => {
    await run(OK, { total: 100 * GB, free: 1 });
    assert.equal((await state()).protective, false);
    assert.equal(await notices('protective_mode_entered'), 0);
  });

  test('a failing notice leaves no episode open', async () => {
    await pool.query(`ALTER TABLE notifications ADD CONSTRAINT zz_block CHECK (kind <> 'storage_warning') NOT VALID`);
    try {
      assert.equal(await run(disk(85), OK), 1);
    } finally {
      await pool.query('ALTER TABLE notifications DROP CONSTRAINT zz_block');
    }
    assert.equal(await open('storage_warning'), 0);
  });
});
