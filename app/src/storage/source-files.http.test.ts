import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { NotesService } from '../notes/notes.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { standaloneCases } from '../testing/quarantine';
import { seedUser, seedWorkingProject } from '../testing/projects';
import type { StorageConnector } from './connector';
import { StorageWaitingForKey, type StorageConnectorFactory } from './connector-factory';
import { LocalConnector } from './connectors/local';
import type { StorageDeps } from './jobs';
import { makeStorageNotify } from './notices';
import { CHANGED_IN_STORAGE, STORE_UNREACHABLE, checkSourceFiles, flagStoredFile, openOriginal } from './source-files';
import { storeSourceVersion } from './sources';
import { type DestinationRef, StorageError, type StoredRef } from './types';

const BYTES = Buffer.from('Pump notes about the Zebrafish valve.\nSecond line.');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('source downloads from storage and the source check', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let local: LocalConnector;
  let mode: 'ok' | 'unreachable' | 'waiting' | 'bug';
  let pmId: string;
  let project: string;
  let pm: Client;
  const ids: Record<string, string> = {};
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => {
      if (mode === 'unreachable') throw new StorageError('server', { status: 503 });
      if (mode === 'waiting') throw new StorageWaitingForKey();
      if (mode === 'bug') throw new TypeError('bug');
      return { connector: local, dest: { id, connector: 'local', driveId: 'drive1', rootItemId: 'root' } };
    },
    forNew: async () => local,
  };
  const deps = (connectors: StorageConnectorFactory = factory): StorageDeps => ({
    pool: t.pool, connectors, key: null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now),
  });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const notes = () => t.app.get(NotesService);

  /** An uploaded note stored in the source area (its bytes are out of the database). */
  async function storedUpload(name = 'Site notes.txt', bytes = BYTES): Promise<{ sourceId: string; versionId: string; fileId: string; itemId: string }> {
    const { source, version } = await notes().createSource({ projectId: project, content: { file: { originalname: name, buffer: bytes } }, actorUserId: pmId });
    await storeSourceVersion(deps(), version.id);
    const f = (await rows(`SELECT f.id, f.item_id FROM stored_files f JOIN source_versions v ON f.id = v.original_stored_file_id WHERE v.id = $1`, [version.id]))[0];
    return { sourceId: source.id, versionId: version.id, fileId: f.id, itemId: f.item_id };
  }
  /** Overwrites the stored bytes of an item inside the local store (as someone editing the file in the library would). */
  function tamper(itemId: string, bytes: Buffer): void {
    const file = (function find(d: string): string | null {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) {
          const r = find(p);
          if (r) return r;
        } else if (e === itemId) return p;
      }
      return null;
    })(dir);
    assert.ok(file, 'the stored item is on disk');
    writeFileSync(file, bytes);
  }
  const flagStoredFileNow = (fileId: string) => flagStoredFile(deps(), fileId, 'changed', t.clock.now());
  const download = (sourceId: string, n = 1) => pm.raw('GET', `/notes/${sourceId}/versions/${n}/original`);
  const flags = async () => rows(`SELECT id, check_status, last_checked_at FROM stored_files ORDER BY id`);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-source-files-'));
    local = new LocalConnector(dir);
    mode = 'ok';
    t = await startTestApp(undefined, { storageConnectors: factory });
    pmId = await seedUser(t.pool, 'pm@example.org');
    project = await seedWorkingProject(t.pool, pmId);
    pm = await t.signIn('pm@example.org');
    for (const k of ['reader', 'outsider', 'storageadmin', 'plainadmin']) ids[k] = await seedUser(t.pool, `${k}@example.org`, k === 'plainadmin' ? 'enterprise_administrator' : 'member');
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'local', 'local', 'source_area', 'Sources', 'drive1', 'root', 'approved', $2, now())`,
      [uuidv7(), pmId],
    );
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('download after storage streams the stored file with the existing headers', async () => {
    const { sourceId, versionId } = await storedUpload();
    assert.equal((await rows(`SELECT original_bytes FROM source_versions WHERE id = $1`, [versionId]))[0].original_bytes, null);
    const res = await download(sourceId);
    assert.equal(res.status, 200);
    assert.equal(res.text, BYTES.toString('utf8'));
    assert.equal(res.headers.get('content-length'), String(BYTES.length));
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="Site notes\.txt"/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  test('download from the database still works while the bytes are there', async () => {
    const { source } = await notes().createSource({ projectId: project, content: { file: { originalname: 'Pending.txt', buffer: BYTES } }, actorUserId: pmId });
    assert.equal((await download(source.id)).text, BYTES.toString('utf8'));
  });

  test('download refuses a changed file with the exact text, marks it changed and never serves it again', async () => {
    const { sourceId, fileId, itemId } = await storedUpload();
    tamper(itemId, Buffer.from('Somebody edited this file.'));
    const first = await download(sourceId);
    assert.equal(first.status, 409);
    assert.equal(JSON.parse(first.text).message, CHANGED_IN_STORAGE);
    assert.equal(CHANGED_IN_STORAGE, 'This file has changed in storage since Kainow recorded it. It has been flagged for the storage Administrators.');
    assert.equal((await rows(`SELECT check_status FROM stored_files WHERE id = $1`, [fileId]))[0].check_status, 'changed');
    // Even if the stored file were put back, a flagged file is not served again.
    tamper(itemId, BYTES);
    const again = await download(sourceId);
    assert.equal(again.status, 409);
    assert.equal(JSON.parse(again.text).message, CHANGED_IN_STORAGE);
    // The notice went out once only.
    assert.equal((await rows(`SELECT 1 FROM notifications WHERE kind = 'source_file_changed' AND user_id = $1`, [ids.plainadmin])).length, 1);
  });

  test('download refuses when the provider is unreachable', async () => {
    const { sourceId, fileId } = await storedUpload();
    for (const m of ['unreachable', 'waiting'] as const) {
      mode = m;
      const res = await download(sourceId);
      assert.equal(res.status, 503, m);
      assert.equal(JSON.parse(res.text).message, STORE_UNREACHABLE);
    }
    assert.equal(STORE_UNREACHABLE, 'The file store cannot be reached right now');
    const f = (await rows(`SELECT check_status FROM stored_files WHERE id = $1`, [fileId]))[0];
    assert.notEqual(f.check_status, 'changed', 'an unreachable store flags nothing');
    mode = 'ok';
    assert.equal((await download(sourceId)).status, 200);
  });

  test('openOriginal returns the bytes only after the hash matches, and null where nothing is stored', async () => {
    const { versionId } = await storedUpload();
    const opened = await openOriginal(deps(), versionId);
    assert.ok(opened && 'bytes' in opened);
    assert.equal(sha(opened.bytes), sha(BYTES));
    const { version } = await notes().createSource({ projectId: project, content: { file: { originalname: 'Waiting.txt', buffer: BYTES } }, actorUserId: pmId });
    assert.equal(await openOriginal(deps(), version.id), null);
  });

  /** A stub store whose items answer from a table; for seeding thousands of rows without files. */
  function stubFactory(answer: (itemId: string) => Partial<StoredRef> | 'gone'): { factory: StorageConnectorFactory; asked: string[] } {
    const asked: string[] = [];
    const connector = {
      getItem: async (_d: DestinationRef, itemId: string) => {
        asked.push(itemId);
        const a = answer(itemId);
        if (a === 'gone') throw new StorageError('not_found', { status: 404 });
        return { itemId, parentId: 'p', name: 'n', path: '/n', size: 10, providerHash: 'H', etag: 'E', ctag: 'C', webUrl: null, ...a } as StoredRef;
      },
    } as unknown as StorageConnector;
    const f: StorageConnectorFactory = {
      forDestination: async (id) => ({ connector, dest: { id, connector: 'local', driveId: 'd', rootItemId: 'r' } }),
      forNew: async () => connector,
    };
    return { factory: f, asked };
  }
  async function seedFiles(n: number, opts: { lastChecked?: (i: number) => Date | null; dest?: string; prefix?: string } = {}): Promise<string[]> {
    const dest = opts.dest ?? (await rows(`SELECT id FROM storage_destinations WHERE purpose = 'source_area'`))[0].id;
    // Item i is `item-<i>`, recorded as size 10, hash H, etag E; ids are time-ordered so they sort in the order made.
    const fileIds = Array.from({ length: n }, (_, i) => uuidv7(1_700_000_000_000 + i + (opts.prefix ? 100_000 : 0)));
    await t.pool.query(
      `INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, name, size_bytes, sha256, provider_hash, etag, state, check_status, last_checked_at, created_at)
       SELECT x.id, 'source_original', $1, $2, 'local', 'd', x.item, 'original.txt', 10, 'x', 'H', 'E', 'stored', 'unverified', x.checked, now()
         FROM unnest($3::uuid[], $4::text[], $5::timestamptz[]) AS x(id, item, checked)`,
      [project, dest, fileIds, fileIds.map((_, i) => `${opts.prefix ?? 'item'}-${i}`), fileIds.map((_, i) => (opts.lastChecked ? opts.lastChecked(i) : null))],
    );
    return fileIds;
  }

  test('daily check flags changed and missing files, oldest check first, at most 2,000', async () => {
    await t.pool.query(`UPDATE storage_settings SET scheduled_checks = true`);
    const base = Date.UTC(2026, 10, 1);
    // File i was last checked i hours after the base; file 0 never was. 2,001 files: the newest check (the last) stays unchecked.
    const fileIds = await seedFiles(2001, { lastChecked: (i) => (i === 0 ? null : new Date(base + i * 3600_000)) });
    const { factory: stub, asked } = stubFactory((item) => {
      if (item === 'item-5') return { size: 11 };
      if (item === 'item-7') return { providerHash: 'OTHER' };
      if (item === 'item-9') return { etag: 'E2' };
      if (item === 'item-11') return 'gone';
      return {};
    });
    const now = new Date(base + 10_000 * 3600_000);
    const result = await checkSourceFiles(deps(stub), now);
    assert.deepEqual(result, { checked: 2000, flagged: 4 });
    assert.equal(asked.length, 2000);
    assert.equal(asked[0], 'item-0', 'never-checked files come first');
    assert.deepEqual(asked.slice(0, 4), ['item-0', 'item-1', 'item-2', 'item-3'], 'then the oldest check');
    const status = new Map((await flags()).map((r) => [r.id, r.check_status]));
    assert.equal(status.get(fileIds[5]), 'changed');
    assert.equal(status.get(fileIds[7]), 'changed');
    assert.equal(status.get(fileIds[9]), 'changed');
    assert.equal(status.get(fileIds[11]), 'missing');
    assert.equal(status.get(fileIds[6]), 'ok');
    const untouched = (await rows(`SELECT id FROM stored_files WHERE last_checked_at < $1 ORDER BY id`, [now]));
    assert.equal(untouched.length, 1, 'exactly one file was not reached');
    assert.equal(untouched[0].id, fileIds[2000], 'the one with the newest check stays for tomorrow');
    assert.equal((await rows(`SELECT 1 FROM stored_files WHERE last_checked_at = $1`, [now])).length, 2000);
  });

  test('daily check checks never-checked files even when scheduled checks are off', async () => {
    const base = Date.UTC(2026, 10, 1);
    await seedFiles(6, { lastChecked: (i) => (i < 3 ? null : new Date(base + i * 3600_000)) });
    const { factory: stub, asked } = stubFactory(() => ({}));
    assert.equal((await rows(`SELECT scheduled_checks FROM storage_settings`))[0].scheduled_checks, false);
    assert.deepEqual(await checkSourceFiles(deps(stub), new Date(base + 99 * 3600_000)), { checked: 3, flagged: 0 });
    assert.deepEqual(asked, ['item-0', 'item-1', 'item-2']);
    // A second run finds nothing left to check while the switch is off.
    assert.deepEqual(await checkSourceFiles(deps(stub), new Date(base + 100 * 3600_000)), { checked: 0, flagged: 0 });
    await t.pool.query(`UPDATE storage_settings SET scheduled_checks = true`);
    assert.deepEqual(await checkSourceFiles(deps(stub), new Date(base + 101 * 3600_000)), { checked: 6, flagged: 0 });
  });

  test('a file that errors on its own is skipped and stamped, and the later files are still checked', async () => {
    await t.pool.query(`UPDATE storage_settings SET scheduled_checks = true`);
    const ids = await seedFiles(4);
    const stub = stubFactory((item) => {
      if (item === 'item-0') throw new StorageError('server', { status: 500 });
      return {};
    });
    const now = new Date(Date.UTC(2026, 10, 2));
    assert.deepEqual(await checkSourceFiles(deps(stub.factory), now), { checked: 4, flagged: 0 });
    assert.deepEqual(stub.asked, ['item-0', 'item-1', 'item-2', 'item-3']);
    const st = await rows(`SELECT id, check_status, last_checked_at FROM stored_files ORDER BY id`);
    assert.equal(st[0].id, ids[0]);
    assert.equal(st[0].check_status, 'unverified', 'nothing is claimed about the file that errored');
    assert.equal(st[0].last_checked_at.getTime(), now.getTime(), 'but it moves behind the others');
  });

  test('a connection-level failure ends the run and leaves the files where they were', async () => {
    await t.pool.query(`UPDATE storage_settings SET scheduled_checks = true`);
    await seedFiles(4);
    for (const code of ['unauthorised', 'throttled', 'unreachable'] as const) {
      const stub = stubFactory((item) => {
        if (item === 'item-1') throw new StorageError(code);
        return {};
      });
      const r = await checkSourceFiles(deps(stub.factory), new Date(Date.UTC(2026, 10, 2)));
      assert.equal(r.checked, 1, code);
      assert.deepEqual(stub.asked, ['item-0', 'item-1'], code);
      await t.pool.query(`UPDATE stored_files SET last_checked_at = NULL`);
    }
  });

  test('a destination whose connector cannot be obtained does not stop or crowd out another destination', async () => {
    await t.pool.query(`UPDATE storage_settings SET scheduled_checks = true`);
    const dead = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'local', 'local', 'outputs', 'Dead', 'drive2', 'root', 'approved', $2, now())`,
      [dead, pmId],
    );
    await seedFiles(3, { dest: dead, prefix: 'dead' });
    await seedFiles(3);
    const ok = stubFactory(() => ({}));
    const f: StorageConnectorFactory = {
      forNew: ok.factory.forNew,
      forDestination: async (id) => {
        if (id === dead) throw new StorageError('invalid');
        return ok.factory.forDestination(id);
      },
    };
    // The dead destination's rows would use up a limit of 3 if they took slots.
    assert.deepEqual(await checkSourceFiles(deps(f), t.clock.now(), 3), { checked: 3, flagged: 0 });
    assert.deepEqual(ok.asked, ['item-0', 'item-1', 'item-2']);
  });

  test('a fault that is not the store is a 500, not "cannot be reached"', async () => {
    const { sourceId, versionId } = await storedUpload();
    const broken: StorageConnectorFactory = { forNew: factory.forNew, forDestination: async () => { throw new TypeError('bug'); } };
    await assert.rejects(openOriginal(deps(broken), versionId), TypeError);
    mode = 'bug';
    const res = await download(sourceId);
    mode = 'ok';
    assert.equal(res.status, 500);
  });

  test('a person who may not read the note gets 404 for a stored file', async () => {
    const { sourceId } = await storedUpload();
    const other = await t.signIn('outsider@example.org');
    assert.equal((await other.raw('GET', `/notes/${sourceId}/versions/1/original`)).status, 404);
    assert.equal((await download(sourceId)).status, 200);
  });

  test('the notice for a held source does not name its title', async () => {
    await t.pool.query(
      `INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`,
      [uuidv7(), project, ids.reader],
    );
    await t.pool.query(`INSERT INTO storage_admins (id, user_id, designated_by, designated_at, reason) VALUES ($1, $2, $3, now(), 'Looks after sources')`, [uuidv7(), ids.reader, ids.plainadmin]);
    const a = await storedUpload('Held notes.txt');
    // Held without the protected key, so its stored file is not withheld yet (with the key it is withheld at once, spec 8.5).
    await standaloneCases(t.pool, t.clock.now, false).report('kainow', { projectId: project, kind: 'source', id: a.sourceId, marked: ['Zebrafish'], reason: null });
    assert.ok((await rows(`SELECT held_case_id FROM sources WHERE id = $1`, [a.sourceId]))[0].held_case_id, 'the source is held');
    const title = (await rows(`SELECT title FROM sources WHERE id = $1`, [a.sourceId]))[0].title as string;
    assert.equal(await flagStoredFileNow(a.fileId), true);
    const got = await rows(`SELECT summary FROM notifications WHERE kind = 'source_file_changed'`);
    assert.equal(got.length, 2);
    for (const n of got) assert.ok(!n.summary.includes(title) && /^A file of a source in /.test(n.summary), n.summary);
  });

  test('each newly flagged file notifies Administrators and storage Administrators once, naming the source only to readers', async () => {
    await t.pool.query(`UPDATE storage_settings SET scheduled_checks = true`);
    // The source is Alpha-visible to its members; one storage Administrator is a project member (reads it), one is not.
    await t.pool.query(
      `INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`,
      [uuidv7(), project, ids.reader],
    );
    for (const u of [ids.reader, ids.outsider]) {
      await t.pool.query(`INSERT INTO storage_admins (id, user_id, designated_by, designated_at, reason) VALUES ($1, $2, $3, now(), 'Looks after sources')`, [uuidv7(), u, ids.plainadmin]);
    }
    // An ended designation gets nothing.
    await t.pool.query(`INSERT INTO storage_admins (id, user_id, designated_by, designated_at, reason, ended_at, ended_by, end_reason) VALUES ($1, $2, $3, now(), 'Was', now(), $3, 'Moved on')`, [uuidv7(), ids.storageadmin, ids.plainadmin]);
    const a = await storedUpload('Alpha notes.txt');
    const title = (await rows(`SELECT title FROM sources WHERE id = $1`, [a.sourceId]))[0].title as string;
    const projectName = (await rows(`SELECT name FROM projects WHERE id = $1`, [project]))[0].name as string;
    // The local store reports what it recorded, so the library's view of the edited file comes from a wrapper.
    const edited = new Set([a.itemId]);
    const wrapped: StorageConnectorFactory = {
      forNew: factory.forNew,
      forDestination: async (id) => {
        const r = await factory.forDestination(id);
        const connector = Object.create(r.connector, {
          getItem: { value: async (d: DestinationRef, item: string) => {
            const got = await r.connector.getItem(d, item);
            return edited.has(item) ? { ...got, size: got.size + 1 } : got;
          } },
        }) as StorageConnector;
        return { connector, dest: r.dest };
      },
    };

    const first = await checkSourceFiles(deps(wrapped), t.clock.now());
    assert.deepEqual(first, { checked: 2, flagged: 1 }, 'the original changed; the text file is untouched');
    const notices = async () => rows(`SELECT u.email, n.summary, n.link, n.project_id, n.email_off FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'source_file_changed' ORDER BY u.email`);
    const got = await notices();
    assert.deepEqual(got.map((n) => n.email), ['outsider@example.org', 'plainadmin@example.org', 'reader@example.org']);
    const by = Object.fromEntries(got.map((n) => [n.email.split('@')[0], n]));
    assert.match(by.reader.summary, new RegExp(`"${title}" in ${projectName}`), 'a reader is told which source');
    assert.equal(by.reader.link, `#/notes/${a.sourceId}`);
    for (const k of ['outsider', 'plainadmin']) {
      assert.ok(!by[k].summary.includes(title), `${k} is not told the title`);
      assert.match(by[k].summary, new RegExp(`^A file of a source in ${projectName} has changed in storage`));
      assert.equal(by[k].link, `#/projects/${project}`);
    }
    assert.equal(by.reader.project_id, project);

    // A repeat check, and a download of the flagged file, notify nobody again.
    assert.deepEqual(await checkSourceFiles(deps(wrapped), t.clock.now()), { checked: 1, flagged: 0 });
    assert.equal((await download(a.sourceId)).status, 409);
    assert.equal((await notices()).length, 3);

    // A file found missing is a notice of its own, once.
    const b = await storedUpload('Beta notes.txt', Buffer.from('Beta text.'));
    await local.removePermanently({ id: 'x', connector: 'local', driveId: 'drive1', rootItemId: 'root' }, b.itemId);
    assert.deepEqual(await checkSourceFiles(deps(wrapped), t.clock.now()), { checked: 3, flagged: 1 });
    assert.equal((await rows(`SELECT 1 FROM notifications WHERE kind = 'source_file_missing'`)).length, 3);
    assert.equal((await rows(`SELECT check_status FROM stored_files WHERE id = $1`, [b.fileId]))[0].check_status, 'missing');
    const gone = await download(b.sourceId);
    assert.equal(gone.status, 409, 'a missing file is not served either');
  });

  test('working text, quotes and search are unaffected by a flagged file', async () => {
    const { sourceId, versionId, itemId } = await storedUpload();
    const before = (await rows(`SELECT text_content, text_sha256, original_sha256 FROM source_versions WHERE id = $1`, [versionId]))[0];
    tamper(itemId, Buffer.from('edited'));
    assert.equal((await download(sourceId)).status, 409);
    const after = (await rows(`SELECT text_content, text_sha256, original_sha256 FROM source_versions WHERE id = $1`, [versionId]))[0];
    assert.deepEqual(after, before, 'the recorded version is untouched');
    const v = await pm.request('GET', `/notes/${sourceId}/versions/1`);
    assert.equal(v.status, 200);
    assert.match(v.body.version.text, /Zebrafish valve/);
    const found = (await pm.request('GET', '/search?q=Zebrafish')).body.projects.flatMap((p: { results: unknown[] }) => p.results);
    assert.ok(found.length > 0, 'search still finds the text');
    assert.equal((await pm.request('GET', `/notes/${sourceId}`)).status, 200);
    // Quotes and approvals point at the recorded version's text, which a flagged file does not change.
    assert.equal(after.original_sha256, sha(BYTES));
  });
});
