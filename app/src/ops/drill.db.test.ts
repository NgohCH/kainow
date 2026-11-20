import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { refreshChecklist } from '../golive/checklist';
import { seedAiConnection, seedAiModel } from '../testing/ai-connections';
import { testProtectedKey } from '../testing/ai-runners';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { runBackup } from './backup';
import { OPS_FAILURES, withBackupLock } from './common';
import type { OpsConfig } from './config';
import { type Check, type DrillDeps, DRILL_TEXT, drillAgainReason, runRestoreDrill } from './drill';
import { PgTools } from './pg-tools';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const TB = 1024 ** 4;
const GB = 1024 ** 3;
const CHECK_NAMES = [
  'set_checksums',
  'decrypt',
  'migration_level',
  'space',
  'restore',
  'row_counts',
  'source_files',
  'sealed_ai_key',
  'sealed_quarantine',
  'sealed_storage_secret',
  'duration',
];

describe('restore drill', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let tools: PgTools;
  let toolsReady = false;
  let root: string;
  let folder: string;
  let keyFile: string;
  let clock = Date.parse('2026-11-21T02:00:00Z');
  const made: string[] = [];

  const needTools = (t: TestContext): boolean => {
    if (toolsReady) return true;
    if (process.env.CI) assert.fail('pg client tools not found (required in CI)');
    t.skip('pg client tools not found');
    return false;
  };
  const newKey = (): string => {
    const p = join(root, `k-${Date.now()}-${Math.random()}`);
    writeFileSync(p, randomBytes(32));
    return p;
  };
  const config = (over: Partial<OpsConfig> = {}): OpsConfig => ({
    databaseUrl: testDatabaseUrl() as string,
    backupDir: folder,
    backupKeyFile: keyFile,
    dbDataDir: '/pgdata',
    protectedKeyFile: null,
    folderLabel: '/srv/backups',
    ...over,
  });
  const setsDir = () => join(folder, 'kainow', 'sets');

  /** Makes a real set with runBackup and returns its name. */
  async function backup(argv: string[] = [], over: Partial<OpsConfig> = {}): Promise<string> {
    const out: string[] = [];
    const at = new Date((clock += 60_000));
    const code = await runBackup(argv, { pool, config: config(over), tools, now: () => at, out: (l) => out.push(l), err: () => undefined });
    assert.equal(code, 0, out.join('\n'));
    const id = /^run (\S+) succeeded$/.exec(out[out.length - 1])?.[1] as string;
    const name = readdirSync(setsDir()).find((n) => n.endsWith(id)) as string;
    assert.ok(name);
    return name;
  }

  async function drill(argv: string[] = [], over: Partial<DrillDeps> = {}, cfg: Partial<OpsConfig> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const at = new Date((clock += 60_000));
    const d: DrillDeps = {
      pool,
      config: config(cfg),
      tools,
      statfs: () => ({ total: 10 * TB, free: 5 * TB }),
      now: () => at,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      protectedKey: testProtectedKey(),
      ...over,
    };
    const code = await runRestoreDrill(argv, d);
    const runId = /^run (\S+) /.exec(out[out.length - 1] ?? '')?.[1];
    const row = runId ? (await pool.query('SELECT * FROM restore_drills WHERE id = $1', [runId])).rows[0] : undefined;
    if (row?.kept_database) made.push(row.kept_database);
    return { code, out, err, row };
  }
  const check = (row: { checks: Check[] }, name: string): Check | undefined => row.checks.find((c) => c.name === name);
  const drillDatabases = async (): Promise<string[]> =>
    (await pool.query(`SELECT datname FROM pg_database WHERE datname LIKE 'kainow\\_drill\\_%' ORDER BY datname`)).rows.map((r) => r.datname);
  const backupsStep = async () => (await pool.query(`SELECT ticked_at, ticked_by FROM golive_steps WHERE key = 'backups'`)).rows[0];

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    await seedUser(pool, 'dr-admin1@example.org', 'enterprise_administrator');
    await seedUser(pool, 'dr-admin2@example.org', 'enterprise_administrator');
    await pool.query('CREATE SCHEMA IF NOT EXISTS pgboss');
    await pool.query('DROP TABLE IF EXISTS pgboss.ops_drill_probe');
    await pool.query('CREATE TABLE pgboss.ops_drill_probe (n integer)');
    await pool.query('INSERT INTO pgboss.ops_drill_probe VALUES (1), (2), (3)');
    tools = new PgTools(testDatabaseUrl() as string);
    toolsReady = await tools.version().then(
      (v) => v === 16,
      () => false,
    );
    root = mkdtempSync(join(tmpdir(), 'kainow-dr-'));
  });
  after(async () => {
    for (const name of [...new Set([...made, ...(await drillDatabases())])]) {
      await pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    await pool.query('DROP TABLE IF EXISTS pgboss.ops_drill_probe');
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    folder = mkdtempSync(join(root, 'f-'));
    keyFile = newKey();
    await pool.query(`UPDATE operations_state SET protective = false, reason = NULL, since = NULL`);
    await pool.query('DELETE FROM restore_drills');
    await pool.query('DELETE FROM backup_runs');
  });

  test('a full drill passes with every check, then drops its database; the live database is untouched', async (t) => {
    if (!needTools(t)) return;
    const name = await backup();
    const before = (await pool.query(`SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM pgboss.ops_drill_probe)::int AS p`)).rows[0];
    const { code, out, err, row } = await drill();
    assert.equal(code, 0, [...out, ...err].join('\n'));
    assert.match(out[out.length - 1], /^run \S+ passed$/);
    assert.equal(row.outcome, 'passed');
    assert.equal(row.set_name, name);
    assert.equal(row.sampled, false);
    assert.equal(row.kept_database, null);
    assert.equal(typeof row.duration_seconds, 'number');
    assert.ok(row.finished_at);
    assert.equal(row.folder_label, '/srv/backups');
    assert.deepEqual(row.checks.map((c: Check) => c.name), CHECK_NAMES);
    for (const n of ['set_checksums', 'decrypt', 'migration_level', 'space', 'restore', 'row_counts', 'duration']) {
      assert.equal(check(row, n)?.result, 'passed', n);
    }
    for (const n of ['source_files', 'sealed_ai_key', 'sealed_quarantine', 'sealed_storage_secret']) {
      assert.equal(check(row, n)?.result, 'not_tested', n);
    }
    assert.deepEqual(await drillDatabases(), []);
    const after = (await pool.query(`SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM pgboss.ops_drill_probe)::int AS p`)).rows[0];
    assert.deepEqual(after, before);
    const audit = (await pool.query(`SELECT action FROM audit_events WHERE subject_id = $1`, [row.id])).rows;
    assert.deepEqual(audit, [{ action: 'ops.restore_drill_passed' }]);
    // Never a connection string or the backup folder in output.
    const text = [...out, ...err, JSON.stringify(row.checks)].join('\n');
    assert.ok(!text.includes('postgres://') && !text.includes(folder) && !text.includes('127.0.0.1'), text);
  });

  test('--keep leaves the database and records it; --drop removes it and refuses other names', async (t) => {
    if (!needTools(t)) return;
    await backup();
    const { code, row } = await drill(['--keep']);
    assert.equal(code, 0);
    assert.match(row.kept_database, /^kainow_drill_[0-9a-f]+$/);
    assert.deepEqual(await drillDatabases(), [row.kept_database]);

    const refused = await drill(['--drop', 'kainow_test_sp10']);
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.err, [DRILL_TEXT.dropRefused]);
    assert.equal((await pool.query(`SELECT 1 FROM pg_database WHERE datname = current_database()`)).rowCount, 1);

    const dropped = await drill(['--drop', row.kept_database]);
    assert.equal(dropped.code, 0, dropped.err.join('\n'));
    assert.deepEqual(await drillDatabases(), []);
    assert.equal((await pool.query('SELECT kept_database FROM restore_drills WHERE id = $1', [row.id])).rows[0].kept_database, null);
  });

  test('a row missing in the drill database fails row_counts, naming the table', async (t) => {
    if (!needTools(t)) return;
    await backup();
    const { code, row } = await drill([], {
      beforeRowCounts: async (db) => {
        await db.query('DELETE FROM pgboss.ops_drill_probe WHERE n = 2');
      },
    });
    assert.equal(code, 1);
    assert.equal(row.outcome, 'failed');
    const rc = check(row, 'row_counts') as Check;
    assert.equal(rc.result, 'failed');
    assert.match(rc.detail as string, /pgboss\.ops_drill_probe/);
    assert.deepEqual(await drillDatabases(), []);
    assert.deepEqual((await pool.query(`SELECT action FROM audit_events WHERE subject_id = $1`, [row.id])).rows, [{ action: 'ops.restore_drill_failed' }]);
    const notices = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'restore_drill_failed'`)).rows[0].n;
    assert.ok(notices >= 2);
  });

  test('a flipped byte in the dump fails set_checksums', async (t) => {
    if (!needTools(t)) return;
    const name = await backup();
    const file = join(setsDir(), name, 'database.dump.enc');
    const bytes = readFileSync(file);
    bytes[bytes.length - 40] ^= 0x01;
    writeFileSync(file, bytes);
    const { code, row } = await drill(['--set', name]);
    assert.equal(code, 1);
    assert.equal(row.outcome, 'failed');
    assert.equal(check(row, 'set_checksums')?.result, 'failed');
    assert.equal(check(row, 'restore')?.result, 'not_tested');
    assert.deepEqual(await drillDatabases(), []);
  });

  test('the wrong key is refused, naming the set key id; nothing is recorded', async (t) => {
    if (!needTools(t)) return;
    const name = await backup();
    const keyId = JSON.parse(readFileSync(join(setsDir(), name, 'backup.json'), 'utf8')).keyId as string;
    const { code, err, row } = await drill([], {}, { backupKeyFile: newKey() });
    assert.equal(code, 1);
    assert.deepEqual(err, [`This backup was made with key ${keyId}; mount that key to drill it`]);
    assert.equal(row, undefined);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM restore_drills')).rows[0].n, 0);
  });

  test('protective mode refuses, exit 1, nothing recorded', async () => {
    await pool.query(`UPDATE operations_state SET protective = true, reason = 'low_space', since = now()`);
    const { code, err } = await drill();
    assert.equal(code, 1);
    assert.deepEqual(err, ['Protective mode is on; run the drill once space is restored']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM restore_drills')).rows[0].n, 0);
  });

  test('no successful set is refused; a held lock is refused; a bad flag is usage', async () => {
    const none = await drill();
    assert.deepEqual([none.code, none.err], [1, [DRILL_TEXT.noSet]]);
    const busy = await withBackupLock(pool, () => drill());
    assert.ok(busy !== 'busy');
    assert.deepEqual([busy.code, busy.err], [1, ['Another backup or drill is running']]);
    const usage = await drill(['--nonsense']);
    assert.deepEqual([usage.code, usage.err], [2, [DRILL_TEXT.usage]]);
    assert.equal((await drill(['--sample', '0'])).code, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM restore_drills')).rows[0].n, 0);
  });

  test('too little free space before restoring is drill_no_space', async (t) => {
    if (!needTools(t)) return;
    await backup();
    const size = Number((await pool.query('SELECT pg_database_size(current_database())::text AS n')).rows[0].n);
    const need = size * 1.2 + 5 * GB + 2 * GB;
    const { code, err, row } = await drill([], { statfs: () => ({ total: 10 * TB, free: Math.floor(need) - 1 }) });
    assert.equal(code, 1);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.failure_code, 'drill_no_space');
    assert.equal(check(row, 'space')?.result, 'failed');
    assert.ok(err.includes(OPS_FAILURES.drill_no_space));
    assert.deepEqual(await drillDatabases(), []);
    // Exactly enough is enough.
    const ok = await drill([], { statfs: () => ({ total: 10 * TB, free: Math.ceil(need) }) });
    assert.equal(ok.row.outcome, 'passed');
  });

  test('free space falling during the restore is drill_space_low and the database is dropped', async (t) => {
    if (!needTools(t)) return;
    await backup();
    let calls = 0;
    const { code, row } = await drill([], {
      pollMs: 1,
      statfs: () => {
        calls++;
        return { total: 10 * TB, free: calls >= 3 ? 6 * GB : 5 * TB };
      },
    });
    assert.equal(code, 1);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.failure_code, 'drill_space_low');
    assert.equal(check(row, 'restore')?.result, 'failed');
    assert.ok(calls >= 3);
    assert.deepEqual(await drillDatabases(), []);
  });

  test('R22: a pg_restore still running at the time limit is killed: drill_database_failed, database dropped, lock free', async (t) => {
    if (!needTools(t)) return;
    await backup();
    let pid: number | undefined;
    class HangingRestore extends PgTools {
      restore(): ReturnType<PgTools['restore']> {
        // Reads nothing and never exits: a stuck server or share.
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'pipe' });
        pid = child.pid;
        return child;
      }
    }
    // Without the limit this never returns: the child neither reads its input nor exits.
    const { code, err, row } = await drill([], { tools: new HangingRestore(testDatabaseUrl() as string), toolTimeoutMs: 500 });
    assert.equal(code, 1);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.failure_code, 'drill_database_failed');
    assert.deepEqual(check(row, 'restore'), {
      name: 'restore',
      result: 'failed',
      detail: 'The restore into the drill database did not finish within 6 hours and was stopped.',
    });
    assert.ok(err.includes(OPS_FAILURES.drill_database_failed));
    let gone = false;
    try {
      process.kill(pid as number, 0);
    } catch {
      gone = true;
    }
    assert.ok(gone, 'the child was killed');
    assert.deepEqual(await drillDatabases(), [], 'the temporary database is dropped');
    assert.equal(await withBackupLock(pool, async () => 'got'), 'got', 'the lock is released');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'restore_drill_failed' AND created_at = $1`, [row.finished_at])).rows[0].n, 2);
  });

  test('M3: a drill the sweep already marked interrupted keeps that outcome; no second audit event or notice', async (t) => {
    if (!needTools(t)) return;
    await backup();
    const { code, row } = await drill([], {
      beforeRowCounts: async () => {
        await pool.query(`UPDATE restore_drills SET outcome = 'failed', failure_code = 'interrupted', finished_at = now() WHERE outcome = 'running'`);
      },
    });
    assert.equal(code, 0, 'the drill itself passed; the command says so');
    assert.deepEqual([row.outcome, row.failure_code], ['failed', 'interrupted']);
    assert.deepEqual(row.checks, [], 'the late result does not overwrite the interrupted row');
    assert.deepEqual((await pool.query(`SELECT action FROM audit_events WHERE subject_id = $1`, [row.id])).rows, []);
  });

  test('M4: a drill whose result cannot be recorded exits 1, not 0', async (t) => {
    if (!needTools(t)) return;
    await backup();
    // A constraint added for this test only makes the recording UPDATE fail, as a database gone at the end would.
    await pool.query(`ALTER TABLE restore_drills ADD CONSTRAINT m4_block CHECK (outcome <> 'passed') NOT VALID`);
    try {
      const { code, out, err } = await drill();
      assert.equal(code, 1);
      assert.ok(err.includes(DRILL_TEXT.recordFailed));
      assert.match(out[out.length - 1], /^run \S+ passed$/);
    } finally {
      await pool.query(`ALTER TABLE restore_drills DROP CONSTRAINT m4_block`);
    }
  });

  test('--sample records sampled; --set latest takes a set with no run row and never an -incomplete one', async (t) => {
    if (!needTools(t)) return;
    const name = await backup();
    // R7: a set with backup.json and no backup_runs row is a complete, succeeded set.
    await pool.query('DELETE FROM backup_runs');
    cpSync(join(setsDir(), name), join(setsDir(), `2099-01-01T0000Z-manual-x-incomplete`), { recursive: true });
    const { code, row } = await drill(['--sample', '1']);
    assert.equal(code, 0);
    assert.equal(row.sampled, true);
    assert.equal(row.set_name, name);
    assert.equal(row.backup_run_id, null);
    assert.equal(row.outcome, 'passed');
    await refreshChecklist(pool, new Date(clock));
    assert.equal((await backupsStep()).ticked_at, null, 'a sampled drill never ticks step 8');
  });

  test('step 8 ticks after a passed full drill and unticks when the key, folder or source area changes', async (t) => {
    if (!needTools(t)) return;
    await pool.query(`UPDATE golive_steps SET ticked_at = NULL, ticked_by = NULL WHERE key = 'backups'`);
    await backup();
    assert.equal(await drillAgainReason(pool), null);
    const { row } = await drill();
    assert.equal(row.outcome, 'passed');
    assert.equal(await drillAgainReason(pool), null);
    await refreshChecklist(pool, new Date((clock += 1000)));
    const ticked = await backupsStep();
    assert.ok(ticked.ticked_at);
    assert.equal(ticked.ticked_by, null);

    // A later backup made with a new key.
    keyFile = newKey();
    await backup(['--new-key']);
    assert.equal(await drillAgainReason(pool), 'key_changed');
    await refreshChecklist(pool, new Date((clock += 1000)));
    assert.equal((await backupsStep()).ticked_at, null);
    const events = (await pool.query(`SELECT action, actor_id FROM golive_events WHERE step_key = 'backups' ORDER BY at, id`)).rows;
    assert.deepEqual(events.slice(-2), [
      { action: 'ticked', actor_id: null },
      { action: 'unticked', actor_id: null },
    ]);

    // A new drill passes again; then the folder label changes.
    assert.equal((await drill()).row.outcome, 'passed');
    assert.equal(await drillAgainReason(pool), null);
    await backup([], { folderLabel: '/srv/other-backups' });
    assert.equal(await drillAgainReason(pool), 'folder_changed');

    // Drilled on the new folder, then the source area comes into use.
    assert.equal((await drill([], {}, { folderLabel: '/srv/other-backups' })).row.outcome, 'passed');
    assert.equal(await drillAgainReason(pool), null);
    await pool.query(`UPDATE backup_runs SET source_area = 'included' WHERE id = (SELECT id FROM backup_runs ORDER BY finished_at DESC, id DESC LIMIT 1)`);
    assert.equal(await drillAgainReason(pool), 'source_area_new');
  });

  test('a drill over the 4-hour target is passed_over_target and does not tick step 8', async (t) => {
    if (!needTools(t)) return;
    await pool.query(`UPDATE golive_steps SET ticked_at = NULL, ticked_by = NULL WHERE key = 'backups'`);
    await backup();
    let at = clock;
    const { code, row } = await drill([], { now: () => new Date((at += 5 * 3_600_000)) });
    assert.equal(code, 0);
    assert.equal(row.outcome, 'passed_over_target');
    assert.ok(row.duration_seconds >= 4 * 3600);
    assert.equal(check(row, 'duration')?.result, 'failed');
    await refreshChecklist(pool, new Date(at));
    assert.equal((await backupsStep()).ticked_at, null);
  });

  test('sealed values: a sealed AI key fails without the protected key and passes with it', async (t) => {
    if (!needTools(t)) return;
    const admin = (await pool.query(`SELECT id FROM users ORDER BY email LIMIT 1`)).rows[0].id;
    const projectId = await seedProject(pool, { members: [{ userId: admin, role: 'pm' }] });
    const model = await seedAiModel(pool);
    await seedAiConnection(pool, { projectId, model, position: 1, protectedKey: testProtectedKey() });
    await backup();

    const without = await drill([], { protectedKey: null });
    assert.equal(without.code, 1);
    assert.equal(without.row.outcome, 'failed');
    assert.equal(check(without.row, 'sealed_ai_key')?.result, 'failed');
    assert.equal(check(without.row, 'sealed_quarantine')?.result, 'not_tested');

    const withKey = await drill();
    assert.equal(withKey.code, 0);
    assert.equal(withKey.row.outcome, 'passed');
    assert.equal(check(withKey.row, 'sealed_ai_key')?.result, 'passed');
    assert.equal(check(withKey.row, 'sealed_quarantine')?.result, 'not_tested');
    assert.equal(check(withKey.row, 'sealed_storage_secret')?.result, 'not_tested');
  });
});
