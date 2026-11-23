import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { afterRestore } from '../ops/after-restore';
import type { BackupSummary } from '../ops/manifest';
import { notifyAdmins } from '../ops/notify';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { decideSituation, finishWithoutRestore, fixRestoredRecord, inspectKainow, recoveredSummary } from './recover';

/**
 * Two databases: the test database stands for the restored `kainow`, and `<it>_failed` for the set-aside one. Both are
 * test databases made for this task (kainow_test_sp10b and kainow_test_sp10b_failed).
 */
const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const failedUrl = (): string | undefined => {
  const u = testDatabaseUrl();
  if (!u) return undefined;
  const url = new URL(u);
  url.pathname = `${url.pathname}_failed`;
  return url.toString();
};

const NOW = new Date('2026-12-01T05:00:00Z');
const BACKUP_AT = new Date('2026-12-01T04:00:20Z');
const ID = '0190a1b2-c3d4-7000-8000-000000000001';
const RUN_ID = '0190a000-0000-7000-8000-00000000beef';
const SET = '20261201T040020Z-pre_update';
const step = (n: number) => `0190a1b2-c3d4-7000-8000-0000000001${String(n).padStart(2, '0')}`;
const at = (s: number) => new Date(Date.parse('2026-12-01T04:00:00Z') + s * 1000);

async function wipe(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL session_replication_role = replica`);
    for (const tbl of [
      'update_steps', 'update_changes', 'updates', 'email_attempts', 'notifications', 'email_outbox', 'audit_events',
      'operations_state_changes', 'backup_runs', 'sessions', 'users',
    ]) {
      await c.query(`DELETE FROM ${tbl}`);
    }
    await c.query(`UPDATE operations_state SET protective = false, reason = NULL, since = NULL, detail = NULL, changed_by = NULL WHERE id`);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/** The pre-update backup run, the update and its steps; `when` picks the restored (as dumped) or the failed database. */
async function seedUpdate(pool: Pool, admin: string, when: 'dumped' | 'failed', state = when === 'dumped' ? 'installing' : 'failed_after_migration') {
  await pool.query(
    `INSERT INTO backup_runs (id, kind, started_at, outcome, set_name, finished_at) VALUES ($1, 'pre_update', $2, $3, $4, $5)`,
    [RUN_ID, BACKUP_AT, when === 'dumped' ? 'running' : 'succeeded', SET, when === 'dumped' ? null : at(90)],
  );
  await pool.query(
    `INSERT INTO updates (id, from_version, to_version, tag, commit, tag_object, state, starts_at, expected_minutes, approved_by, approved_at, reason,
                          pre_update_backup_run_id, failure_code, finished_at)
     VALUES ($1, '1.0.0', '1.1.0', 'v1.1.0', $2, $3, $4, $5, 30, $6, $7, 'Monthly release', $8, $9, $10)`,
    [
      ID, 'cd'.repeat(20), 'ab'.repeat(20), state, at(0), admin, new Date('2026-11-28T00:00:00Z'),
      when === 'dumped' ? null : RUN_ID, when === 'dumped' ? null : 'migration_failed', when === 'dumped' ? null : at(200),
    ],
  );
  const steps: Array<[number, string, number, number | null, string, string | null]> =
    when === 'dumped'
      ? [
          [1, 'recheck', 1, 2, 'passed', null],
          [2, 'maintenance_on', 3, 18, 'passed', null],
          [3, 'backup', 19, null, 'running', null],
        ]
      : [
          [1, 'recheck', 1, 2, 'passed', null],
          [2, 'maintenance_on', 3, 18, 'passed', null],
          [3, 'backup', 19, 90, 'passed', null],
          [4, 'stop', 91, 95, 'passed', null],
          [5, 'switch_code', 96, 97, 'passed', null],
          [6, 'migrate', 98, 150, 'failed', 'migration_failed'],
          [7, 'notice_page', 151, 160, 'passed', null],
        ];
  for (const [n, name, s, f, outcome, code] of steps) {
    await pool.query(`INSERT INTO update_steps (id, update_id, step, started_at, finished_at, outcome, failure_code) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      step(n), ID, name, at(s), f === null ? null : at(f), outcome, code,
    ]);
  }
  if (when === 'dumped') {
    // Update maintenance was on while the pre-update backup ran.
    await pool.query(`UPDATE operations_state SET protective = true, reason = 'update', since = $1, detail = $2 WHERE id`, [
      at(3),
      JSON.stringify({ updateId: ID, version: '1.1.0' }),
    ]);
  }
}

