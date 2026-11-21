import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { runBackup, setStamp, type BackupDeps } from './backup';
import type { OpsConfig } from './config';
import { encryptStream, loadBackupKey, sha256Stream, type BackupKey } from './crypto';
import { expireBackups } from './expiry';
import type { BackupKind, Manifest } from './manifest';
import { PgTools } from './pg-tools';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const DAY = 86_400_000;
const NOW = new Date('2026-11-21T12:00:00Z');

class FailingDump extends PgTools {
  dump(): ReturnType<PgTools['dump']> {
    return spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'pipe' });
  }
}

describe('backup expiry', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let root: string;
  let folder: string;
  let keyFile: string;
  let key: BackupKey;
  let toolsReady = false;
  let tools: PgTools;

  const config = (): OpsConfig => ({
    databaseUrl: testDatabaseUrl() as string,
    backupDir: folder,
    backupKeyFile: keyFile,
    dbDataDir: '/pgdata',
    protectedKeyFile: null,
    folderLabel: '/srv/backups',
  });
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const setsDir = () => join(folder, 'kainow', 'sets');
  // The store is kept per backup key (R30): files/<key id>/<2>/<sha>.enc.
  const filePath = (h: string) => join(folder, 'kainow', 'files', key.id, h.slice(0, 2), `${h}.enc`);
  const putFile = (h: string) => {
    mkdirSync(join(folder, 'kainow', 'files', key.id, h.slice(0, 2)), { recursive: true });
    writeFileSync(filePath(h), 'x');
  };

  /** A finished set on disk with a real encrypted manifest, plus its backup_runs row. */
  async function makeSet(ageDays: number, files: string[], kind: BackupKind = 'daily', succeeded = true, withRow = true) {
    const runId = uuidv7();
    const finished = new Date(NOW.getTime() - ageDays * DAY);
    const name = `${setStamp(finished)}-${kind}-${runId}`;
    const dir = join(setsDir(), name);
    mkdirSync(dir, { recursive: true });
    const manifest: Manifest = {
      formatVersion: 1,
      runId,
      tables: [],
      sourceFiles: files.map((s) => ({ sha256: s, size: 1, storedFileId: 'x', copied: true })),
      sourceArea: 'included',
    };
    const hash = sha256Stream();
    await pipeline(Readable.from([Buffer.from(JSON.stringify(manifest))]), encryptStream(key), hash, createWriteStream(join(dir, 'manifest.json.enc')));
    writeFileSync(join(dir, 'database.dump.enc'), 'd');
    writeFileSync(
      join(dir, 'backup.json'),
      JSON.stringify({ formatVersion: 1, runId, kind, finishedAt: finished.toISOString(), files: { 'manifest.json.enc': { sha256: hash.digest(), bytes: 1 } } }),
    );
    if (withRow) {
      await pool.query(
        `INSERT INTO backup_runs (id, kind, started_at, finished_at, outcome, set_name) VALUES ($1, $2, $3, $3, $4, $5)`,
        [runId, kind, finished, succeeded ? 'succeeded' : 'failed', name],
      );
    }
    return { runId, name, dir };
  }

  const present = (h: string) => existsSync(filePath(h));
  const expiredAt = async (id: string) =>
    (await pool.query('SELECT expired_at FROM backup_runs WHERE id = $1', [id])).rows[0].expired_at as Date | null;
  // audit_events is append-only, so each test counts only the events written after it began.
  // Ids are uuidv7 from the fixed NOW, so their order is not the write order: exclude the
  // ids seen before the test instead of slicing by position.
  let auditBefore = new Set<string>();
  const allAudit = async () =>
    (
      await pool.query<{ id: string; detail: Record<string, unknown> }>(
        `SELECT id, detail FROM audit_events WHERE action = 'ops.backup_expired' ORDER BY occurred_at, id`,
      )
    ).rows;
  const audit = async () => (await allAudit()).filter((r) => !auditBefore.has(r.id));

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    await seedUser(pool, 'ex-admin@example.org', 'enterprise_administrator');
    tools = new PgTools(testDatabaseUrl() as string);
    toolsReady = await tools.version().then(
      (v) => v === 16,
      () => false,
    );
    root = mkdtempSync(join(tmpdir(), 'kainow-ex-'));
  });
  after(async () => {
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    folder = mkdtempSync(join(root, 'f-'));
    keyFile = join(root, `k-${Date.now()}-${Math.random()}`);
    writeFileSync(keyFile, randomBytes(32));
    key = loadBackupKey(keyFile) as BackupKey;
    await pool.query('DELETE FROM backup_runs');
    auditBefore = new Set((await allAudit()).map((r) => r.id));
  });

  test('an expired set goes; files only it listed go; shared files stay; the row gets expired_at', async () => {
    const [f1, f2, f3, f4] = ['a', 'b', 'c', 'd'].map(sha);
    for (const f of [f1, f2, f3, f4]) putFile(f);
    const a = await makeSet(40, [f1, f2]);
    const b = await makeSet(2, [f2, f3]);
    const c = await makeSet(1, [f3]);

    const r = await expireBackups(pool, config(), key, NOW);
    assert.deepEqual(r, { sets: 1, files: 2, filesSkipped: false });
    assert.equal(existsSync(a.dir), false);
    assert.equal(existsSync(b.dir) && existsSync(c.dir), true);
    assert.equal(present(f1), false); // only the expired set listed it
    assert.equal(present(f4), false); // nothing lists it
    assert.equal(present(f2), true); // shared with B
    assert.equal(present(f3), true);
    assert.deepEqual(readdirSync(setsDir()).sort(), [b.name, c.name].sort());
    assert.ok(await expiredAt(a.runId));
    assert.equal(await expiredAt(b.runId), null);
    const events = await audit();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].detail, { sets: 1, files: 2, filesSkipped: false });
  });

  test('when a remaining manifest cannot be decrypted, no file is removed and filesSkipped is true', async () => {
    const [f1, f2] = ['a', 'b'].map(sha);
    putFile(f1);
    putFile(f2);
    const a = await makeSet(40, [f1]);
    const b = await makeSet(2, [f2]);
    await makeSet(1, [f2]);
    const m = join(b.dir, 'manifest.json.enc');
    const bytes = readFileSync(m);
    bytes[bytes.length - 3] ^= 0xff;
    writeFileSync(m, bytes);

    const r = await expireBackups(pool, config(), key, NOW);
    assert.deepEqual(r, { sets: 1, files: 0, filesSkipped: true });
    assert.equal(existsSync(a.dir), false); // set removal does not depend on file reading
    assert.equal(present(f1), true);
    assert.equal(present(f2), true);
    assert.equal((await audit())[0].detail.filesSkipped, true);
  });

  test('a folder without a row or backup.json is incomplete: removed after a day, kept before', async () => {
    const mk = (hoursOld: number) => {
      const d = join(setsDir(), `${setStamp(new Date(NOW.getTime() - hoursOld * 3_600_000))}-daily-${uuidv7()}`);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const oldDir = mk(30);
    const newDir = mk(2);
    await makeSet(1, []);
    const r = await expireBackups(pool, config(), key, NOW);
    assert.equal(r.sets, 1);
    assert.equal(existsSync(oldDir), false);
    assert.equal(existsSync(newDir), true);
  });

  test('an -incomplete set older than a day is removed and its failed row gets expired_at', async () => {
    const runId = uuidv7();
    const started = new Date(NOW.getTime() - 3 * DAY);
    const name = `${setStamp(started)}-daily-${runId}-incomplete`;
    mkdirSync(join(setsDir(), name), { recursive: true });
    await pool.query(
      `INSERT INTO backup_runs (id, kind, started_at, finished_at, outcome, set_name) VALUES ($1, 'daily', $2, $2, 'failed', $3)`,
      [runId, started, name],
    );
    await makeSet(1, []);
    assert.equal((await expireBackups(pool, config(), key, NOW)).sets, 1);
    assert.equal(existsSync(join(setsDir(), name)), false);
    assert.ok(await expiredAt(runId));
  });

  test('nothing to expire records no audit event; a missing sets folder is fine', async () => {
    assert.deepEqual(await expireBackups(pool, config(), key, NOW), { sets: 0, files: 0, filesSkipped: false });
    assert.equal((await audit()).length, 0);
  });

  test('a row-less complete set (restored DB case) follows normal retention', async () => {
    const [f1, f2] = ['a', 'b'].map(sha);
    putFile(f1);
    putFile(f2);
    const fresh = await makeSet(1, [f2], 'daily', true, false);
    const tenDays = await makeSet(10, [f2], 'daily', true, false);
    const old = await makeSet(40, [f1], 'daily', true, false);
    const r = await expireBackups(pool, config(), key, NOW);
    assert.equal(r.sets, 1);
    assert.equal(existsSync(old.dir), false);
    assert.equal(existsSync(tenDays.dir) && existsSync(fresh.dir), true);
    assert.equal(present(f1), false);
    assert.equal(present(f2), true);
  });

  test('row-less newest complete set and newest pre_update are kept even at 400 days', async () => {
    const newest = await makeSet(400, [], 'daily', true, false);
    const older = await makeSet(401, [], 'daily', true, false);
    const pre = await makeSet(405, [], 'pre_update', true, false);
    const r = await expireBackups(pool, config(), key, NOW);
    assert.equal(r.sets, 1);
    assert.equal(existsSync(newest.dir) && existsSync(pre.dir), true);
    assert.equal(existsSync(older.dir), false);
  });

  test('if recording fails after removal, expiry still completes and reports it', async () => {
    const a = await makeSet(40, []);
    await makeSet(1, []);
    const bad = new Proxy(pool, {
      get(target, prop) {
        if (prop === 'query') {
          return (text: unknown, ...rest: unknown[]) =>
            typeof text === 'string' && /SET expired_at|INSERT INTO audit_events/.test(text)
              ? Promise.reject(new Error('forced'))
              : (target.query as (...x: unknown[]) => unknown)(text, ...rest);
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const r = await expireBackups(bad, config(), key, NOW);
    assert.deepEqual(r, { sets: 1, files: 0, filesSkipped: false, recordingFailed: true });
    assert.equal(existsSync(a.dir), false);
  });

  test('a failed backup run never calls expiry', async () => {
    const oldest = await makeSet(50, []);
    const older = await makeSet(40, []);
    const out: string[] = [];
    const d: BackupDeps = {
      pool,
      config: config(),
      tools: new FailingDump(testDatabaseUrl() as string),
      now: () => NOW,
      out: (l) => out.push(l),
      err: () => {},
    };
    assert.equal(await runBackup([], d), 1);
    assert.equal(existsSync(oldest.dir) && existsSync(older.dir), true);
    assert.equal((await audit()).length, 0);
  });

  test('a successful backup run expires old sets afterwards', async (t: TestContext) => {
    if (!toolsReady) return t.skip('pg client tools not found');
    const oldest = await makeSet(50, []);
    const older = await makeSet(40, []);
    const out: string[] = [];
    const d: BackupDeps = { pool, config: config(), tools, now: () => NOW, out: (l) => out.push(l), err: () => {} };
    assert.equal(await runBackup([], d), 0);
    // The new run is the newest succeeded set, so both old sets are past retention and go.
    assert.equal(existsSync(oldest.dir) || existsSync(older.dir), false);
    assert.ok(await expiredAt(oldest.runId));
    assert.equal((await audit()).length, 1);
  });
});
