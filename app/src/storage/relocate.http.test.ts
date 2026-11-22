import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { csvCell } from '../analytics/csv';
import { uuidv7 } from '../common/uuid7';
import { NotesService } from '../notes/notes.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser, seedWorkingProject } from '../testing/projects';
import type { StorageConnectorFactory } from './connector-factory';
import { LocalConnector } from './connectors/local';
import { type StorageDeps, onFinalFailure, storageHandler } from './jobs';
import { MANIFEST_COLUMNS, RESTRICTED_ITEM } from './manifest';
import { makeStorageNotify } from './notices';
import { relocateStoredFile, sourceAreaMoveProgress } from './relocate';
import { checkSourceFiles } from './source-files';
import { storeSourceVersion } from './sources';
import { type DestinationRef, StorageError, type StoredRef } from './types';
import { syncFolderGrants } from '../outputs/sharing';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The local store with faults to order. */
class FaultyConnector extends LocalConnector {
  copyFault: null | 'fail' | 'lost' | 'wrong_hash' | 'no_hash' = null;
  /** Items whose copy fails every time. */
  copyFailFor = new Set<string>();
  removeFault = false;
  /** Downloads from this drive answer with other bytes. */
  tamperDrive: string | null = null;
  moveFault: null | 'lost' | 'wrong_hash' = null;
  /** Runs once, after the provider has made the copy and before Kainow sees its answer. */
  duringCopy: (() => Promise<void>) | null = null;

  override async copyTo(src: DestinationRef, itemId: string, dst: DestinationRef, folderId: string, name: string): Promise<StoredRef> {
    if (this.copyFault === 'fail' || this.copyFailFor.has(itemId)) throw new StorageError('server', { status: 503 });
    const ref = await super.copyTo(src, itemId, dst, folderId, name);
    const hook = this.duringCopy;
    this.duringCopy = null;
    if (hook) await hook();
    if (this.copyFault === 'lost') {
      this.copyFault = null;
      throw new StorageError('timeout');
    }
    if (this.copyFault === 'wrong_hash') return { ...ref, providerHash: 'WRONG' };
    if (this.copyFault === 'no_hash') return { ...ref, providerHash: null };
    return ref;
  }
  override async move(dest: DestinationRef, itemId: string, newParentId: string, newName?: string): Promise<StoredRef> {
    const fault = this.moveFault;
    this.moveFault = null;
    const ref = await super.move(dest, itemId, newParentId, newName);
    if (fault === 'lost') throw new StorageError('timeout');
    if (fault === 'wrong_hash') return { ...ref, providerHash: 'WRONG' };
    return ref;
  }
  override async removePermanently(dest: DestinationRef, itemId: string): Promise<void> {
    if (this.removeFault) throw new StorageError('server', { status: 503 });
    return super.removePermanently(dest, itemId);
  }
  override async download(dest: DestinationRef, itemId: string): Promise<Buffer> {
    const b = await super.download(dest, itemId);
    return this.tamperDrive === dest.driveId ? Buffer.from('tampered content') : b;
  }
}

