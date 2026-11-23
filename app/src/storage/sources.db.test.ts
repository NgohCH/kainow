import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { NotesService } from '../notes/notes.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedWorkingProject, seedUser } from '../testing/projects';
import type { StorageConnectorFactory } from './connector-factory';
import { LocalConnector } from './connectors/local';
import { type StorageDeps, onFinalFailure } from './jobs';
import { quickXorHash } from './quickxor';
import { standaloneCases } from '../testing/quarantine';
import { backfillSources, dailySourceTask, storeSourceVersion } from './sources';
import { type DestinationRef, StorageError, type StoredRef } from './types';

/** The local connector, recording every upload's path, and able to misreport one hash or lose one upload's answer. */
class SpyConnector extends LocalConnector {
  uploads: string[] = [];
  uploadedIds: string[] = [];
  alterHashOnce = false;
  loseAnswerOnce = false;
  /** Runs once, after the next upload has landed (for example a quarantine clean while storing). */
  afterUploadOnce: (() => Promise<void>) | null = null;
  override async upload(dest: DestinationRef, folderId: string, name: string, bytes: Buffer, opts: { conflict: 'fail' }): Promise<StoredRef> {
    const ref = await super.upload(dest, folderId, name, bytes, opts);
    this.uploads.push(ref.path);
    this.uploadedIds.push(ref.itemId);
    const after = this.afterUploadOnce;
    this.afterUploadOnce = null;
    await after?.();
    if (this.loseAnswerOnce) {
      this.loseAnswerOnce = false;
      throw new StorageError('timeout');
    }
    if (this.alterHashOnce) {
      this.alterHashOnce = false;
      return { ...ref, providerHash: Buffer.alloc(20, 7).toString('base64') };
    }
    return ref;
  }
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const BYTES = Buffer.from('Site visit notes\nThe pump was replaced.\n', 'utf8');

describe('managed source area: storing source versions', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let spy: SpyConnector;
  let connected: boolean;
  let pmId: string;
  let pm: Client;
  let project: string;
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => {
      if (!connected) throw new StorageError('invalid');
      return { connector: spy, dest: { id, connector: 'local', driveId: 'drive1', rootItemId: 'root' } };
    },
    forNew: async () => spy,
  };
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: async () => undefined });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const notes = () => t.app.get(NotesService);

  const approveArea = async (): Promise<string> => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'local', 'local', 'source_area', 'Sources', 'drive1', 'root', 'approved', $2, now())`,
      [id, pmId],
    );
    return id;
  };
  const uploadNote = async (name = 'Site notes.txt', bytes = BYTES) =>
    notes().createSource({ projectId: project, content: { file: { originalname: name, buffer: bytes } }, actorUserId: pmId, reauthorise: async () => undefined });
  const filesOf = async (versionId: string) =>
    rows(
      `SELECT f.purpose, f.name, f.state, f.project_id, f.attempts, f.failure_code, f.item_id, f.path, f.size_bytes, f.sha256, f.provider_hash, f.destination_id, f.stored_at
         FROM stored_files f JOIN source_versions v ON f.id IN (v.original_stored_file_id, v.text_stored_file_id)
        WHERE v.id = $1 ORDER BY f.purpose`,
      [versionId],
    );
  const version = async (id: string) =>
    (await rows(`SELECT original_bytes, original_sha256, text_sha256, text_content, original_stored_file_id, text_stored_file_id FROM source_versions WHERE id = $1`, [id]))[0];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-sources-'));
    spy = new SpyConnector(dir);
    connected = true;
    t = await startTestApp(undefined, { storageConnectors: factory });
    pmId = await seedUser(t.pool, 'pm@example.org');
    project = await seedWorkingProject(t.pool, pmId);
    pm = await t.signIn('pm@example.org');
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('importing an upload creates pending original and text files and an outbox row in the same transaction', async () => {
    const { version: v } = await uploadNote();
    const files = await filesOf(v.id);
    assert.deepEqual(
      files.map((f) => [f.purpose, f.name, f.state, f.project_id, f.attempts]),
      [['source_original', 'original.txt', 'pending', project, 0], ['source_text', 'text.txt', 'pending', project, 0]],
    );
    // Each reference points at a file of its own purpose.
    const refs = await rows(
      `SELECT o.purpose AS o, t.purpose AS t FROM source_versions v JOIN stored_files o ON o.id = v.original_stored_file_id
         JOIN stored_files t ON t.id = v.text_stored_file_id WHERE v.id = $1`,
      [v.id],
    );
    assert.deepEqual(refs, [{ o: 'source_original', t: 'source_text' }]);
    assert.deepEqual(await rows(`SELECT job, subject_id, sent_at FROM storage_outbox`), [{ job: 'store-source', subject_id: v.id, sent_at: null }]);
    assert.ok((await version(v.id)).original_bytes, 'the bytes stay until storage is confirmed');

    // A failure later in the same transaction leaves no files and no outbox row behind.
    await assert.rejects(
      notes().createSource({
        projectId: project,
        content: { file: { originalname: 'Other.txt', buffer: Buffer.from('Other notes.') } },
        actorUserId: pmId,
        reauthorise: async () => undefined,
        submission: { submittedBy: pmId, intendedMode: 'project', refuse: () => undefined, after: async () => { throw new Error('after failed'); } },
      }),
      /after failed/,
    );
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files`))[0].n, 2);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox`))[0].n, 1);
  });

  test('pasted text creates a text file only', async () => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title: 'Pasted', text: 'Agreed to replace the pump.' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const files = await filesOf(r.body.version.id);
    assert.deepEqual(files.map((f) => [f.purpose, f.name, f.state]), [['source_text', 'text.txt', 'pending']]);
    assert.equal((await version(r.body.version.id)).original_stored_file_id, null);
    // A pasted new version too.
    const v2 = await pm.request('POST', `/notes/${r.body.source.id}/versions`, { text: 'Agreed to replace both pumps.' });
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    assert.deepEqual((await filesOf(v2.body.version.id)).map((f) => f.purpose), ['source_text']);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox WHERE job = 'store-source'`))[0].n, 2);
  });

  test('store-source uploads both files, verifies hashes, marks them stored and clears original_bytes keeping original_sha256', async () => {
    const areaId = await approveArea();
    const { source, version: v } = await uploadNote();
    const before = await version(v.id);
    await storeSourceVersion(deps(), v.id);

    const after = await version(v.id);
    assert.equal(after.original_bytes, null);
    assert.equal(after.original_sha256, sha(BYTES), 'the hash is kept');
    assert.equal(after.text_content, before.text_content, 'the working text stays in the database');
    const [orig, text] = await filesOf(v.id);
    const folder = `/projects/${project}/sources/${source.id}/v1`;
    assert.equal(orig.state, 'stored');
    assert.equal(orig.path, `${folder}/original.txt`);
    assert.equal(Number(orig.size_bytes), BYTES.length);
    assert.equal(orig.sha256, sha(BYTES));
    assert.equal(orig.provider_hash, quickXorHash(BYTES));
    assert.equal(orig.destination_id, areaId);
    assert.ok(orig.item_id);
    assert.deepEqual(orig.stored_at, t.clock.now());
    const textBytes = Buffer.from(before.text_content, 'utf8');
    assert.equal(text.state, 'stored');
    assert.equal(text.path, `${folder}/text.txt`);
    assert.equal(text.sha256, before.text_sha256, 'the text file is the working text, UTF-8');
    assert.equal(text.provider_hash, quickXorHash(textBytes));
    const dest = { id: areaId, connector: 'local' as const, driveId: 'drive1', rootItemId: 'root' };
    assert.deepEqual(await spy.download(dest, orig.item_id), BYTES);
    assert.deepEqual(await spy.download(dest, text.item_id), textBytes);
    assert.deepEqual(await rows(`SELECT level, key, name FROM storage_folders WHERE destination_id = $1`, [areaId]), [
      { level: 'source_root', key: 'projects', name: 'projects' },
    ]);

    // Running again (at-least-once delivery) changes nothing.
    const uploads = spy.uploads.length;
    await storeSourceVersion(deps(), v.id);
    assert.equal(spy.uploads.length, uploads);
    assert.deepEqual((await filesOf(v.id)).map((f) => f.state), ['stored', 'stored']);
  });

  test('an upload whose answer was lost is adopted on the next attempt when size and hash match', async () => {
    await approveArea();
    const { version: v } = await uploadNote();
    spy.loseAnswerOnce = true;
    await assert.rejects(storeSourceVersion(deps(), v.id), (e: unknown) => e instanceof StorageError && e.code === 'timeout');
    assert.deepEqual((await filesOf(v.id)).map((f) => [f.state, f.attempts, f.failure_code]), [['pending', 1, 'timeout'], ['pending', 1, 'timeout']]);
    assert.ok((await version(v.id)).original_bytes);
    await storeSourceVersion(deps(), v.id);
    assert.deepEqual((await filesOf(v.id)).map((f) => [f.state, f.failure_code]), [['stored', null], ['stored', null]]);
    assert.equal((await version(v.id)).original_bytes, null);
  });

  test('a hash mismatch from the provider fails the attempt and keeps the bytes', async () => {
    await approveArea();
    const { version: v } = await uploadNote();
    spy.alterHashOnce = true;
    await assert.rejects(storeSourceVersion(deps(), v.id), (e: unknown) => e instanceof StorageError && e.code === 'server');
    assert.deepEqual((await filesOf(v.id)).map((f) => [f.state, f.attempts]), [['pending', 1], ['pending', 1]]);
    assert.deepEqual((await version(v.id)).original_bytes, BYTES, 'nothing is cleared until the provider confirms the file');
    // The next attempt stores it.
    await storeSourceVersion(deps(), v.id);
    assert.deepEqual((await filesOf(v.id)).map((f) => f.state), ['stored', 'stored']);
    assert.equal((await version(v.id)).original_bytes, null);
  });

  test('a clean while uploading records nothing stored and removes what was uploaded', async () => {
    const areaId = await approveArea();
    const { source, version: v } = await uploadNote();
    // Kainow reports a secret in the note (with the protected key: held and cleaned at once) while the original uploads.
    spy.afterUploadOnce = async () => {
      await standaloneCases(t.pool, t.clock.now).report('kainow', { projectId: project, kind: 'source', id: source.id, marked: ['pump'], reason: null });
    };
    await assert.rejects(storeSourceVersion(deps(), v.id), (e: unknown) => e instanceof StorageError && e.code === 'conflict');
    assert.deepEqual((await filesOf(v.id)).map((f) => [f.state, f.item_id, f.stored_at, f.attempts]), [['pending', null, null, 0], ['pending', null, null, 0]]);
    assert.ok(spy.uploadedIds.length > 0);
    const dest = { id: areaId, connector: 'local' as const, driveId: 'drive1', rootItemId: 'root' };
    for (const id of spy.uploadedIds) {
      await assert.rejects(spy.getItem(dest, id), (e: unknown) => e instanceof StorageError && e.code === 'not_found', 'the uploaded copy was removed');
    }
    // The next attempt finds the source held and stores nothing.
    const uploads = spy.uploads.length;
    await storeSourceVersion(deps(), v.id);
    assert.equal(spy.uploads.length, uploads);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files WHERE state = 'stored'`))[0].n, 0);
  });

  test('the daily tick tries a failed version again once its last attempt is a day old', async () => {
    const areaId = await approveArea();
    const { version: v } = await uploadNote();
    await onFinalFailure(deps(), 'store-source', v.id, 'server');
    await t.pool.query(
      `INSERT INTO storage_attempts (id, job, subject_id, outcome, duration_ms, at) VALUES ($1, 'store-source', $2, 'server', 1, $3)`,
      [uuidv7(), v.id, new Date(t.clock.now().getTime() - 3600_000)],
    );
    const queued = async () => (await rows(`SELECT job, subject_id FROM storage_outbox WHERE sent_at IS NULL ORDER BY job, subject_id`));
    await t.pool.query(`UPDATE storage_outbox SET sent_at = now()`);
    await dailySourceTask(deps());
    assert.deepEqual(await queued(), [{ job: 'backfill-sources', subject_id: areaId }], 'an hour after its last attempt it rests');
    await t.pool.query(`UPDATE storage_outbox SET sent_at = now()`);
    t.clock.advanceSeconds(24 * 3600);
    await dailySourceTask(deps());
    assert.deepEqual(await queued(), [{ job: 'backfill-sources', subject_id: areaId }, { job: 'store-source', subject_id: v.id }]);
    await storeSourceVersion(deps(), v.id);
    assert.deepEqual((await filesOf(v.id)).map((f) => f.state), ['stored', 'stored']);
  });

  test('after the last attempt the files show as failed', async () => {
    await approveArea();
    const { version: v } = await uploadNote();
    await onFinalFailure(deps(), 'store-source', v.id, 'forbidden');
    assert.deepEqual((await filesOf(v.id)).map((f) => [f.state, f.failure_code]), [['failed', 'forbidden'], ['failed', 'forbidden']]);
    assert.ok((await version(v.id)).original_bytes, 'a failed version keeps its bytes');
  });

  test('without an approved source area versions stay pending with bytes and Kainow keeps working', async () => {
    const { source, version: v } = await uploadNote();
    await storeSourceVersion(deps(), v.id);
    assert.equal(await backfillSources(deps()), 0);
    assert.deepEqual((await filesOf(v.id)).map((f) => [f.state, f.attempts]), [['pending', 0], ['pending', 0]]);
    assert.equal(spy.uploads.length, 0);
    // The download is still served from the bytes.
    const dl = await pm.raw('GET', `/notes/${source.id}/versions/1/original`);
    assert.equal(dl.status, 200);
    assert.equal(dl.text, BYTES.toString('utf8'));
    // With an approved source area but no usable connection, the versions wait too: no attempt is counted.
    await approveArea();
    connected = false;
    await storeSourceVersion(deps(), v.id);
    assert.equal(await backfillSources(deps()), 0);
    assert.deepEqual((await filesOf(v.id)).map((f) => [f.state, f.attempts]), [['pending', 0], ['pending', 0]]);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox WHERE job = 'backfill-sources'`))[0].n, 0, 'no busy loop');
    // Once connected, the backfill stores it.
    connected = true;
    assert.equal(await backfillSources(deps()), 1);
    assert.deepEqual((await filesOf(v.id)).map((f) => f.state), ['stored', 'stored']);
  });

  test('backfill creates stored_files rows for versions from before 0031 and stores them oldest first, 100 per run', async () => {
    const sourceId = uuidv7();
    await t.pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'Old notes', $2, '2026-01-01T00:00:00Z', $3)`, [sourceId, pmId, project]);
    // 101 versions written before 0031: no stored files. Ids run backwards in time, so only created_at gives the order.
    const ids: string[] = [];
    for (let n = 101; n >= 1; n--) ids[n] = uuidv7();
    for (let n = 1; n <= 101; n++) {
      const text = `Version ${n} of the old notes.`;
      const upload = n === 1;
      await t.pool.query(
        `INSERT INTO source_versions (id, source_id, version_no, origin, filename, media_type, original_bytes, original_sha256, text_content, text_sha256, char_count, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [ids[n], sourceId, n, upload ? 'upload' : 'paste', upload ? 'old.md' : null, upload ? 'text/markdown' : null, upload ? BYTES : null, upload ? sha(BYTES) : null,
          text, sha(text), text.length, pmId, new Date(Date.UTC(2026, 0, 1) + n * 60_000)],
      );
    }
    // A note from before projects has no place in the source area and is left alone.
    const loose = uuidv7();
    await t.pool.query(`INSERT INTO sources (id, title, created_by, created_at) VALUES ($1, 'Loose', $2, '2025-01-01T00:00:00Z')`, [loose, pmId]);
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at) VALUES ($1, $2, 1, 'paste', 'x', $3, 1, $4, '2025-01-01T00:00:00Z')`,
      [uuidv7(), loose, sha('x'), pmId],
    );
    const areaId = await approveArea();

    assert.equal(await backfillSources(deps()), 100);
    const versionNos = spy.uploads.filter((p) => p.endsWith('/text.txt')).map((p) => Number(/\/v(\d+)\/text\.txt$/.exec(p)?.[1]));
    assert.deepEqual(versionNos, Array.from({ length: 100 }, (_, i) => i + 1), 'oldest first');
    assert.equal(spy.uploads.filter((p) => p.endsWith('/original.md')).length, 1, 'the old upload keeps its original');
    assert.equal((await version(ids[1])).original_bytes, null);
    assert.deepEqual((await filesOf(ids[1])).map((f) => [f.purpose, f.state]), [['source_original', 'stored'], ['source_text', 'stored']]);
    assert.equal((await version(ids[101])).text_stored_file_id, null, 'the 101st waits for the next run');
    assert.deepEqual(await rows(`SELECT job, subject_id FROM storage_outbox`), [{ job: 'backfill-sources', subject_id: areaId }], 'it queues itself again');

    assert.equal(await backfillSources(deps()), 1);
    assert.deepEqual((await filesOf(ids[101])).map((f) => [f.purpose, f.state]), [['source_text', 'stored']]);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox`))[0].n, 1, 'nothing left: not queued again');
    assert.equal(await backfillSources(deps()), 0);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files`))[0].n, 102, 'the loose note has none');
  });

  test('a version that fails in the backfill gets its own store-source job and is not picked again', async () => {
    const { version: v } = await uploadNote();
    await approveArea();
    spy.alterHashOnce = true;
    assert.equal(await backfillSources(deps()), 1);
    assert.deepEqual(await rows(`SELECT job, subject_id FROM storage_outbox ORDER BY created_at, id`), [
      { job: 'store-source', subject_id: v.id },
      { job: 'store-source', subject_id: v.id },
    ]);
    assert.deepEqual((await filesOf(v.id)).map((f) => f.attempts), [1, 1]);
    assert.equal(await backfillSources(deps()), 0, 'its retries belong to its own job');
  });
});