const SUMMARY: BackupSummary = {
  formatVersion: 1,
  runId: RUN_ID,
  kind: 'pre_update',
  startedAt: BACKUP_AT.toISOString(),
  finishedAt: at(89).toISOString(),
  keyId: 'k1',
  kainowVersion: '1.0.0',
  migrationLevel: '0035_updates.sql',
  databaseBytes: 1000,
  fileCount: 0,
  sourceArea: 'not_in_use',
  files: {
    'database.dump.enc': { sha256: 'a'.repeat(64), bytes: 10, plainSha256: 'b'.repeat(64) },
    'manifest.json.enc': { sha256: 'c'.repeat(64), bytes: 10 },
  },
};

describe('recover in the databases (spec 5.9, Review Focus 5)', { skip: SKIP_NO_DB }, () => {
  let restored: Pool;
  let failed: Pool;
  let admins: string[];
  let disabled: string;
  let lines: string[];

  before(async () => {
    restored = new Pool({ connectionString: testDatabaseUrl() });
    // The set-aside database is made on first use (CI starts with only the test database).
    const failedName = decodeURIComponent(new URL(failedUrl()!).pathname.slice(1));
    const exists = await restored.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [failedName]);
    if (exists.rowCount === 0) await restored.query(`CREATE DATABASE "${failedName.replace(/"/g, '""')}"`);
    failed = new Pool({ connectionString: failedUrl() });
    for (const p of [restored, failed]) {
      await resetPublicSchema(p);
      await runMigrations(p, migrationsDir);
    }
  });
  after(async () => {
    await restored.end();
    await failed.end();
  });
  beforeEach(async () => {
    lines = [];
    await wipe(restored);
    await wipe(failed);
    for (const p of [restored, failed]) {
      // The same people in both (the failed database started as the restored one).
      await p.query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, 'rec-a@example.org', 'a', 'enterprise_administrator')`, [
        '0190a000-0000-7000-8000-0000000000a1',
      ]);
      await p.query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, 'rec-b@example.org', 'b', 'enterprise_administrator')`, [
        '0190a000-0000-7000-8000-0000000000a2',
      ]);
      await p.query(
        `INSERT INTO users (id, email, display_name, role, status) VALUES ($1, 'rec-off@example.org', 'off', 'enterprise_administrator', 'disabled')`,
        ['0190a000-0000-7000-8000-0000000000a3'],
      );
      await seedUser(p, 'rec-member@example.org');
    }
    admins = ['0190a000-0000-7000-8000-0000000000a1', '0190a000-0000-7000-8000-0000000000a2'];
    disabled = '0190a000-0000-7000-8000-0000000000a3';
  });

  /** The restored database as 10a's restore leaves it: the dump of the moment the backup ran, then afterRestore. */
  async function restoreLikeTenA(): Promise<void> {
    await seedUpdate(restored, admins[0], 'dumped');
    // Something queued at backup time (the approval email, say): the restore marks it not sent.
    await notifyAdmins(restored, { kind: 'update_scheduled', summary: 'Kainow will be unavailable.', link: null, now: at(-60), urgent: true });
    await inTx(restored, (c) => afterRestore(c, { setTime: BACKUP_AT, setName: SET, reason: 'Recovering from failed update to v1.1.0', now: NOW, summary: SUMMARY }));
  }

  test('after fixRestoredRecord the restored database has no installing row, the update is recovered, its steps include the failed ones, an update_failed notice and outbox rows exist for each Active Enterprise Administrator and are not marked not_sent_restored', async () => {
    await seedUpdate(failed, admins[0], 'failed');
    await restoreLikeTenA();
    await fixRestoredRecord(restored, failed, ID, RUN_ID, 'migration_failed', NOW, (l) => lines.push(l));

    assert.deepEqual((await restored.query(`SELECT id FROM updates WHERE state = 'installing'`)).rows, []);
    const u = (await restored.query(`SELECT state, failure_code, finished_at, recovery_backup_run_id, pre_update_backup_run_id FROM updates WHERE id = $1`, [ID])).rows[0];
    assert.equal(u.state, 'recovered');
    assert.equal(u.failure_code, 'migration_failed');
    assert.equal(u.finished_at.toISOString(), NOW.toISOString());
    assert.equal(u.recovery_backup_run_id, RUN_ID);
    assert.equal(u.pre_update_backup_run_id, RUN_ID);

    const steps = (await restored.query(`SELECT step, outcome, failure_code FROM update_steps WHERE update_id = $1 ORDER BY started_at, id`, [ID])).rows;
    assert.deepEqual(
      steps.map((s) => `${s.step} ${s.outcome}${s.failure_code ? ` ${s.failure_code}` : ''}`),
      ['recheck passed', 'maintenance_on passed', 'backup passed', 'stop passed', 'switch_code passed', 'migrate failed migration_failed', 'notice_page passed'],
    );

    const notices = (
      await restored.query(
        `SELECT n.user_id, n.urgent, n.summary, o.status, o.kind FROM notifications n JOIN email_outbox o ON o.id = n.outbox_id
          WHERE n.kind = 'update_failed' ORDER BY n.user_id`,
      )
    ).rows;
    assert.deepEqual(notices.map((n) => n.user_id), admins);
    assert.ok(!notices.some((n) => n.user_id === disabled));
    for (const n of notices) {
      assert.equal(n.urgent, true);
      assert.equal(n.status, 'queued');
      assert.equal(n.kind, 'update_failed');
      assert.equal(n.summary, recoveredSummary('v1.1.0', '1.0.0', 'migration_failed', true));
    }
    // What was queued at backup time is not sent; what recover wrote is.
    const old = (await restored.query(`SELECT status FROM email_outbox WHERE kind = 'update_scheduled'`)).rows;
    assert.ok(old.length > 0);
    assert.ok(old.every((r) => r.status === 'not_sent_restored'));

    const audit = (await restored.query(`SELECT subject_id, detail FROM audit_events WHERE action = 'ops.update_recovered'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].subject_id, ID);
    assert.equal(audit[0].detail.failureCode, 'migration_failed');
    const change = (await restored.query(`SELECT detail FROM update_changes WHERE update_id = $1 AND action = 'state_changed'`, [ID])).rows;
    assert.deepEqual(change.map((c) => [c.detail.from, c.detail.to]), [['installing', 'recovered']]);
    assert.deepEqual(lines, []);
  });

  test('the restored pre_update backup row is succeeded (10a after-restore) and operations_state reason is restored_from_backup, not update', async () => {
    await seedUpdate(failed, admins[0], 'failed');
    await restoreLikeTenA();
    await fixRestoredRecord(restored, failed, ID, RUN_ID, 'migration_failed', NOW);

    assert.deepEqual((await restored.query(`SELECT id FROM backup_runs WHERE outcome = 'running'`)).rows, []);
    assert.equal((await restored.query(`SELECT outcome FROM backup_runs WHERE id = $1`, [RUN_ID])).rows[0].outcome, 'succeeded');
    const s = (await restored.query(`SELECT protective, reason FROM operations_state WHERE id`)).rows[0];
    assert.equal(s.protective, true);
    assert.equal(s.reason, 'restored_from_backup');
    // Recover is then where it decides: the restored database no longer looks like anything to recover.
    const found = await inspectKainow(restored);
    assert.equal(found.latest?.state, 'recovered');
    assert.equal(decideSituation({ kainow: found, setAside: null }).kind, 'refused');
  });

  test('the set-aside database cannot be read: the record is still put right, with a note; no step left running', async () => {
    await restoreLikeTenA();
    const gone = new Pool({ connectionString: failedUrl() });
    await gone.end(); // a pool that cannot be used
    await fixRestoredRecord(restored, gone, ID, RUN_ID, 'migration_failed', NOW, (l) => lines.push(l));
    assert.equal((await restored.query(`SELECT state FROM updates WHERE id = $1`, [ID])).rows[0].state, 'recovered');
    assert.deepEqual((await restored.query(`SELECT step FROM update_steps WHERE outcome = 'running'`)).rows, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /could not be read from the set-aside database/);
    assert.equal((await restored.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_failed'`)).rows[0].n, 2);
  });

  test('a database that does not hold the update as installing is not touched', async () => {
    await restoreLikeTenA();
    await restored.query(`UPDATE updates SET state = 'succeeded' WHERE id = $1`, [ID]);
    await assert.rejects(fixRestoredRecord(restored, failed, ID, RUN_ID, 'migration_failed', NOW));
    assert.equal((await restored.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_failed'`)).rows[0].n, 0);
    assert.equal((await restored.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.update_recovered'`)).rows[0].n, 0);
  });

  test('failed_needs_attention: update maintenance ends (recorded), the update is recovered and the Administrators told', async () => {
    await seedUpdate(restored, admins[0], 'failed', 'failed_needs_attention');
    await restored.query(`UPDATE updates SET failure_code = 'rollback_failed' WHERE id = $1`, [ID]);
    await restored.query(`UPDATE operations_state SET protective = true, reason = 'update', since = $1, detail = $2 WHERE id`, [
      at(3),
      JSON.stringify({ updateId: ID, version: '1.1.0' }),
    ]);
    assert.equal(await finishWithoutRestore(restored, ID, NOW), true);

    const s = (await restored.query(`SELECT protective, reason FROM operations_state WHERE id`)).rows[0];
    assert.equal(s.protective, false);
    assert.equal(s.reason, null);
    const changes = (await restored.query(`SELECT action, detail FROM operations_state_changes ORDER BY at, id`)).rows;
    assert.deepEqual(changes.map((c) => [c.action, c.detail.previousReason, c.detail.outcome]), [['resumed', 'update', 'recovered']]);
    const u = (await restored.query(`SELECT state, failure_code, recovery_backup_run_id FROM updates WHERE id = $1`, [ID])).rows[0];
    assert.deepEqual([u.state, u.failure_code, u.recovery_backup_run_id], ['recovered', 'rollback_failed', null]);
    const notices = (
      await restored.query(
        `SELECT n.user_id, n.summary, o.status FROM notifications n JOIN email_outbox o ON o.id = n.outbox_id WHERE n.kind = 'update_failed' ORDER BY n.user_id`,
      )
    ).rows;
    assert.deepEqual(notices.map((n) => n.user_id), admins);
    assert.ok(notices.every((n) => n.status === 'queued' && n.summary === recoveredSummary('v1.1.0', '1.0.0', 'rollback_failed', false)));
    assert.equal((await restored.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ops.update_recovered'`)).rows[0].n, 1);

    // Run again: nothing more.
    assert.equal(await finishWithoutRestore(restored, ID, NOW), false);
    assert.equal((await restored.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'update_failed'`)).rows[0].n, 2);
  });

  test('inspectKainow reads the latest update with its pre-update set', async () => {
    await seedUpdate(failed, admins[0], 'failed');
    const f = await inspectKainow(failed);
    assert.equal(f.latest?.state, 'failed_after_migration');
    assert.equal(f.latest?.preUpdateSet, SET);
    assert.equal(f.latest?.preUpdateRunId, RUN_ID);
    assert.equal(f.latest?.failureCode, 'migration_failed');
    assert.equal(decideSituation({ kainow: f, setAside: null }).kind, 'fresh');
  });
});
