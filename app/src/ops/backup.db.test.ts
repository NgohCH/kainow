import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { runBackup, type BackupDeps } from './backup';
import { OPS_FAILURES, codeMigrationLevel, withBackupLock } from './common';
import type { OpsConfig } from './config';
import { loadBackupKey, type BackupKey } from './crypto';
import { readSet } from './manifest';
import { PgTools } from './pg-tools';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

/** pg_dump that starts, then exits 1 without writing. */
class FailingDump extends PgTools {
  dump(): ReturnType<PgTools['dump']> {
    return spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'pipe' });
  }
}

describe('backup command', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let tools: PgTools;
  let toolsReady = false;
  let root: string;
  let folder: string;
  let keyFile: string;
  let clock = Date.parse('2026-11-21T02:00:00Z');

  const needTools = (t: TestContext): boolean => {
    if (toolsReady) return true;
    if (process.env.CI) assert.fail('pg client tools not found (required in CI)');
    t.skip('pg client tools not found');
    return false;
  };

  const newKey = (name: string): string => {
    const p = join(root, name);
    writeFileSync(p, randomBytes(32));
    return p;
  };
  const key = (p = keyFile): BackupKey => loadBackupKey(p) as BackupKey;

  function deps(over: Partial<OpsConfig> = {}, extra: Partial<BackupDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const at = new Date((clock += 60_000));
    const config: OpsConfig = {
      databaseUrl: testDatabaseUrl() as string,
      backupDir: folder,
      backupKeyFile: keyFile,
      dbDataDir: '/pgdata',
      protectedKeyFile: null,
      folderLabel: '/srv/backups',
      ...over,
    };
    const d: BackupDeps = { pool, config, tools, now: () => at, out: (l) => out.push(l), err: (l) => err.push(l), ...extra };
    return { d, out, err, at };
  }

  const lastLine = (out: string[]): string => out[out.length - 1] ?? '';
  const runIdOf = (out: string[]): string => /^run (\S+) /.exec(lastLine(out))?.[1] ?? '';
  const row = async (id: string) => (await pool.query('SELECT * FROM backup_runs WHERE id = $1', [id])).rows[0];
  const audits = async (id: string) =>
    (await pool.query('SELECT action, detail FROM audit_events WHERE subject_id = $1 ORDER BY occurred_at, id', [id])).rows;
  const failedNotices = async (at: Date) =>
    (await pool.query(`SELECT user_id FROM notifications WHERE kind = 'backup_failed' AND created_at = $1 ORDER BY user_id`, [at])).rows;
  const setsDir = () => join(folder, 'kainow', 'sets');

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    await seedUser(pool, 'bk-admin1@example.org', 'enterprise_administrator');
    await seedUser(pool, 'bk-admin2@example.org', 'enterprise_administrator');
    await seedUser(pool, 'bk-member@example.org', 'member');
    await pool.query('CREATE SCHEMA IF NOT EXISTS pgboss');
    await pool.query('DROP TABLE IF EXISTS pgboss.ops_backup_probe');
    await pool.query('CREATE TABLE pgboss.ops_backup_probe (n integer)');
    await pool.query('INSERT INTO pgboss.ops_backup_probe VALUES (1), (2), (3)');
    tools = new PgTools(testDatabaseUrl() as string);
    toolsReady = await tools.version().then(
      (v) => v === 16,
      () => false,
    );
    root = mkdtempSync(join(tmpdir(), 'kainow-bk-'));
  });
  after(async () => {
    await pool.query('DROP TABLE IF EXISTS pgboss.ops_backup_probe');
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    folder = mkdtempSync(join(root, 'f-'));
    keyFile = newKey(`k-${Date.now()}-${Math.random()}`);
    await pool.query('DELETE FROM backup_runs');
  });

  test('a successful run writes a complete set, a succeeded row and the audit event', async (t) => {
    if (!needTools(t)) return;
    const { d, out, at } = deps();
    assert.equal(await runBackup([], d), 0);
    assert.match(lastLine(out), /^run \S+ succeeded$/);
    const id = runIdOf(out);

    const name = `2026-11-21T${at.toISOString().slice(11, 13)}${at.toISOString().slice(14, 16)}Z-manual-${id}`;
    assert.deepEqual(readdirSync(setsDir()), [name]);
    const dir = join(setsDir(), name);
    assert.deepEqual(readdirSync(dir).sort(), ['backup.json', 'database.dump.enc', 'manifest.json.enc']);

    const { summary, manifest } = await readSet(dir, key());
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.runId, id);
    assert.equal(manifest.sourceArea, 'not_in_use');
    assert.deepEqual(manifest.sourceFiles, []);
    const tables = (
      await pool.query(
        `SELECT schemaname AS schema, tablename AS table FROM pg_tables WHERE schemaname IN ('public', 'pgboss') ORDER BY 1, 2`,
      )
    ).rows;
    assert.deepEqual(
      manifest.tables.map((x) => `${x.schema}.${x.table}`),
      tables.map((x) => `${x.schema}.${x.table}`),
    );
    for (const x of manifest.tables) {
      const n = (await pool.query(`SELECT count(*)::int AS n FROM "${x.schema}"."${x.table}"`)).rows[0].n;
      // The run's own audit event is written after the snapshot; its running row before it.
      assert.equal(x.rows, x.table === 'audit_events' ? n - 1 : n, `${x.schema}.${x.table}`);
    }
    assert.equal(manifest.tables.find((x) => x.schema === 'pgboss' && x.table === 'ops_backup_probe')?.rows, 3);
    assert.equal(manifest.tables.find((x) => x.schema === 'public' && x.table === 'users')?.rows, 3);

    const r = await row(id);
    assert.equal(r.outcome, 'succeeded');
    assert.equal(r.kind, 'manual');
    assert.equal(r.set_name, name);
    assert.equal(r.folder_label, '/srv/backups');
    assert.equal(r.key_id, key().id);
    assert.equal(r.migration_level, codeMigrationLevel());
    assert.equal(r.source_area, 'not_in_use');
    assert.equal(r.failure_code, null);
    assert.ok(Number(r.database_bytes) > 0);
    assert.equal(Number(r.database_bytes), readFileSync(join(dir, 'database.dump.enc')).length);
    assert.ok(r.finished_at);
    assert.equal(summary.runId, id);
    assert.equal(summary.kind, 'manual');
    assert.equal(summary.keyId, key().id);
    assert.equal(summary.migrationLevel, codeMigrationLevel());
    assert.equal(r.manifest_sha256, summary.files['manifest.json.enc'].sha256);
    assert.deepEqual(
      (await audits(id)).map((a) => a.action),
      ['ops.backup_succeeded'],
    );
  });

  test('a missing backup folder fails with folder_missing, a failed row and one notice per administrator', async () => {
    const { d, out, at } = deps({ backupDir: join(root, 'not-there') });
    assert.equal(await runBackup([], d), 1);
    assert.match(lastLine(out), /^run \S+ failed folder_missing$/);
    const r = await row(runIdOf(out));
    assert.equal(r.outcome, 'failed');
    assert.equal(r.failure_code, 'folder_missing');
    assert.equal(r.failure_detail, OPS_FAILURES.folder_missing);
    assert.ok(r.finished_at);
    assert.equal((await failedNotices(at)).length, 2);
    assert.deepEqual(
      (await audits(r.id)).map((a) => a.action),
      ['ops.backup_failed'],
    );
  });

  test('a missing key file is key_missing; a wrong-length one is key_invalid', async () => {
    let { d, out } = deps({ backupKeyFile: join(root, 'no-key') });
    assert.equal(await runBackup([], d), 1);
    assert.match(lastLine(out), /failed key_missing$/);

    const short = join(root, 'short.key');
    writeFileSync(short, randomBytes(31));
    ({ d, out } = deps({ backupKeyFile: short }));
    assert.equal(await runBackup([], d), 1);
    assert.match(lastLine(out), /failed key_invalid$/);
    assert.equal((await row(runIdOf(out))).failure_code, 'key_invalid');
  });

  test('a changed key is refused with key_changed; --new-key proceeds and records the change', async (t) => {
    if (!needTools(t)) return;
    let { d, out } = deps();
    assert.equal(await runBackup([], d), 0);
    const first = key().id;

    const other = newKey('other.key');
    ({ d, out } = deps({ backupKeyFile: other }));
    assert.equal(await runBackup([], d), 1);
    assert.match(lastLine(out), /failed key_changed$/);

    ({ d, out } = deps({ backupKeyFile: other }));
    assert.equal(await runBackup(['--new-key'], d), 0);
    const id = runIdOf(out);
    const events = await audits(id);
    assert.deepEqual(
      events.map((a) => a.action).sort(),
      ['ops.backup_key_changed', 'ops.backup_succeeded'],
    );
    const changed = events.find((a) => a.action === 'ops.backup_key_changed');
    assert.deepEqual(changed.detail, { previousKeyId: first, keyId: key(other).id });
  });

  test('while the lock is held, the run refuses and records nothing', async () => {
    const { d, out, err } = deps();
    const code = await withBackupLock(pool, () => runBackup([], d));
    assert.equal(code, 1);
    assert.ok([...out, ...err].includes('Another backup or drill is running'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM backup_runs')).rows[0].n, 0);
  });

  test('a failing pg_dump is dump_failed and leaves an -incomplete set without backup.json', async () => {
    const { d, out } = deps({}, { tools: new FailingDump(testDatabaseUrl() as string) });
    assert.equal(await runBackup([], d), 1);
    assert.match(lastLine(out), /failed dump_failed$/);
    const sets = readdirSync(setsDir());
    assert.equal(sets.length, 1);
    assert.match(sets[0], /-incomplete$/);
    assert.equal(existsSync(join(setsDir(), sets[0], 'backup.json')), false);
    const r = await row(runIdOf(out));
    assert.equal(r.outcome, 'failed');
    assert.equal(r.set_name, sets[0]);
  });

  test('a file changed after it was written is verify_failed', async (t) => {
    if (!needTools(t)) return;
    const corrupt = (file: string) => {
      if (!file.endsWith('database.dump.enc')) return;
      const b = readFileSync(file);
      b[Math.floor(b.length / 2)] ^= 0xff;
      writeFileSync(file, b);
    };
    const { d, out } = deps({}, { afterWrite: corrupt });
    assert.equal(await runBackup([], d), 1);
    assert.match(lastLine(out), /failed verify_failed$/);
    const sets = readdirSync(setsDir());
    assert.match(sets[0], /-incomplete$/);
    assert.equal(existsSync(join(setsDir(), sets[0], 'backup.json')), false);
  });

  test('a full disk while writing is no_space; a folder gone mid-run is folder_missing', async (t) => {
    if (!needTools(t)) return;
    const full = () => {
      throw Object.assign(new Error('write failed'), { code: 'ENOSPC' });
    };
    let { d, out } = deps({}, { afterWrite: full });
    assert.equal(await runBackup([], d), 1);
    assert.match(lastLine(out), /failed no_space$/);

    const gone = (file: string) => {
      if (!file.endsWith('database.dump.enc')) return;
      rmSync(folder, { recursive: true, force: true });
      throw Object.assign(new Error('write failed'), { code: 'EIO' });
    };
    ({ d, out } = deps({}, { afterWrite: gone }));
    assert.equal(await runBackup([], d), 1);
    assert.match(lastLine(out), /failed folder_missing$/);
    assert.equal((await row(runIdOf(out))).outcome, 'failed');
  });

  test('--kind pre_update records kind pre_update', async (t) => {
    if (!needTools(t)) return;
    const { d, out } = deps();
    assert.equal(await runBackup(['--kind', 'pre_update'], d), 0);
    const r = await row(runIdOf(out));
    assert.equal(r.kind, 'pre_update');
    assert.match(r.set_name, /-pre_update-/);
  });

  test('a bad flag or kind is a usage error', async () => {
    for (const argv of [['--kind', 'weekly'], ['--kind'], ['--what']]) {
      const { d, err } = deps();
      assert.equal(await runBackup(argv, d), 2);
      assert.match(err.join('\n'), /Usage/);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM backup_runs')).rows[0].n, 0);
  });

  test('an unreachable database prints the fixed text and exits 1', async () => {
    const dead = new Pool({ connectionString: 'postgres://postgres:test@127.0.0.1:1/none', connectionTimeoutMillis: 2000 });
    try {
      const { d, out, err } = deps({}, { pool: dead });
      assert.equal(await runBackup([], d), 1);
      assert.ok([...out, ...err].includes(OPS_FAILURES.database_unreachable));
    } finally {
      await dead.end();
    }
  });

  test('no stored failure text or output names the backup folder path', async () => {
    const { d, out, err } = deps({ backupDir: join(root, 'missing-again') });
    await runBackup([], d);
    const { rows } = await pool.query('SELECT failure_detail FROM backup_runs WHERE failure_detail IS NOT NULL');
    assert.ok(rows.length > 0);
    for (const r of rows) assert.ok(!r.failure_detail.includes(root));
    for (const line of [...out, ...err]) assert.ok(!line.includes(root));
  });
});
