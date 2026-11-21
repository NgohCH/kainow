import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { M365TokenSource } from '../email/m365-token';
import type { StorageConnectorFactory } from '../storage/connector-factory';
import { GraphConnector } from '../storage/connectors/graph';
import { makeStorageNotify } from '../storage/notices';
import { quickXorHash } from '../storage/quickxor';
import { STORAGE_CONNECTION_ID, sealStorageSecret } from '../storage/secret';
import type { DestinationRef } from '../storage/types';
import { testProtectedKey } from '../testing/ai-runners';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { seedProject, seedUser } from '../testing/projects';
import { RESTORED_CODE, afterRestore } from './after-restore';
import { runBackup } from './backup';
import type { OpsConfig } from './config';
import { type BackupKey, loadBackupKey } from './crypto';
import { type Check, type DrillDeps, drillAgainReason, runRestoreDrill } from './drill';
import { type Manifest, readSet } from './manifest';
import { PgTools } from './pg-tools';
import {
  RESTORE_SOURCE_TEXT,
  SOURCE_TEXT,
  StoredSourceFiles,
  listSourceFiles,
  runRestoreSourceFiles,
  sourceAreaReading,
  storePath,
} from './source-files';
import { runStorageCheck } from './storage-check';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';
const TB = 1024 ** 4;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('the protected source area: backup, drill, reading, restore', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let tools: PgTools;
  let toolsReady = false;
  let fake: FakeGraph;
  let connector: GraphConnector;
  let drive: { driveId: string; rootItemId: string };
  let root: string;
  let folder: string;
  let keyFile: string;
  let admin: string;
  let project: string;
  let areaId: string | null;
  let clock = Date.parse('2026-11-21T02:00:00Z');
  const made: string[] = [];

  const factory: StorageConnectorFactory = {
    forDestination: async (id) => ({ connector, dest: { id, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId } }),
    forNew: async () => connector,
  };
  const dest = (): DestinationRef => ({ id: areaId as string, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId });
  const copier = (protectedKeyPresent = true) => new StoredSourceFiles(factory, protectedKeyPresent);

  const needTools = (t: TestContext): boolean => {
    if (toolsReady) return true;
    if (process.env.CI) assert.fail('pg client tools not found (required in CI)');
    t.skip('pg client tools not found');
    return false;
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
  const key = (): BackupKey => loadBackupKey(keyFile) as BackupKey;
  const filesDir = () => join(folder, 'kainow', 'files');
  const storeFiles = (): string[] => {
    if (!existsSync(filesDir())) return [];
    return readdirSync(filesDir()).flatMap((d) => readdirSync(join(filesDir(), d)).map((f) => `${d}/${f}`)).sort();
  };
  const downloads = () => fake.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/content')).length;
  const row = async (id: string) => (await pool.query('SELECT * FROM backup_runs WHERE id = $1', [id])).rows[0];

  async function backup(opts: { protectedKey?: boolean; copyBudgetMs?: number; list?: StoredSourceFiles['list'] } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const at = new Date((clock += 60_000));
    const c = copier(opts.protectedKey ?? true);
    if (opts.list) c.list = opts.list;
    const code = await runBackup([], {
      pool, config: config(), tools, now: () => at, out: (l) => out.push(l), err: (l) => err.push(l), sourceFiles: c, copyBudgetMs: opts.copyBudgetMs,
    });
    const runId = /^run (\S+) /.exec(out[out.length - 1] ?? '')?.[1] as string;
    const r = runId ? await row(runId) : undefined;
    return { code, out, err, runId, row: r };
  }
  async function manifestOf(runId: string): Promise<Manifest> {
    const name = readdirSync(join(folder, 'kainow', 'sets')).find((n) => n.includes(runId)) as string;
    return (await readSet(join(folder, 'kainow', 'sets', name), key())).manifest;
  }
  async function drill(over: Partial<DrillDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const at = new Date((clock += 60_000));
    const code = await runRestoreDrill([], {
      pool, config: config(), tools, statfs: () => ({ total: 10 * TB, free: 5 * TB }), now: () => at,
      out: (l) => out.push(l), err: (l) => err.push(l), protectedKey: testProtectedKey(), ...over,
    });
    const runId = /^run (\S+) /.exec(out[out.length - 1] ?? '')?.[1];
    const r = runId ? (await pool.query('SELECT * FROM restore_drills WHERE id = $1', [runId])).rows[0] : undefined;
    if (r?.kept_database) made.push(r.kept_database);
    return { code, out, err, row: r };
  }
  const check = (r: { checks: Check[] }, name: string) => r.checks.find((c) => c.name === name);

  async function approveArea(): Promise<string> {
    areaId = (
      await pool.query(
        `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
         VALUES (gen_random_uuid(), 'graph', 'sharepoint_library', 'source_area', 'Sources', $1, $2, 'approved', $3, now()) RETURNING id`,
        [drive.driveId, drive.rootItemId, admin],
      )
    ).rows[0].id as string;
    return areaId;
  }

  /** A stored source text file: a source and its version in Kainow, the file uploaded to the fake drive. */
  async function storedFile(text: string, opts: { checkStatus?: string; state?: string } = {}): Promise<{ id: string; itemId: string; bytes: Buffer }> {
    const bytes = Buffer.from(text, 'utf8');
    const name = `text-${randomBytes(4).toString('hex')}.txt`;
    const ref = await connector.upload(dest(), drive.rootItemId, name, bytes, { conflict: 'fail' });
    assert.equal(ref.providerHash, quickXorHash(bytes));
    const id = (
      await pool.query(
        `INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, path, name, size_bytes, sha256, provider_hash,
                                   etag, ctag, state, check_status, created_at, stored_at)
         VALUES (gen_random_uuid(), 'source_text', $1, $2, 'graph', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, clock_timestamp(), now()) RETURNING id`,
        [project, areaId, drive.driveId, ref.itemId, ref.path, ref.name, bytes.length, sha(bytes), ref.providerHash, ref.etag, ref.ctag,
          opts.state ?? 'stored', opts.checkStatus ?? 'ok'],
      )
    ).rows[0].id as string;
    const source = (
      await pool.query(
        `INSERT INTO sources (id, title, created_by, created_at, project_id, kind) VALUES (gen_random_uuid(), 'Site notes', $1, now(), $2, 'notes') RETURNING id`,
        [admin, project],
      )
    ).rows[0].id as string;
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at, text_stored_file_id)
       VALUES (gen_random_uuid(), $1, 1, 'paste', $2, $3, $4, $5, now(), $6)`,
      [source, text, sha(bytes), text.length, admin, id],
    );
    return { id, itemId: ref.itemId, bytes };
  }

  before(async () => {
    tools = new PgTools(testDatabaseUrl() as string);
    toolsReady = await tools.version().then(
      (v) => v === 16,
      () => false,
    );
    root = mkdtempSync(join(tmpdir(), 'kainow-sf-'));
  });
  after(async () => {
    for (const name of made) await pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    const left = (await pool.query(`SELECT datname FROM pg_database WHERE datname LIKE 'kainow\\_drill\\_%'`)).rows;
    for (const r of left) await pool.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`).catch(() => undefined);
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });
  afterEach(async () => {
    await fake?.close();
  });
  beforeEach(async () => {
    if (pool) await pool.end();
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    admin = await seedUser(pool, 'sf-admin@example.org', 'enterprise_administrator');
    project = await seedProject(pool, { members: [{ userId: admin, role: 'pm' }] });
    fake = await startFakeGraph();
    connector = new GraphConnector(new M365TokenSource({ tenantId: 'test-tenant', clientId: APP_ID, clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE), {
      fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: false, allowedDomains: async () => ['example.org'], appClientId: APP_ID,
    });
    drive = fake.addDrive();
    areaId = null;
    folder = mkdtempSync(join(root, 'f-'));
    keyFile = join(root, `k-${randomBytes(4).toString('hex')}`);
    writeFileSync(keyFile, randomBytes(32));
  });

  test('first backup copies every stored source file once; the second copies none and lists all', async (t) => {
    if (!needTools(t)) return;
    await approveArea();
    const a = await storedFile('Pump notes, first file.');
    const b = await storedFile('Valve notes, second file.');
    const c = await storedFile('Pump notes, first file.'); // the same content as a: one store file
    const first = await backup();
    assert.equal(first.code, 0, [...first.out, ...first.err].join('\n'));
    assert.equal(first.row.source_area, 'included');
    assert.deepEqual([first.row.files_total, first.row.files_new, first.row.files_not_copied], [3, 2, 0]);
    assert.ok(Number(first.row.files_new_bytes) > 0);
    assert.equal(downloads(), 2);
    assert.deepEqual(storeFiles(), [a.bytes, b.bytes].map((x) => `${sha(x).slice(0, 2)}/${sha(x)}.enc`).sort());
    const m1 = await manifestOf(first.runId);
    assert.equal(m1.sourceArea, 'included');
    assert.deepEqual(
      m1.sourceFiles.map((f) => [f.storedFileId, f.sha256, f.size, f.copied]),
      [a, b, c].map((f) => [f.id, sha(f.bytes), f.bytes.length, true]),
    );
    // Encrypted with the backup key: the content is never in the store in plain.
    assert.ok(!readFileSync(storePath(filesDir(), sha(a.bytes))).includes(a.bytes));

    const second = await backup();
    assert.equal(second.code, 0, second.err.join('\n'));
    assert.deepEqual([second.row.files_total, second.row.files_new, second.row.files_not_copied, Number(second.row.files_new_bytes)], [3, 0, 0, 0]);
    assert.equal(downloads(), 2, 'nothing downloaded again');
    assert.deepEqual((await manifestOf(second.runId)).sourceFiles.map((f) => f.copied), [true, true, true]);
    // Output names counts only.
    const text = [...first.out, ...first.err, ...second.out].join('\n');
    assert.ok(!text.includes(folder) && !text.includes('Pump notes') && !text.includes(drive.driveId), text);
  });

  test('R26: the source files are read in the export snapshot, so a file stored after it is not in this manifest', async (t) => {
    if (!needTools(t)) return;
    await approveArea();
    const a = await storedFile('Before the snapshot.');
    let late: string | undefined;
    const real = copier();
    const r = await backup({
      list: async (db) => {
        late = (await storedFile('After the snapshot.')).id; // committed on another connection, after the export
        return real.list(db);
      },
    });
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual((await manifestOf(r.runId)).sourceFiles.map((f) => f.storedFileId), [a.id]);
    assert.ok(late);
  });

  test('a file that fails to download fails the run source_files_failed with the count', async (t) => {
    if (!needTools(t)) return;
    await approveArea();
    await storedFile('Kept in storage.');
    const gone = await storedFile('Deleted from the library.');
    fake.deleteItem(drive.driveId, gone.itemId);
    const r = await backup();
    assert.equal(r.code, 1);
    assert.match(r.out[r.out.length - 1], /^run \S+ failed source_files_failed$/);
    assert.equal(r.row.outcome, 'failed');
    assert.equal(r.row.failure_code, 'source_files_failed');
    assert.equal(r.row.failure_detail, 'Some source files could not be copied. Not copied: 1.');
    assert.equal(r.row.files_not_copied, 1);
    assert.ok(r.err.includes(SOURCE_TEXT.failed(1)));
    assert.match(r.row.set_name, /-incomplete$/);
  });

  test('a file already flagged Missing or Changed does not fail the run; the note counts it', async (t) => {
    if (!needTools(t)) return;
    await approveArea();
    const ok = await storedFile('Still there.');
    const missing = await storedFile('Flagged missing.', { checkStatus: 'missing' });
    fake.deleteItem(drive.driveId, missing.itemId);
    const changed = await storedFile('Flagged changed.', { checkStatus: 'changed' });
    const r = await backup();
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.ok(r.out.includes('2 source files already flagged in storage were not copied.'), r.out.join('\n'));
    assert.deepEqual([r.row.files_total, r.row.files_new, r.row.files_not_copied], [3, 1, 2]);
    assert.deepEqual(
      (await manifestOf(r.runId)).sourceFiles.map((f) => [f.storedFileId, f.copied, f.reason]),
      [[ok.id, true, undefined], [missing.id, false, 'flagged'], [changed.id, false, 'flagged']],
    );
  });

  test('R27: files not reached within the copy time are listed not copied; the run succeeds and the next run copies them', async (t) => {
    if (!needTools(t)) return;
    await approveArea();
    await storedFile('One.');
    await storedFile('Two.');
    const late = await backup({ copyBudgetMs: 0 });
    assert.equal(late.code, 0, late.err.join('\n'));
    assert.ok(late.out.includes(SOURCE_TEXT.notReached(2)), late.out.join('\n'));
    assert.deepEqual([late.row.files_total, late.row.files_new, late.row.files_not_copied], [2, 0, 2]);
    assert.deepEqual((await manifestOf(late.runId)).sourceFiles.map((f) => f.reason), ['not_reached', 'not_reached']);
    const next = await backup();
    assert.deepEqual([next.row.files_new, next.row.files_not_copied], [2, 0]);
  });

  test('no protected key with the source area in use is protected_key_missing; without a source area it is not needed', async (t) => {
    if (!needTools(t)) return;
    const none = await backup({ protectedKey: false });
    assert.equal(none.code, 0, none.err.join('\n'));
    assert.equal(none.row.source_area, 'not_in_use');
    assert.deepEqual((await manifestOf(none.runId)).sourceFiles, []);

    await approveArea();
    const r = await backup({ protectedKey: false });
    assert.equal(r.code, 1);
    assert.equal(r.row.failure_code, 'protected_key_missing');
    assert.ok(r.err.includes('Source files are in use, but no protected key is available.'));
  });

  test('a new backup key copies the store files again under it, so a new set never lists an old-key file', async () => {
    await approveArea();
    const a = await storedFile('Copied under the first key.');
    const listing = await listSourceFiles(pool);
    const opts = { runId: 'r1', now: () => new Date(clock), deadline: new Date(clock + 3_600_000) };
    const k1 = key();
    assert.equal((await copier().copyAll(listing, k1, filesDir(), opts)).newFiles, 1);
    const firstBytes = readFileSync(storePath(filesDir(), sha(a.bytes)));
    writeFileSync(keyFile, randomBytes(32));
    const k2 = key();
    const again = await copier().copyAll(listing, k2, filesDir(), { ...opts, runId: 'r2' });
    assert.equal(again.newFiles, 1);
    const header = readFileSync(storePath(filesDir(), sha(a.bytes))).subarray(5, 21).toString('latin1');
    assert.equal(header, k2.id);
    assert.notDeepEqual(readFileSync(storePath(filesDir(), sha(a.bytes))), firstBytes);
    assert.equal((await copier().copyAll(listing, k2, filesDir(), { ...opts, runId: 'r3' })).newFiles, 0);
  });

  test('drill: every listed file is decrypted and checked; a damaged store file fails source_files; the storage secret opens with the key', async (t) => {
    if (!needTools(t)) return;
    await approveArea();
    const a = await storedFile('Checked by the drill.');
    await storedFile('Also checked.');
    const sealed = sealStorageSecret(testProtectedKey(), 'storage-client-secret-value', STORAGE_CONNECTION_ID);
    await pool.query(
      `INSERT INTO storage_connection_secrets (id, ciphertext, nonce, tag, key_id, saved_by, saved_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
      [sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId, admin],
    );
    assert.equal((await backup()).code, 0);

    const good = await drill();
    assert.equal(good.code, 0, [...good.out, ...good.err].join('\n'));
    assert.deepEqual(check(good.row, 'source_files'), { name: 'source_files', result: 'passed', detail: '2 files checked.' });
    assert.equal(check(good.row, 'sealed_storage_secret')?.result, 'passed');

    const noKey = await drill({ protectedKey: null });
    assert.equal(check(noKey.row, 'sealed_storage_secret')?.result, 'failed');

    const file = storePath(filesDir(), sha(a.bytes));
    const bytes = readFileSync(file);
    bytes[bytes.length - 20] ^= 0x01;
    writeFileSync(file, bytes);
    const bad = await drill();
    assert.equal(bad.code, 1);
    assert.equal(bad.row.outcome, 'failed');
    assert.deepEqual(check(bad.row, 'source_files'), { name: 'source_files', result: 'failed', detail: '2 files checked. 1 did not match.' });
  });

  test('drill again: a drill passed before the source area came into use asks for a new one (source_area_new)', async (t) => {
    if (!needTools(t)) return;
    assert.equal((await backup()).row.source_area, 'not_in_use');
    assert.equal((await drill()).row.outcome, 'passed');
    assert.equal(await drillAgainReason(pool), null);
    await approveArea();
    await storedFile('Now in the source area.');
    assert.equal((await backup()).row.source_area, 'included');
    assert.equal(await drillAgainReason(pool), 'source_area_new');
    const again = await drill();
    assert.equal(check(again.row, 'source_files')?.result, 'passed');
    assert.equal(await drillAgainReason(pool), null);
  });

  test('storage check: a source_area reading with the quota, or unavailable; none while the source area is not in use', async () => {
    const run = async () => {
      const at = new Date((clock += 60_000));
      const code = await runStorageCheck([], {
        pool, config: config(), now: () => at, statfs: () => ({ total: 10 * TB, free: 5 * TB }), sourceArea: () => sourceAreaReading(pool), err: () => undefined,
      });
      assert.equal(code, 0);
      return (await pool.query(`SELECT * FROM storage_readings WHERE location = 'source_area' AND at = $1`, [at])).rows[0];
    };
    assert.equal(await run(), undefined);

    await approveArea();
    const f = await storedFile('Counted in the reading.');
    const unavailable = await run();
    assert.equal(unavailable.unavailable, true);
    assert.equal(unavailable.total_bytes, null);
    assert.equal(Number(unavailable.used_bytes), f.bytes.length);
    assert.deepEqual(unavailable.extra, { storedBytes: f.bytes.length, files: 1 });

    await pool.query(`UPDATE storage_destinations SET last_check = $2 WHERE id = $1`, [areaId, JSON.stringify({ quotaBytes: 1000 * 1024 ** 3, usedBytes: 100 * 1024 ** 3 })]);
    const known = await run();
    assert.equal(known.unavailable, false);
    assert.deepEqual([Number(known.total_bytes), Number(known.used_bytes), Number(known.free_bytes)], [1000 * 1024 ** 3, 100 * 1024 ** 3, 900 * 1024 ** 3]);
  });

  test('after restore: queued storage_outbox rows are ended with the not-run reason; sent rows are left', async () => {
    const queued = (await pool.query(`INSERT INTO storage_outbox (id, job, subject_id, created_at) VALUES (gen_random_uuid(), 'check', gen_random_uuid(), now()) RETURNING id`)).rows[0].id;
    const sent = (await pool.query(`INSERT INTO storage_outbox (id, job, subject_id, created_at, sent_at) VALUES (gen_random_uuid(), 'check', gen_random_uuid(), now(), now()) RETURNING id`)).rows[0].id;
    const now = new Date(clock);
    const c: PoolClient = await pool.connect();
    let result;
    try {
      await c.query('BEGIN');
      result = await afterRestore(c, { setTime: new Date(clock - 3_600_000), setName: 'x', reason: 'Server lost', now });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    assert.equal(result.work.storage_outbox, 1);
    const rows = (await pool.query(`SELECT id, ended_at, end_reason FROM storage_outbox ORDER BY created_at, id`)).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(queued).end_reason, RESTORED_CODE);
    assert.equal(new Date(byId.get(queued).ended_at).getTime(), now.getTime());
    assert.equal(byId.get(sent).ended_at, null);
    assert.equal(byId.get(sent).end_reason, null);
  });

  test('restore-source-files re-uploads a file deleted from the drive and updates its reference; a file not in the store is listed', async () => {
    await approveArea();
    const kept = await storedFile('Never lost.');
    const lost = await storedFile('Lost with the library, kept in the backup.');
    // Fill the store as a backup would.
    const listing = await listSourceFiles(pool);
    await copier().copyAll(listing, key(), filesDir(), { runId: 'r1', now: () => new Date(clock), deadline: new Date(clock + 3_600_000) });
    const absent = await storedFile('Stored after the last backup.');
    fake.deleteItem(drive.driveId, lost.itemId);
    fake.deleteItem(drive.driveId, absent.itemId);

    const out: string[] = [];
    const err: string[] = [];
    const at = new Date((clock += 60_000));
    const code = await runRestoreSourceFiles([], {
      pool, config: config(), now: () => at, out: (l) => out.push(l), err: (l) => err.push(l),
      storage: { pool, connectors: factory, key: null, clock: () => at, notify: makeStorageNotify(pool, () => at) },
    });
    assert.equal(code, 1, 'one file could not be put back');
    assert.deepEqual(err, []);
    assert.deepEqual(out, [RESTORE_SOURCE_TEXT.notInStore(absent.id), RESTORE_SOURCE_TEXT.summary(3, 2, 1)]);

    const f = (await pool.query(`SELECT item_id, state, check_status, sha256, path FROM stored_files WHERE id = $1`, [lost.id])).rows[0];
    assert.notEqual(f.item_id, lost.itemId);
    assert.deepEqual([f.state, f.check_status], ['stored', 'ok']);
    assert.deepEqual(await connector.download(dest(), f.item_id), lost.bytes);
    assert.match(f.path, /\/sources\/[0-9a-f-]+\/v1\//);
    const move = (await pool.query(`SELECT reason, old_item_id, new_item_id FROM stored_file_moves WHERE stored_file_id = $1`, [lost.id])).rows;
    assert.deepEqual(move, [{ reason: 'Restored from backup', old_item_id: lost.itemId, new_item_id: f.item_id }]);
    assert.equal((await pool.query(`SELECT item_id FROM stored_files WHERE id = $1`, [kept.id])).rows[0].item_id, kept.itemId);
    const audit = (await pool.query(`SELECT detail FROM audit_events WHERE action = 'ops.source_files_restored'`)).rows;
    assert.deepEqual(audit.map((r) => r.detail), [{ checked: 3, missing: 2, restored: 1, notInStore: 1, notPut: 0, unchecked: 0 }]);

    // Run again: nothing more is missing except the file the store never had.
    const again: string[] = [];
    assert.equal(
      await runRestoreSourceFiles([], {
        pool, config: config(), now: () => at, out: (l) => again.push(l), err: () => undefined,
        storage: { pool, connectors: factory, key: null, clock: () => at, notify: makeStorageNotify(pool, () => at) },
      }),
      1,
    );
    assert.deepEqual(again, [RESTORE_SOURCE_TEXT.notInStore(absent.id), RESTORE_SOURCE_TEXT.summary(3, 1, 0)]);
    assert.equal(await runRestoreSourceFiles(['--x'], { pool, config: config(), now: () => at, out: () => undefined, err: () => undefined, storage: {} as never }), 2);
  });
});
