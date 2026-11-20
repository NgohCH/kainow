import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { OPS_DEFAULTS } from './settings';
import { OpsSettingsService } from './settings.service';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const AT = new Date('2026-11-20T04:00:00Z');

describe('operations schema and settings', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let service: OpsSettingsService;
  let admin: string;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    service = new OpsSettingsService(pool, () => AT);
    admin = await seedUser(pool, 'ops-admin@example.org', 'enterprise_administrator');
  });
  after(async () => {
    await pool.end();
  });

  const refuses = async (p: Promise<unknown>) => assert.rejects(p, (e: unknown) => e instanceof BadRequestException);
  const raises = async (sql: string, params: unknown[] = []) => assert.rejects(pool.query(sql, params));

  test('get returns the defaults and an empty history', async () => {
    const r = await service.get();
    assert.deepEqual(r.settings, OPS_DEFAULTS);
    assert.deepEqual(r.defaults, OPS_DEFAULTS);
    assert.deepEqual(r.changes, []);
    assert.equal(r.bounds.safeFloorGb.max, 1000);
  });

  test('a blank reason is refused with 400 and nothing changes', async () => {
    await refuses(service.update(admin, { backupRetentionDays: 40, reason: '   ' }));
    await refuses(service.update(admin, { backupRetentionDays: 40 }));
    assert.deepEqual((await service.get()).settings, OPS_DEFAULTS);
  });

  test('an invalid value is refused with 400', async () => {
    await refuses(service.update(admin, { backupRetentionDays: 6, reason: 'too short' }));
    await refuses(service.update(admin, { storageWarningPct: 90, storageCriticalPct: 85, reason: 'inverted' }));
    assert.deepEqual((await service.get()).settings, OPS_DEFAULTS);
  });

  test('the database CHECK maps to 400 when validation is bypassed', async () => {
    const client = await pool.connect();
    try {
      await assert.rejects(client.query(`UPDATE operations_settings SET storage_critical_pct = 100`), (e: unknown) => (e as { code?: string }).code === '23514');
      await assert.rejects(client.query(`UPDATE operations_settings SET storage_warning_pct = 95, storage_critical_pct = 95`), (e: unknown) => (e as { code?: string }).code === '23514');
    } finally {
      client.release();
    }
  });

  test('a valid update stores the values, one change row and the audit event', async () => {
    const value = await service.update(admin, { backupRetentionDays: 45, safeFloorGb: 10, reason: ' more room ' });
    assert.deepEqual(value, { ...OPS_DEFAULTS, backupRetentionDays: 45, safeFloorGb: 10 });
    const r = await service.get();
    assert.deepEqual(r.settings, value);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].reason, 'more room');
    assert.deepEqual(r.changes[0].previous, OPS_DEFAULTS);
    assert.deepEqual(r.changes[0].next, value);
    assert.equal(r.changes[0].actorId, admin);
    const audit = (await pool.query(`SELECT actor_user_id, detail FROM audit_events WHERE action = 'ops.settings_changed'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, admin);
    assert.deepEqual(audit[0].detail.fields, ['backupRetentionDays', 'safeFloorGb']);
  });

  test('operations_state has one row, not protective', async () => {
    const { rows } = await pool.query(`SELECT protective, reason, since FROM operations_state`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].protective, false);
    await raises(`UPDATE operations_state SET reason = 'update'`);
    await raises(`INSERT INTO operations_state (id) VALUES (false)`);
  });

  test('ops_alerts refuses a second open episode for the same kind and location', async () => {
    const open = (kind: string, location: string | null) =>
      pool.query(`INSERT INTO ops_alerts (id, kind, location, opened_at) VALUES ($1, $2, $3, $4)`, [uuidv7(), kind, location, AT]);
    await open('storage_warning', 'database_disk');
    await assert.rejects(open('storage_warning', 'database_disk'), (e: unknown) => (e as { code?: string }).code === '23505');
    await open('storage_warning', 'backup_disk');
    await open('backup_missing', null);
    await assert.rejects(open('backup_missing', null), (e: unknown) => (e as { code?: string }).code === '23505');
    await pool.query(`UPDATE ops_alerts SET closed_at = $1 WHERE kind = 'storage_warning' AND location = 'database_disk'`, [AT]);
    await open('storage_warning', 'database_disk');
  });

  test('email_outbox accepts not_sent_restored', async () => {
    await pool.query(
      `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, status, created_at)
       VALUES ($1, 'someone@example.org', 's', 'b', 'test', 'system', 'not_sent_restored', $2)`,
      [uuidv7(), AT],
    );
    await raises(
      `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, status, created_at)
       VALUES ($1, 'someone@example.org', 's', 'b', 'test', 'system', 'bogus', $2)`,
      [uuidv7(), AT],
    );
  });

  test('the two history tables are append-only', async () => {
    const stateId = uuidv7();
    await pool.query(`INSERT INTO operations_state_changes (id, at, action, actor_id, reason, detail) VALUES ($1, $2, 'entered', NULL, 'low_space', '{}')`, [stateId, AT]);
    await raises(`UPDATE operations_state_changes SET reason = 'x'`);
    await raises(`DELETE FROM operations_state_changes`);
    await raises(`TRUNCATE operations_state_changes`);
    await raises(`UPDATE operations_settings_changes SET reason = 'x'`);
    await raises(`DELETE FROM operations_settings_changes`);
    await raises(`TRUNCATE operations_settings_changes`);
    await raises(`INSERT INTO operations_state_changes (id, at, action) VALUES ($1, $2, 'paused')`, [uuidv7(), AT]);
  });

  test('the tables the later tasks fill accept their documented values', async () => {
    const run = uuidv7();
    await pool.query(`INSERT INTO backup_runs (id, kind, started_at, outcome, source_area) VALUES ($1, 'daily', $2, 'running', 'not_in_use')`, [run, AT]);
    await pool.query(`INSERT INTO restore_drills (id, backup_run_id, started_at, outcome) VALUES ($1, $2, $3, 'passed_over_target')`, [uuidv7(), run, AT]);
    await pool.query(`INSERT INTO storage_readings (id, at, location, unavailable) VALUES ($1, $2, 'source_area', true)`, [uuidv7(), AT]);
    await pool.query(`INSERT INTO storage_daily (day, location) VALUES ('2026-11-20', 'backup_disk')`);
    await raises(`INSERT INTO backup_runs (id, kind, started_at, outcome) VALUES ($1, 'weekly', $2, 'running')`, [uuidv7(), AT]);
    await raises(`INSERT INTO storage_readings (id, at, location) VALUES ($1, $2, 'cloud')`, [uuidv7(), AT]);
  });
});