describe('relocation, moving the source area and the manifest', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let local: FaultyConnector;
  let project: string;
  let areaA: string;
  let areaB: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  const destRef = async (id: string): Promise<DestinationRef> => {
    const r = (await t.pool.query(`SELECT id, connector, drive_id, root_item_id FROM storage_destinations WHERE id = $1`, [id])).rows[0];
    return { id: r.id, connector: r.connector, driveId: r.drive_id, rootItemId: r.root_item_id };
  };
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => ({ connector: local, dest: await destRef(id) }),
    forNew: async () => local,
  };
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now), log: () => undefined });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const notes = () => t.app.get(NotesService);
  const download = (sourceId: string) => c.pm.raw('GET', `/notes/${sourceId}/versions/1/original`);

  async function addArea(label: string, drive: string, status: 'approved' | 'proposed'): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'local', 'local', 'source_area', $2, $3, $4, $5, $6, now())`,
      [id, label, drive, `root-${drive}`, status, ids.admin],
    );
    return id;
  }

  /** An uploaded note stored in the approved source area. */
  async function storedUpload(name: string, text: string): Promise<{ sourceId: string; versionId: string; original: string; textFile: string; bytes: Buffer }> {
    const bytes = Buffer.from(text);
    const { source, version } = await notes().createSource({ projectId: project, content: { file: { originalname: name, buffer: bytes } }, actorUserId: ids.pm, reauthorise: async () => undefined });
    await storeSourceVersion(deps(), version.id);
    const v = (await rows(`SELECT original_stored_file_id AS o, text_stored_file_id AS t FROM source_versions WHERE id = $1`, [version.id]))[0];
    return { sourceId: source.id, versionId: version.id, original: v.o, textFile: v.t, bytes };
  }
  const file = async (id: string) => (await rows(`SELECT * FROM stored_files WHERE id = $1`, [id]))[0];
  const exists = async (destId: string, itemId: string) =>
    local.getItem(await destRef(destId), itemId).then(() => true, (e) => (e instanceof StorageError && e.code === 'not_found' ? false : Promise.reject(e)));

  /** Runs queued storage work of the given kinds as the worker would; returns the failures (job, subject, code). */
  async function drain(kinds: string[], limit = 200): Promise<Array<{ job: string; subject: string; code: string }>> {
    const failures: Array<{ job: string; subject: string; code: string }> = [];
    for (let i = 0; i < limit; i++) {
      const next = (
        await rows(
          `UPDATE storage_outbox SET sent_at = now()
            WHERE id = (SELECT id FROM storage_outbox WHERE sent_at IS NULL AND job = ANY($1::text[]) ORDER BY urgent DESC, created_at, id LIMIT 1)
            RETURNING job, subject_id`,
          [kinds],
        )
      )[0];
      if (!next) return failures;
      try {
        await storageHandler(next.job)!(deps(), next.subject_id, 1);
      } catch (e) {
        failures.push({ job: next.job, subject: next.subject_id, code: e instanceof StorageError ? e.code : 'internal' });
      }
    }
    throw new Error('the outbox did not drain');
  }
  const counts = async () => {
    const p = await sourceAreaMoveProgress(t.pool);
    return p && { toMove: p.toMove, moved: p.moved, failed: p.failed };
  };
  const startMove = async (body: Record<string, unknown> = {}) => {
    const view = (await c.admin.request('GET', '/admin/storage/source-area/move')).body as { current: { files: number; bytes: number } };
    return c.admin.request('POST', '/admin/storage/source-area/move', {
      destinationId: areaB, reason: 'New library for the source files', confirm: { files: view.current.files, bytes: view.current.bytes }, ...body,
    });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-relocate-'));
    local = new FaultyConnector(dir, {
      lookup: { 'admin@example.org': 'account', 'bob@example.org': 'account', 'pm@example.org': 'account' },
    });
    t = await startTestApp(undefined, { storageConnectors: factory });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    ids.admin2 = await seedUser(t.pool, 'admin2@example.org', 'enterprise_administrator');
    ids.pm = await seedUser(t.pool, 'pm@example.org');
    ids.bob = await seedUser(t.pool, 'bob@example.org');
    project = await seedWorkingProject(t.pool, ids.pm);
    areaA = await addArea('Old sources', 'driveA', 'approved');
    areaB = await addArea('New sources', 'driveB', 'proposed');
    for (const k of ['admin', 'admin2', 'pm', 'bob']) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('relocation verifies before switching and keeps the old reference on failure at each step', async () => {
    const up = await storedUpload('Site notes.txt', 'Pump notes about the Zebrafish valve.');
    const before = await file(up.original);
    const folder = (await local.ensureFolder(await destRef(areaB), null, 'target')).itemId;
    const target = { destinationId: areaB, folderId: folder };
    const unchanged = async (what: string) => {
      const now = await file(up.original);
      assert.equal(now.destination_id, areaA, what);
      assert.equal(now.item_id, before.item_id, what);
      assert.equal(now.state, 'stored', what);
      assert.equal(now.old_copy_move_id, null, what);
      assert.equal((await rows(`SELECT 1 FROM stored_file_moves WHERE stored_file_id = $1`, [up.original])).length, 0, what);
      assert.equal(await local.findChild(await destRef(areaB), folder, before.name), null, `${what}: no copy is left at the new place`);
      assert.ok(await exists(areaA, before.item_id), what);
      const res = await download(up.sourceId);
      assert.equal(res.status, 200, what);
      assert.equal(res.text, up.bytes.toString('utf8'), what);
    };

    // A fault on the copy.
    local.copyFault = 'fail';
    await assert.rejects(relocateStoredFile(deps(), up.original, target, 'Test move', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'server');
    await unchanged('copy failed');

    // The copy does not match: by provider hash, and (no provider hash) by the SHA-256 of a download.
    local.copyFault = 'wrong_hash';
    await assert.rejects(relocateStoredFile(deps(), up.original, target, 'Test move', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'server');
    await unchanged('provider hash mismatch');
    local.copyFault = 'no_hash';
    local.tamperDrive = 'driveB';
    await assert.rejects(relocateStoredFile(deps(), up.original, target, 'Test move', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'server');
    local.tamperDrive = null;
    await unchanged('SHA-256 mismatch');

    // Another stored file's item under the name at the target is never adopted.
    const other = await local.upload(await destRef(areaB), folder, before.name, up.bytes, { conflict: 'fail' });
    await t.pool.query(
      `INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, name, size_bytes, state, created_at)
       VALUES ($1, 'source_text', $2, $3, 'local', 'driveB', $4, 'x', 1, 'stored', now())`,
      [uuidv7(), project, areaB, other.itemId],
    );
    local.copyFault = null;
    await assert.rejects(relocateStoredFile(deps(), up.original, target, 'Test move', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'conflict');
    assert.equal((await file(up.original)).destination_id, areaA);
    assert.ok(await exists(areaB, other.itemId), 'the other file is left alone');
    await t.pool.query(`DELETE FROM stored_files WHERE item_id = $1`, [other.itemId]);
    await local.removePermanently(await destRef(areaB), other.itemId);

    // Withheld while it was copied (a security case): the copy is abandoned and removed; the hold keeps the old reference.
    local.duringCopy = async () => {
      await t.pool.query(`UPDATE stored_files SET state = 'withheld' WHERE id = $1 AND state = 'relocating'`, [up.original]);
    };
    await relocateStoredFile(deps(), up.original, target, 'Test move', ids.admin);
    const held = await file(up.original);
    assert.deepEqual([held.state, held.destination_id, held.item_id], ['withheld', areaA, before.item_id]);
    assert.equal(await local.findChild(await destRef(areaB), folder, before.name), null, 'the abandoned copy is removed');
    assert.equal((await rows(`SELECT 1 FROM stored_file_moves WHERE stored_file_id = $1`, [up.original])).length, 0);
    await t.pool.query(`UPDATE stored_files SET state = 'stored' WHERE id = $1`, [up.original]);

    // The copy's answer is lost: the next attempt adopts its own matching copy (no second copy).
    local.copyFault = 'lost';
    await assert.rejects(relocateStoredFile(deps(), up.original, target, 'Test move', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'timeout');
    assert.equal((await file(up.original)).destination_id, areaA, 'a lost answer keeps the old reference');
    const leftover = await local.findChild(await destRef(areaB), folder, before.name);
    assert.ok(leftover, 'the lost copy is there');

    // A fault on removing the old copy: the verified new copy is current, the old reference is kept in the move record
    // and its removal is tried again.
    const rowsBefore = (await rows(`SELECT count(*)::int AS n FROM stored_files`))[0].n;
    local.removeFault = true;
    await assert.rejects(relocateStoredFile(deps(), up.original, target, 'Test move', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'server');
    const moved = await file(up.original);
    assert.equal(moved.destination_id, areaB);
    assert.equal(moved.item_id, leftover!.itemId, 'its own lost copy was adopted');
    assert.equal(moved.state, 'stored');
    assert.equal(moved.check_status, 'ok');
    assert.equal(moved.sha256, before.sha256);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files`))[0].n, rowsBefore, 'one row per file: switched in place');
    const move = (await rows(`SELECT * FROM stored_file_moves WHERE stored_file_id = $1`, [up.original]))[0];
    assert.deepEqual(
      [move.old_destination_id, move.old_item_id, move.old_path, move.new_destination_id, move.new_item_id, move.reason, move.actor_id],
      [areaA, before.item_id, before.path, areaB, leftover!.itemId, 'Test move', ids.admin],
    );
    assert.equal(moved.old_copy_move_id, move.id);
    assert.ok(await exists(areaA, before.item_id), 'the old copy is still there');
    assert.equal((await download(up.sourceId)).text, up.bytes.toString('utf8'), 'downloads use the new copy');
    local.removeFault = false;
    await relocateStoredFile(deps(), up.original, target, 'Test move', ids.admin);
    assert.equal(await exists(areaA, before.item_id), false, 'the old copy is removed on the next attempt');
    assert.equal((await file(up.original)).old_copy_move_id, null);
    assert.equal((await rows(`SELECT 1 FROM stored_file_moves WHERE stored_file_id = $1`, [up.original])).length, 1, 'nothing more to record');
  });

  test('same-drive relocation verifies, records a move whose answer was lost, and puts back or flags a mismatch', async () => {
    const up = await storedUpload('Same drive.txt', 'Moved within one drive.');
    const before = await file(up.original);
    // A second destination on the same drive whose root is a folder of that drive, and a second folder in it.
    const a = await destRef(areaA);
    const cRoot = (await local.ensureFolder(a, null, 'C root')).itemId;
    const areaC = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'local', 'local', 'outputs', 'Same drive', 'driveA', $2, 'approved', $3, now())`,
      [areaC, cRoot, ids.admin],
    );
    const inC = (await local.ensureFolder(await destRef(areaC), null, 'other place')).itemId;
    const parentOf = async () => (await local.getItem(a, before.item_id)).parentId;
    const originalParent = await parentOf();
    const moves = async () => (await rows(`SELECT old_destination_id, new_destination_id, old_item_id, new_item_id, old_path, new_path FROM stored_file_moves WHERE stored_file_id = $1 ORDER BY at, id`, [up.original]));
    const recordUnchanged = async (what: string) => {
      const now = await file(up.original);
      assert.deepEqual([now.destination_id, now.item_id, now.path, now.state], [areaA, before.item_id, before.path, 'stored'], what);
      assert.equal((await moves()).length, 0, what);
      assert.equal(await parentOf(), originalParent, `${what}: the item is where the record says`);
    };

    // Fails verification after the move: moved back, the record unchanged.
    local.moveFault = 'wrong_hash';
    await assert.rejects(relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: inC }, 'Same drive', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'server');
    await recordUnchanged('verification failed');

    // Another item already has the name at the target: refused, nothing taken over.
    const blocker = await local.upload(a, inC, before.name, Buffer.from('somebody else'), { conflict: 'fail' });
    await assert.rejects(relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: inC }, 'Same drive', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'conflict');
    await recordUnchanged('conflict');
    await local.removePermanently(a, blocker.itemId);

    // Two destinations on one drive, the answer lost: the next attempt records the move (same item, nothing removed).
    local.moveFault = 'lost';
    await assert.rejects(relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: inC }, 'Same drive', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'timeout');
    assert.equal((await file(up.original)).destination_id, areaA, 'a lost answer keeps the old reference');
    assert.equal(await parentOf(), inC, 'the provider did move it');
    await relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: inC }, 'Same drive', ids.admin);
    let now = await file(up.original);
    assert.deepEqual([now.destination_id, now.item_id, now.path, now.old_copy_move_id], [areaC, before.item_id, `/other place/${before.name}`, null]);
    assert.deepEqual(await moves(), [
      { old_destination_id: areaA, new_destination_id: areaC, old_item_id: before.item_id, new_item_id: before.item_id, old_path: before.path, new_path: `/other place/${before.name}` },
    ]);
    assert.ok(await exists(areaC, before.item_id), 'the one item is kept');

    // One destination, two folders. Fails verification after the move: moved back, the record unchanged.
    const second = (await local.ensureFolder(await destRef(areaC), null, 'second place')).itemId;
    const atC = async (what: string) => {
      const r = await file(up.original);
      assert.deepEqual([r.destination_id, r.path, r.state], [areaC, `/other place/${before.name}`, 'stored'], what);
      assert.equal((await moves()).length, 1, what);
      assert.equal(await parentOf(), inC, what);
    };
    local.moveFault = 'wrong_hash';
    await assert.rejects(relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: second }, 'Same drive', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'server');
    await atC('verification failed within one destination');
    // Another item already has the name in the second folder: refused.
    const blocker2 = await local.upload(a, second, before.name, Buffer.from('somebody else'), { conflict: 'fail' });
    await assert.rejects(relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: second }, 'Same drive', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'conflict');
    await atC('conflict within one destination');
    await local.removePermanently(a, blocker2.itemId);
    // The answer lost: the record is switched and recorded, not left stale.
    local.moveFault = 'lost';
    await assert.rejects(relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: second }, 'Same drive', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'timeout');
    assert.equal((await file(up.original)).path, `/other place/${before.name}`);
    await relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: second }, 'Same drive', ids.admin);
    now = await file(up.original);
    assert.deepEqual([now.destination_id, now.path, now.state], [areaC, `/second place/${before.name}`, 'stored']);
    assert.equal((await moves()).length, 2);
    // Run again: the record already matches, so nothing more is recorded.
    await relocateStoredFile(deps(), up.original, { destinationId: areaC, folderId: second }, 'Same drive', ids.admin);
    assert.equal((await moves()).length, 2);

    // Changed in storage before the move: flagged Changed (not retried), not moved.
    const text = await file(up.textFile);
    await local.overwrite(a, text.item_id, Buffer.from('Edited in the library.'));
    await assert.rejects(relocateStoredFile(deps(), up.textFile, { destinationId: areaC, folderId: inC }, 'Same drive', ids.admin), (e: unknown) => e instanceof StorageError && e.code === 'invalid');
    const flagged = await file(up.textFile);
    assert.deepEqual([flagged.check_status, flagged.state, flagged.destination_id, flagged.path], ['changed', 'stored', areaA, text.path]);
    assert.notEqual((await local.getItem(a, text.item_id)).parentId, inC);
  });

  test('moving the source area relocates every file, shows progress and downloads use the current copy throughout', async () => {
    const ups = [];
    for (const n of [1, 2, 3]) ups.push(await storedUpload(`Notes ${n}.txt`, `Contents of note ${n} about the valve.`));
    const all = ups.flatMap((u) => [u.original, u.textFile]);
    const items = new Map<string, string>();
    for (const id of all) items.set(id, (await file(id)).item_id);
    const bytes = (await rows(`SELECT sum(size_bytes)::int AS n FROM stored_files WHERE id = ANY($1::uuid[])`, [all]))[0].n;

    const view = await c.admin.request('GET', '/admin/storage/source-area/move');
    assert.equal(view.status, 200);
    assert.deepEqual(view.body, { current: { id: areaA, label: 'Old sources', files: 6, bytes }, move: null });

    // A reason and a confirmation stating the file count and size are needed.
    assert.equal((await startMove({ reason: '' })).status, 400);
    const unconfirmed = await startMove({ confirm: undefined });
    assert.equal(unconfirmed.status, 409);
    assert.deepEqual([(unconfirmed.body as { files: number }).files, (unconfirmed.body as { bytes: number }).bytes], [6, bytes]);
    assert.match((unconfirmed.body as { message: string }).message, /^Moving the source area relocates 6 files \(\d+ B\) to New sources\./);
    assert.equal((await startMove({ confirm: { files: 5, bytes } })).status, 409);
    assert.equal((await rows(`SELECT status FROM storage_destinations WHERE id = $1`, [areaA]))[0].status, 'approved');

    const started = await startMove();
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.deepEqual(
      (await rows(`SELECT id, status FROM storage_destinations ORDER BY label`)).map((r) => [r.id, r.status]),
      [[areaB, 'approved'], [areaA, 'retiring']],
    );
    assert.deepEqual(await counts(), { toMove: 6, moved: 0, failed: 0 });
    assert.equal((await startMove()).status, 409, 'one move at a time');
    assert.equal((await rows(`SELECT 1 FROM audit_events WHERE action = 'storage.source_area_move_started' AND actor_user_id = $1`, [ids.admin])).length, 1);

    // New sources are stored in the new area at once.
    const fresh = await storedUpload('Later.txt', 'Written after the move started.');
    assert.equal((await file(fresh.original)).destination_id, areaB);

    // Downloads work before any file has moved, from the old copy.
    for (const u of ups) assert.equal((await download(u.sourceId)).text, u.bytes.toString('utf8'));

    // One file keeps failing: it stays at its old place and counts as failed after its attempts.
    local.copyFailFor.add(items.get(ups[0].original)!);
    const failures = await drain(['relocate']);
    assert.deepEqual(failures.map((f) => [f.subject, f.code]), [[ups[0].original, 'server']]);
    await onFinalFailure(deps(), 'relocate', ups[0].original, 'server');
    assert.deepEqual(await counts(), { toMove: 1, moved: 5, failed: 1 });
    assert.equal((await file(ups[0].original)).destination_id, areaA);
    assert.equal((await file(ups[0].original)).state, 'stored');
    assert.equal((await rows(`SELECT status FROM storage_destinations WHERE id = $1`, [areaA]))[0].status, 'retiring', 'not complete while a file is left');
    // Downloads use whichever copy is current: the failed one from the old area, the others from the new one.
    for (const u of ups) assert.equal((await download(u.sourceId)).text, u.bytes.toString('utf8'));
    const progress = (await c.admin.request('GET', '/admin/storage/source-area/move')).body as { move: { files: number; bytes: number; from: { id: string }; to: { id: string } } };
    assert.deepEqual([progress.move.files, progress.move.bytes, progress.move.from.id, progress.move.to.id], [6, bytes, areaA, areaB]);

    // Tried again (the daily task queues it), it moves and the move completes.
    local.copyFailFor.clear();
    await storageHandler('relocate')!(deps(), ups[0].original, 1);
    assert.equal(await counts(), null, 'no move in progress');
    assert.equal((await rows(`SELECT status FROM storage_destinations WHERE id = $1`, [areaA]))[0].status, 'withdrawn');
    assert.equal((await rows(`SELECT 1 FROM storage_destination_events WHERE destination_id = $1 AND kind = 'withdrawn'`, [areaA])).length, 1);
    for (const id of all) {
      const f = await file(id);
      assert.equal(f.destination_id, areaB);
      assert.equal(f.drive_id, 'driveB');
      assert.equal(f.failure_code, null);
      assert.match(f.path, new RegExp(`^/projects/${project}/sources/`));
      assert.equal(await exists(areaA, items.get(id)!), false, 'the old copy is removed permanently');
      assert.equal(sha(await local.download(await destRef(areaB), f.item_id)), f.sha256);
    }
    assert.equal((await rows(`SELECT count(DISTINCT stored_file_id)::int AS n FROM stored_file_moves WHERE reason = 'Source area moved'`))[0].n, 6);
    for (const u of ups) assert.equal((await download(u.sourceId)).text, u.bytes.toString('utf8'));
  });

  test('the old source area stays approved for reading until the move completes', async () => {
    const up = await storedUpload('Kept.txt', 'Kept at the old place for now.');
    // A storage Administrator has write access on the old area.
    assert.equal((await c.admin.request('POST', '/admin/storage/admins', { userId: ids.bob, reason: 'Looks after the source files' })).status, 201);
    await drain(['share-sync']);
    const folderOf = async (dest: string) => (await rows(`SELECT id, item_id FROM storage_folders WHERE destination_id = $1 AND level = 'source_root'`, [dest]))[0];
    const usersOn = async (dest: string) => {
      const f = await folderOf(dest);
      return f ? (await local.listPermissions(await destRef(dest), f.item_id)).filter((p) => p.kind === 'user').map((p) => `${p.principal}:${p.roles.join('+')}`) : [];
    };
    assert.deepEqual(await usersOn(areaA), ['bob@example.org:write']);

    local.copyFault = 'fail';
    assert.equal((await startMove()).status, 200);
    await drain(['share-sync', 'backfill-sources']);
    const failed = await drain(['relocate']);
    assert.equal(failed.length, 2);

    // Still read from, still checked, and the storage Administrator keeps access there; the new area grants it too.
    assert.equal((await rows(`SELECT status FROM storage_destinations WHERE id = $1`, [areaA]))[0].status, 'retiring');
    assert.equal((await download(up.sourceId)).text, up.bytes.toString('utf8'));
    const checked = await checkSourceFiles(deps(), t.clock.now());
    assert.deepEqual(checked, { checked: 2, flagged: 0 });
    // As the daily reconciliation would: the old area's folder is synced and keeps the grant.
    await syncFolderGrants(deps(), (await folderOf(areaA)).id, { retryNotFound: true });
    assert.deepEqual(await usersOn(areaA), ['bob@example.org:write']);
    assert.deepEqual(await usersOn(areaB), ['bob@example.org:write']);
    // Neither side is withdrawn or approved by hand meanwhile.
    for (const [id, action] of [[areaA, 'withdraw'], [areaB, 'withdraw'], [areaA, 'approve']] as const) {
      const r = await c.admin.request('POST', `/admin/storage/destinations/${id}/${action}`, { reason: 'Tidy up' });
      assert.equal(r.status, 409, `${action} ${id}`);
      assert.match(JSON.stringify(r.body), /The source area is being moved/);
    }

    local.copyFault = null;
    for (const id of [up.original, up.textFile]) await storageHandler('relocate')!(deps(), id, 1);
    assert.equal((await rows(`SELECT status FROM storage_destinations WHERE id = $1`, [areaA]))[0].status, 'withdrawn');
    // Withdrawn: the storage Administrator's access to the old area is removed; the new area keeps it.
    await drain(['share-sync']);
    assert.deepEqual(await usersOn(areaA), []);
    assert.deepEqual(await usersOn(areaB), ['bob@example.org:write']);
    assert.equal((await download(up.sourceId)).text, up.bytes.toString('utf8'));
  });

  test('manifest lists every stored file with neutral references, hides restricted titles and records the download', async () => {
    const up = await storedUpload('Plan.txt', 'Source plan text.');
    const outDest = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'local', 'local', 'outputs', 'Outputs library', 'driveO', 'root-driveO', 'approved', $2, now())`,
      [outDest, ids.admin],
    );
    /** An output with one filed version; `review` makes it readable by fewer than the whole project. */
    const output = async (title: string, review: boolean, path: string) => {
      const o = uuidv7();
      const f = uuidv7();
      await t.pool.query(
        `INSERT INTO outputs (id, project_id, title, status, review_state, author_id, created_at) VALUES ($1, $2, $3, 'registered', $4, $5, now())`,
        [o, project, title, review ? 'review_required' : 'none', ids.pm],
      );
      await t.pool.query(
        `INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, path, name, size_bytes, sha256, provider_hash, state, created_at)
         VALUES ($1, 'output', $2, $3, 'local', 'driveO', $4, $5, $6, 42, 'abc', 'QXH', 'stored', now())`,
        [f, project, outDest, `item-${o}`, path, `${title} v1.pdf`],
      );
      await t.pool.query(
        `INSERT INTO output_versions (id, output_id, version_no, origin, format, stored_file_id, status, sha256, size_bytes, created_by, created_at)
         VALUES ($1, $2, 1, 'upload', 'pdf', $3, 'draft', 'abc', 42, $4, now())`,
        [uuidv7(), o, f, ids.pm],
      );
      return { o, f };
    };
    const open = await output('Pump status', false, '/Registry/Project/2026/Status reports/Pump status v1.pdf');
    const hidden = await output('Zebrafish merger', true, '/Registry/Project (restricted)/Zebrafish merger/Zebrafish merger v1.pdf');

    const res = await c.admin.raw('GET', '/admin/storage/manifest');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="kainow-storage-manifest-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const text = res.text.replace(/^﻿/, '');
    assert.doesNotMatch(text, /Zebrafish merger/, 'a restricted title never appears');
    assert.doesNotMatch(text, /Source plan text/, 'no content');
    const lines = text.split('\r\n').filter((l) => l !== '');
    const meta = lines.filter((l) => l.startsWith('# '));
    assert.ok(meta.some((l) => l === '# Files: 4'));
    const body = lines.filter((l) => !l.startsWith('# '));
    assert.equal(body[0], MANIFEST_COLUMNS.join(','));
    assert.equal(body.length, 5, 'a header and every stored file');
    const byId = (id: string) => body.find((l) => l.includes(id))!;
    const projectName = (await rows(`SELECT name FROM projects WHERE id = $1`, [project]))[0].name;
    const original = await file(up.original);
    assert.equal(
      body.find((l) => l.startsWith('source original,')),
      ['source original', project, projectName, up.sourceId, 1, 'Old sources', 'local', 'driveA', original.item_id, original.path, original.size_bytes,
        original.sha256, original.provider_hash, 'stored', 'unverified'].map((v) => csvCell(typeof v === 'number' ? v : String(v))).join(','),
    );
    assert.ok(body.some((l) => l.startsWith('source text,')));
    assert.equal(
      byId(open.o),
      ['output', project, projectName, open.o, 1, 'Outputs library', 'local', 'driveO', `item-${open.o}`, '/Registry/Project/2026/Status reports/Pump status v1.pdf',
        42, 'abc', 'QXH', 'stored', 'unverified'].map((v) => csvCell(typeof v === 'number' ? v : String(v))).join(','),
    );
    assert.equal(
      byId(hidden.o),
      ['output', project, projectName, hidden.o, 1, 'Outputs library', 'local', 'driveO', `item-${hidden.o}`, RESTRICTED_ITEM, 42, 'abc', 'QXH', 'stored', 'unverified'].map((v) => csvCell(typeof v === 'number' ? v : String(v))).join(','),
    );
    const audit = await rows(`SELECT actor_user_id, subject_type, detail FROM audit_events WHERE action = 'storage.manifest_downloaded'`);
    assert.deepEqual(audit, [{ actor_user_id: ids.admin, subject_type: 'storage_manifest', detail: { files: 4 } }]);
  });

  test('only Enterprise Administrators may move or download', async () => {
    await storedUpload('Plan.txt', 'Source plan text.');
    for (const who of ['pm', 'bob'] as const) {
      assert.equal((await c[who].request('GET', '/admin/storage/source-area/move')).status, 403, who);
      assert.equal(
        (await c[who].request('POST', '/admin/storage/source-area/move', { destinationId: areaB, reason: 'Mine now', confirm: { files: 2, bytes: 1 } })).status,
        403,
        who,
      );
      assert.equal((await c[who].raw('GET', '/admin/storage/manifest')).status, 403, who);
    }
    assert.equal((await rows(`SELECT status FROM storage_destinations WHERE id = $1`, [areaA]))[0].status, 'approved');
    assert.equal((await rows(`SELECT 1 FROM audit_events WHERE action IN ('storage.manifest_downloaded', 'storage.source_area_move_started')`)).length, 0);
    assert.equal((await rows(`SELECT 1 FROM storage_outbox WHERE job = 'relocate'`)).length, 0);
    // Another Enterprise Administrator may.
    assert.equal((await c.admin2.raw('GET', '/admin/storage/manifest')).status, 200);
  });
});
