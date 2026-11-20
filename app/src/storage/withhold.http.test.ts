import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { M365TokenSource } from '../email/m365-token';
import { NotesService } from '../notes/notes.service';
import { type ProtectedKey, loadProtectedKey } from '../quarantine/protected-key';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { projectHolding, standaloneCases } from '../testing/quarantine';
import type { StorageConnectorFactory } from './connector-factory';
import { GraphConnector } from './connectors/graph';
import { type StorageDeps, type StorageJob, onFinalFailure, storageHandler } from './jobs';
import { makeStorageNotify } from './notices';
import { storeSourceVersion } from './sources';
import { type DestinationRef, StorageError } from './types';
import { HELD_FILE_NOT_REMOVED_TEXT, STILL_IN_STORAGE, dailyWithholdTask } from './withhold';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT = 'Pump station renewal';
/** The suspected secret: in output titles and file content, and in a source's text. */
const SECRET = 'QX7VAULT90210ZETA';

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = 'withholdboundary42';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

describe('withholding held files in storage', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let fake: FakeGraph;
  let connector: GraphConnector;
  let drive: { driveId: string; rootItemId: string };
  let keyDir: string;
  let key: ProtectedKey;
  let outputsRoot: string;
  let sourcesRoot: string;
  let destId: string;
  let dept: string;
  let project: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  /** Runs once, right after the next upload is accepted (as something happening while a file uploads). */
  let afterUpload: (() => Promise<void>) | null = null;
  const logs: string[] = [];
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => {
      const r = (await t.pool.query(`SELECT drive_id, root_item_id FROM storage_destinations WHERE id = $1`, [id])).rows[0];
      if (!r) throw new StorageError('invalid');
      const wrapped = Object.create(connector) as GraphConnector;
      wrapped.upload = async (...args) => {
        const ref = await connector.upload(...args);
        const hook = afterUpload;
        afterUpload = null;
        if (hook) await hook();
        return ref;
      };
      return { connector: wrapped, dest: { id, connector: 'graph', driveId: r.drive_id, rootItemId: r.root_item_id } };
    },
    forNew: async () => connector,
  };
  const driveRoot = (): DestinationRef => ({ id: 'drive', connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId });
  const deps = (withKey = true): StorageDeps => ({
    pool: t.pool, connectors: factory, key: withKey ? key : null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now), log: (m) => void logs.push(m),
  });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const typeId = async (name: string) => (await rows(`SELECT id FROM report_types WHERE name = $1`, [name]))[0].id as string;
  const url = (p = '') => `/projects/${project}/outputs${p}`;
  const fileRow = async (outputId: string) =>
    (await rows(`SELECT f.* FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id WHERE v.output_id = $1 AND v.version_no = 1`, [outputId]))[0];
  const exists = async (itemId: string) =>
    connector.getItem(driveRoot(), itemId).then(
      () => true,
      (err) => {
        if (err instanceof StorageError && err.code === 'not_found') return false;
        throw err;
      },
    );
  const download = (itemId: string) => connector.download(driveRoot(), itemId);
  const callIndex = (from: number, test: (x: { method: string; path: string }) => boolean) => fake.calls.findIndex((x, i) => i >= from && test(x));
  const permanentlyDeleted = (itemId: string) => fake.calls.some((x) => x.method === 'POST' && x.path.endsWith(`/items/${itemId}/permanentDelete`));
  const recycled = (itemId: string) => fake.recycleBin(drive.driveId).includes(itemId) || fake.calls.some((x) => x.method === 'DELETE' && x.path.endsWith(`/items/${itemId}`));
  /** Every item in the drive, by name (folders and files), as the provider lists them. */
  async function driveNames(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (id: string): Promise<void> => {
      const r = await fake.fetch(`${fake.graphBase}/drives/${drive.driveId}/items/${id}/children`, { headers: { Authorization: `Bearer ${fake.token}` } });
      for (const it of ((await r.json()) as { value: Array<{ id: string; name: string; folder?: unknown }> }).value) {
        out.push(it.name);
        if (it.folder) await walk(it.id);
      }
    };
    await walk(drive.rootItemId);
    return out;
  }
  /** No text column of these tables holds the secret (row text; bytea columns are hex there). */
  async function noPlainCopy(tables = ['outputs', 'stored_files', 'stored_file_moves', 'storage_folders']): Promise<void> {
    for (const table of tables) assert.equal((await rows(`SELECT count(*)::int AS n FROM ${table} x WHERE strpos(x::text, $1) > 0`, [SECRET]))[0].n, 0, table);
  }
  const contentOriginals = async (fileId: string) =>
    rows(`SELECT * FROM quarantine_originals WHERE table_name = 'stored_files' AND column_name = 'content' AND row_key->>'id' = $1 ORDER BY sweep`, [fileId]);

  async function drain(withKey = true): Promise<Array<{ job: StorageJob; subjectId: string; failed?: string }>> {
    const ran: Array<{ job: StorageJob; subjectId: string; failed?: string }> = [];
    for (let i = 0; i < 100; i++) {
      const next = (
        await rows(`UPDATE storage_outbox SET sent_at = now() WHERE id = (SELECT id FROM storage_outbox WHERE sent_at IS NULL ORDER BY urgent DESC, created_at, id LIMIT 1) RETURNING job, subject_id`)
      )[0];
      if (!next) return ran;
      const entry: { job: StorageJob; subjectId: string; failed?: string } = { job: next.job, subjectId: next.subject_id };
      try {
        await storageHandler(next.job)!(deps(withKey), next.subject_id, 1);
      } catch (err) {
        entry.failed = (err as { code?: string }).code ?? 'internal';
      }
      ran.push(entry);
    }
    throw new Error('the outbox did not drain');
  }

  async function filedOutput(title: string, bytes = Buffer.from(`# ${title}\n\nThe valve audit is on Friday.\n`)): Promise<{ out: string; file: Record<string, any> }> {
    const m = multipart({ title }, { name: 'report.md', bytes });
    const sub = await c.pm.upload('POST', url(), m.body, m.type);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    assert.equal((await c.pm.request('POST', url(`/${sub.body.id}/register`), { reportTypeId: await typeId('Status reports'), issueDate: '2026-11-09' })).status, 200);
    assert.equal((await c.pm.request('POST', url(`/${sub.body.id}/versions/1/file`))).status, 200);
    await drain();
    const file = await fileRow(sub.body.id);
    assert.equal(file.state, 'stored');
    return { out: sub.body.id, file };
  }
  async function report(kind: string, id: string): Promise<string> {
    const r = await c.pm.request('POST', `/projects/${project}/secret-reports`, { kind, id, marked: [SECRET], reason: 'Looks like the plant room vault code' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    t.clock.advanceSeconds(1);
    return r.body.caseId as string;
  }
  const heldCase = async (caseId: string) => {
    const r = await c.pm.request('GET', `/projects/${project}/held`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body.cases as any[]).find((x) => x.caseId === caseId);
  };
  const adminCase = async (caseId: string) => ((await c.admin.request('GET', '/security/admin-cases')).body.cases as any[]).find((x) => x.caseId === caseId);
  /** rev designated by admin, asks to open the case, admin2 approves, rev releases it unchanged (a false alarm). */
  async function releaseUnchanged(caseId: string): Promise<void> {
    assert.equal((await c.admin.request('POST', `/security/reviewers/${ids.rev}/designate`, { reason: 'Trained in credential handling' })).status, 200);
    const g = await c.rev.request('POST', '/security/grants', { caseIds: [caseId], purpose: 'Decide whether this is a live credential' });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    assert.equal((await c.admin2.request('POST', `/security/grants/${g.body.grantId}/decide`, { decision: 'approved', reason: 'Purpose is clear' })).status, 200);
    const r = await c.rev.request('POST', `/security/cases/${caseId}/release-unchanged`, { reason: 'False alarm: a printed example code' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  beforeEach(async () => {
    afterUpload = null;
    logs.length = 0;
    keyDir = mkdtempSync(join(tmpdir(), 'kainow-withhold-'));
    const keyFile = join(keyDir, 'key');
    writeFileSync(keyFile, randomBytes(32));
    key = loadProtectedKey(keyFile) as ProtectedKey;
    fake = await startFakeGraph();
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    connector = new GraphConnector(tokens, { fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: true, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
    drive = fake.addDrive();
    t = await startTestApp(undefined, { storageConnectors: factory, protectedKeyFile: keyFile });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    ids.admin2 = await seedUser(t.pool, 'admin2@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'owner', 'ada', 'rev', 'store']) {
      ids[k] = await seedUser(t.pool, `${k}@example.org`);
      fake.addUser(`${k}@example.org`);
    }
    dept = await seedDepartment(t.pool, 'Water Services');
    project = await seedProject(t.pool, {
      status: 'active',
      name: PROJECT,
      departmentId: dept,
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    outputsRoot = (await connector.createFolder(driveRoot(), null, 'Outputs')).itemId;
    sourcesRoot = (await connector.createFolder(driveRoot(), null, 'Sources')).itemId;
    destId = uuidv7();
    const insertDest = (id: string, purpose: string, label: string, root: string) =>
      t.pool.query(
        `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
         VALUES ($1, 'graph', 'sharepoint_library', $2, $3, $4, $5, 'approved', $6, now())`,
        [id, purpose, label, drive.driveId, root, ids.admin],
      );
    await insertDest(destId, 'outputs', 'Outputs library', outputsRoot);
    await insertDest(uuidv7(), 'source_area', 'Source area', sourcesRoot);
    await t.pool.query(`INSERT INTO project_output_settings (project_id, destination_id) VALUES ($1, $2)`, [project, destId]);
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.org', $2, now())`, [uuidv7(), ids.admin]);
    await t.pool.query(
      `INSERT INTO storage_admins (id, user_id, designated_by, designated_at, reason) VALUES ($1, $2, $3, now(), 'Runs the document libraries')`,
      [uuidv7(), ids.store, ids.admin],
    );
    for (const k of ['admin', 'admin2', 'pm', 'deputy', 'owner', 'ada', 'rev', 'store']) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
    rmSync(keyDir, { recursive: true, force: true });
  });

  /** An uploaded note naming the secret, stored in the source area: its original and its text file. */
  async function storedSource(): Promise<{ sourceId: string; versionId: string; original: Record<string, any>; text: Record<string, any>; bytes: Buffer }> {
    const bytes = Buffer.from(`Plant room notes.\nThe vault code is ${SECRET} for the valve room.\n`);
    const { source, version } = await t.app.get(NotesService).createSource({
      projectId: project, content: { file: { originalname: 'Site notes.txt', buffer: bytes } }, actorUserId: ids.pm,
    });
    await storeSourceVersion(deps(), version.id);
    await drain();
    const [original, text] = await rows(
      `SELECT f.* FROM source_versions v JOIN stored_files f ON f.id IN (v.original_stored_file_id, v.text_stored_file_id) WHERE v.id = $1 ORDER BY f.purpose`,
      [version.id],
    );
    assert.deepEqual([original.purpose, original.state, text.purpose, text.state], ['source_original', 'stored', 'source_text', 'stored']);
    return { sourceId: source.id, versionId: version.id, original, text, bytes };
  }

  test('a held source upload is encrypted then permanently deleted, never in the recycle bin, and a cleaned text file replaces the old one', async () => {
    const s = await storedSource();
    const textParent = (await connector.getItem(driveRoot(), s.text.item_id)).parentId;
    const caseId = await report('source', s.sourceId);
    // At once, before any storage work: both files are withheld, so nothing serves them, and the version shows withheld.
    assert.deepEqual((await rows(`SELECT state, withhold_case_id FROM stored_files WHERE id = ANY($1::uuid[]) ORDER BY purpose`, [[s.original.id, s.text.id]])).map((f) => [f.state, f.withhold_case_id]), [
      ['withheld', caseId], ['withheld', caseId],
    ]);
    assert.ok((await rows(`SELECT quarantined_at FROM source_versions WHERE id = $1`, [s.versionId]))[0].quarantined_at);

    const ran = await drain();
    assert.deepEqual(ran.filter((r) => r.job === 'withhold').map((r) => r.failed), [undefined, undefined]);
    // Both old items are gone: permanently, never by a plain delete to the recycle bin.
    for (const itemId of [s.original.item_id, s.text.item_id]) {
      assert.equal(await exists(itemId), false);
      assert.ok(permanentlyDeleted(itemId));
      assert.equal(recycled(itemId), false);
    }
    // Their content is kept encrypted under the case, and decrypts to exactly what was stored.
    const [o] = await contentOriginals(s.original.id);
    const [tx] = await contentOriginals(s.text.id);
    assert.equal(o.case_id, caseId);
    assert.deepEqual(key.decrypt(o), s.bytes);
    assert.match(key.decrypt(tx).toString('utf8'), new RegExp(SECRET));
    assert.equal(o.ciphertext.includes(Buffer.from(SECRET)), false);
    // The original stays withheld and removed; the text file is the cleaned text, uploaded where the old one was.
    const original = (await rows(`SELECT * FROM stored_files WHERE id = $1`, [s.original.id]))[0];
    assert.equal(original.state, 'withheld');
    assert.ok(original.removed_at);
    const text = (await rows(`SELECT * FROM stored_files WHERE id = $1`, [s.text.id]))[0];
    assert.equal(text.state, 'stored');
    assert.notEqual(text.item_id, s.text.item_id);
    assert.equal((await connector.getItem(driveRoot(), text.item_id)).parentId, textParent);
    const cleaned = (await download(text.item_id)).toString('utf8');
    assert.ok(!cleaned.includes(SECRET) && cleaned.includes('[credential removed]'));
    assert.equal(cleaned, (await rows(`SELECT text_content FROM source_versions WHERE id = $1`, [s.versionId]))[0].text_content);
    // Nothing is left in storage for the case; a download of the original is refused.
    assert.equal((await heldCase(caseId)).stillInStorage, null);
    const res = await c.pm.raw('GET', `/notes/${s.sourceId}/versions/1/original`);
    assert.notEqual(res.status, 200);
  });

  test('a held output file leaves the project folder first, then is encrypted and permanently deleted', async () => {
    const title = `Valve audit ${SECRET}`;
    const bytes = Buffer.from(`# ${title}\n\nThe vault code is ${SECRET}.\n`);
    const { out, file } = await filedOutput(title, bytes);
    const projectFolder = (await rows(`SELECT id, item_id FROM storage_folders WHERE level = 'project' AND key = $1`, [`${dept}/${project}`]))[0];
    assert.equal((await rows(`SELECT level FROM storage_folders WHERE id = $1`, [file.folder_id]))[0].level, 'report_type');
    assert.equal((await c.pm.request('POST', url(`/${out}/versions/1/approval`))).status, 201);

    const caseId = await report('output', out);
    // Hidden at once; its approval request ended.
    assert.equal((await c.ada.request('GET', url(`/${out}`))).status, 404);
    assert.equal((await rows(`SELECT status FROM change_requests WHERE kind = 'approve_output'`))[0].status, 'withdrawn');
    assert.equal((await fileRow(out)).state, 'withheld');

    const mark = fake.calls.length;
    await drain();
    const move = callIndex(mark, (x) => x.method === 'PATCH' && x.path.endsWith(`/items/${file.item_id}`));
    const read = callIndex(mark, (x) => x.method === 'GET' && x.path.endsWith(`/items/${file.item_id}/content`));
    const removed = callIndex(mark, (x) => x.method === 'POST' && x.path.endsWith(`/items/${file.item_id}/permanentDelete`));
    assert.ok(move >= 0 && read > move && removed > read, `moved (${move}), then read (${read}), then removed (${removed})`);
    // It went to the output's own folder, which has no grants, and was recorded there under its cleaned name.
    const of = (await rows(`SELECT id, item_id FROM storage_folders WHERE level = 'output' AND key = $1`, [`${dept}/${project}/output/${out}`]))[0];
    assert.ok(of);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_grants WHERE folder_id = $1 AND state <> 'revoked'`, [of.id]))[0].n, 0);
    const moves = await rows(`SELECT reason, new_path FROM stored_file_moves WHERE stored_file_id = $1`, [file.id]);
    assert.deepEqual(moves.map((m) => m.reason), ['Withheld']);
    assert.ok(!moves[0].new_path.includes(SECRET));
    // Then it is gone for good, its content kept encrypted.
    assert.equal(await exists(file.item_id), false);
    assert.equal(recycled(file.item_id), false);
    const [orig] = await contentOriginals(file.id);
    assert.deepEqual([orig.case_id, orig.item_kind, orig.item_id], [caseId, 'output', out]);
    assert.deepEqual(key.decrypt(orig), bytes);
    const f = await fileRow(out);
    assert.deepEqual([f.state, f.folder_id], ['withheld', of.id]);
    assert.ok(f.removed_at);
    // The project folder was never touched and keeps its readers.
    assert.ok(await exists(projectFolder.item_id));
  });

  test('removal failure keeps the item hidden, notifies Administrators without the secret and shows Still in storage', async () => {
    const { out, file } = await filedOutput(`Valve audit ${SECRET}`);
    fake.fault({ method: 'POST', pathIncludes: '/permanentDelete' }, '503', 1);
    const caseId = await report('output', out);
    const ran = await drain();
    assert.deepEqual(ran.filter((r) => r.job === 'withhold').map((r) => r.failed), ['server']);
    assert.deepEqual(logs, []);
    // Encrypted, moved out of the shared folder, but still in storage.
    assert.equal((await contentOriginals(file.id)).length, 1);
    assert.equal(await exists(file.item_id), true);
    // The last attempt fails: one notice to the Administrators and the storage Administrators, naming nothing secret.
    await onFinalFailure(deps(), 'withhold', file.id, 'server');
    await onFinalFailure(deps(), 'withhold', file.id, 'server');
    assert.deepEqual(logs, ['Withholding a held file did not finish; the daily task will try it again.', 'Withholding a held file did not finish; the daily task will try it again.']);
    const notices = await rows(`SELECT user_id, summary FROM notifications WHERE kind = 'held_file_not_removed' ORDER BY user_id`);
    assert.deepEqual(notices.map((n) => n.user_id).sort(), [ids.admin, ids.admin2, ids.store].sort());
    for (const n of notices) assert.equal(n.summary, HELD_FILE_NOT_REMOVED_TEXT);
    assert.equal(HELD_FILE_NOT_REMOVED_TEXT, 'A held file could not be removed from storage');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM notifications WHERE strpos(summary, $1) > 0`, [SECRET]))[0].n, 0);
    // Still hidden in Kainow; the case shows Still in storage to its reviewers and the Administrators.
    assert.equal((await c.ada.request('GET', url(`/${out}`))).status, 404);
    assert.deepEqual((await c.pm.request('GET', url())).body.outputs, []);
    assert.deepEqual((await heldCase(caseId)).stillInStorage, { label: STILL_IN_STORAGE, files: 1, links: 0 });
    assert.deepEqual((await adminCase(caseId)).stillInStorage, { label: 'Still in storage', files: 1, links: 0 });
    // Retries continue daily; once removal works the case no longer shows it.
    t.clock.advanceSeconds(25 * 3600);
    c.pm = await t.signIn('pm@example.org');
    await dailyWithholdTask(deps());
    await drain();
    assert.ok((await fileRow(out)).removed_at);
    assert.equal(await exists(file.item_id), false);
    assert.equal(recycled(file.item_id), false);
    assert.equal((await heldCase(caseId)).stillInStorage, null);
  });

  test('a version held while it uploads is never reported filed and ends withheld (CF6)', async () => {
    const title = `Valve audit ${SECRET}`;
    const bytes = Buffer.from(`# ${title}

The vault code is ${SECRET}.
`);
    const m = multipart({ title }, { name: 'report.md', bytes });
    const out = (await c.pm.upload('POST', url(), m.body, m.type)).body.id as string;
    assert.equal((await c.pm.request('POST', url(`/${out}/register`), { reportTypeId: await typeId('Status reports'), issueDate: '2026-11-09' })).status, 200);
    assert.equal((await c.pm.request('POST', url(`/${out}/versions/1/file`))).status, 200);
    let caseId = '';
    afterUpload = async () => {
      caseId = await report('output', out);
    };
    await drain();
    assert.ok(caseId, 'the output was held while its file uploaded');
    const f = await fileRow(out);
    assert.equal(f.state, 'withheld');
    assert.equal(f.withhold_case_id, caseId);
    assert.ok(f.removed_at, 'the upload was removed');
    assert.equal(await exists(f.item_id), false);
    assert.equal(recycled(f.item_id), false);
    assert.deepEqual(key.decrypt((await contentOriginals(f.id))[0]), bytes);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_events WHERE output_id = $1 AND kind = 'filed'`, [out]))[0].n, 0);
    assert.equal((await c.pm.request('GET', url(`/${out}`))).status, 404);
    // What was recorded at the confirm, and on the move out of the shared folder, came from the cleaned title.
    assert.match(f.name, /\[credential removed\] v1\.md$/);
    await noPlainCopy();
    assert.deepEqual((await driveNames()).filter((n) => n.includes(SECRET)), []);
  });

  test('a hold without the protected key moves the file out of the shared folder without naming anything after the title', async () => {
    const title = `Valve audit ${SECRET}`;
    const { out, file } = await filedOutput(title);
    assert.ok((await driveNames()).some((n) => n.includes(SECRET)), 'filed under its title');
    const cases = standaloneCases(t.pool, t.clock.now, false);
    const { caseId } = await cases.report({ id: ids.pm, email: 'pm@example.org', displayName: 'pm', role: 'member' } as never, {
      projectId: project, kind: 'output', id: out, marked: [SECRET], reason: 'Looks like the plant room vault code',
    });
    assert.equal((await fileRow(out)).state, 'withheld');
    const ran = await drain(false);
    assert.ok(ran.some((r) => r.job === 'withhold'));
    // Step 0 ran: the file left the project folder for the (restricted) root, under a name of ids; no folder was named
    // after the title; nothing else could be done without the key.
    const root = (await rows(`SELECT id, item_id FROM storage_folders WHERE level = 'restricted_root' AND key = $1`, [`${dept}/${project}/restricted`]))[0];
    assert.ok(root);
    const item = await connector.getItem(driveRoot(), file.item_id);
    assert.equal(item.parentId, root.item_id);
    assert.equal(item.name, `Withheld ${file.id}.md`);
    assert.deepEqual((await driveNames()).filter((n) => n.includes(SECRET)), []);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_folders WHERE level = 'output'`))[0].n, 0);
    assert.equal((await contentOriginals(file.id)).length, 0);
    assert.deepEqual((await heldCase(caseId)).stillInStorage, { label: STILL_IN_STORAGE, files: 1, links: 0 });
  });

  test('an output found as a place has its files withheld until decided: renamed in storage at once, back when dismissed, kept when confirmed', async () => {
    const reported = await filedOutput(`Valve audit ${SECRET}`);
    // Two other outputs carry the same text in their titles: one restricted (its own folder named after it), one project-wide.
    const m1 = multipart({ title: `Board pack ${SECRET}` }, { name: 'report.md', bytes: Buffer.from('# Board pack\n') });
    const y = (await c.pm.upload('POST', url(), m1.body, m1.type)).body.id as string;
    assert.equal((await c.pm.request('POST', url(`/${y}/register`), { reportTypeId: await typeId('Status reports'), issueDate: '2026-11-09', audience: { mode: 'restricted', namedUserIds: [ids.pm, ids.ada] } })).status, 200);
    assert.equal((await c.pm.request('POST', url(`/${y}/versions/1/file`))).status, 200);
    const z = await filedOutput(`Pump log ${SECRET}`);
    await drain();
    const yFile = await fileRow(y);
    // Removal fails for the restricted one, so its file stays in storage for a while: it is renamed there at once.
    fake.fault({ method: 'POST', pathIncludes: `${yFile.item_id}/permanentDelete` }, '503', 1);
    const caseId = await report('output', reported.out);
    assert.deepEqual((await rows(`SELECT state FROM stored_files WHERE id = ANY($1::uuid[]) ORDER BY id`, [[yFile.id, z.file.id]])).map((r) => r.state), ['withheld', 'withheld']);
    await drain();
    // Nothing in storage is named after the secret any more: the place's folder and its waiting file were renamed.
    assert.deepEqual((await driveNames()).filter((n) => n.includes(SECRET)), []);
    assert.equal(await exists(yFile.item_id), true);
    assert.match((await connector.getItem(driveRoot(), yFile.item_id)).name, /\[credential removed\]/);
    await noPlainCopy();
    // The PM dismisses one place and confirms the other.
    const decided = await c.pm.request('POST', `/quarantine/cases/${caseId}/copies`, {
      decisions: [{ kind: 'output', id: y, decision: 'dismissed' }, { kind: 'output', id: z.out, decision: 'confirmed' }],
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    await drain();
    const yNow = await fileRow(y);
    assert.equal(yNow.state, 'stored', 'the dismissed place has its file back');
    assert.equal(await exists(yNow.item_id), true);
    const zNow = await fileRow(z.out);
    assert.equal(zNow.state, 'withheld', 'the confirmed place keeps its file withheld');
    assert.ok(zNow.removed_at);
    assert.equal(await exists(z.file.item_id), false);
  });

  test('a file withheld by two cases comes back only when neither holds it', async () => {
    const OTHER = 'KX4LOCKER5521BETA';
    const bytes = Buffer.from(`Plant room notes.\nThe vault code is ${SECRET} and the locker code ${OTHER}.\n`);
    const { source, version } = await t.app.get(NotesService).createSource({
      projectId: project, content: { file: { originalname: 'Site notes.txt', buffer: bytes } }, actorUserId: ids.pm,
    });
    await storeSourceVersion(deps(), version.id);
    await drain();
    const [original, text] = await rows(
      `SELECT f.* FROM source_versions v JOIN stored_files f ON f.id IN (v.original_stored_file_id, v.text_stored_file_id) WHERE v.id = $1 ORDER BY f.purpose`,
      [version.id],
    );
    // Case A: the source itself. Its original and text are withheld; the text comes back cleaned.
    const a = await report('source', source.id);
    await drain();
    // Case B: a note repeating the other code finds the same source as a place, and holds its files too.
    const n = await c.pm.request('POST', `/projects/${project}/notes`, { title: 'Locker list', text: `The locker code is ${OTHER}.` });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    const r = await c.pm.request('POST', `/projects/${project}/secret-reports`, { kind: 'source', id: n.body.source.id, marked: [OTHER], reason: 'Another code' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.body.caseId as string;
    t.clock.advanceSeconds(1);
    await drain();
    const holders = async (fileId: string) =>
      (await rows(`SELECT case_id FROM stored_file_withholds WHERE stored_file_id = $1 AND release_requested_at IS NULL ORDER BY case_id`, [fileId])).map((x) => x.case_id);
    assert.deepEqual(await holders(original.id), [a, b].sort());
    // A is a false alarm: while B still holds them, nothing is put back.
    await releaseUnchanged(a);
    await drain();
    const o1 = (await rows(`SELECT * FROM stored_files WHERE id = $1`, [original.id]))[0];
    assert.equal(o1.state, 'withheld');
    assert.equal(o1.withhold_case_id, b);
    assert.ok(o1.removed_at);
    const t1 = (await rows(`SELECT * FROM stored_files WHERE id = $1`, [text.id]))[0];
    assert.ok(!(await download(t1.item_id)).toString('utf8').includes(OTHER), 'the text in storage is still cleaned of B');
    assert.ok((await rows(`SELECT quarantined_at FROM source_versions WHERE id = $1`, [version.id]))[0].quarantined_at, 'still shown withheld');
    // B is a false alarm too: now no case holds them, and they come back.
    const g = await c.rev.request('POST', '/security/grants', { caseIds: [b], purpose: 'Decide whether this is a live credential' });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    assert.equal((await c.admin2.request('POST', `/security/grants/${g.body.grantId}/decide`, { decision: 'approved', reason: 'Purpose is clear' })).status, 200);
    assert.equal((await c.rev.request('POST', `/security/cases/${b}/release-unchanged`, { reason: 'False alarm: a printed example code' })).status, 200);
    await drain();
    const o2 = (await rows(`SELECT * FROM stored_files WHERE id = $1`, [original.id]))[0];
    assert.equal(o2.state, 'stored');
    assert.deepEqual(await download(o2.item_id), bytes);
    const t2 = (await rows(`SELECT * FROM stored_files WHERE id = $1`, [text.id]))[0];
    assert.equal((await download(t2.item_id)).toString('utf8'), (await rows(`SELECT text_content FROM source_versions WHERE id = $1`, [version.id]))[0].text_content);
    assert.ok((await download(t2.item_id)).toString('utf8').includes(OTHER), 'B\u2019s text is back');
    assert.equal((await rows(`SELECT quarantined_at FROM source_versions WHERE id = $1`, [version.id]))[0].quarantined_at, null);
    assert.equal(await holders(original.id).then((h) => h.length), 0);
  });

  test('a release whose file cannot be put back keeps it withheld and attributed, still shown withheld, and tells the Administrators', async () => {
    const s = await storedSource();
    const caseId = await report('source', s.sourceId);
    await drain();
    await releaseUnchanged(caseId);
    // Released in the database, but the original's file is not back yet: still shown withheld. Then storage refuses it.
    assert.ok((await rows(`SELECT quarantined_at FROM source_versions WHERE id = $1`, [s.versionId]))[0].quarantined_at);
    fake.fault({ method: 'PUT', pathIncludes: 'original.txt' }, '403', 100);
    fake.fault({ method: 'POST', pathIncludes: 'original.txt' }, '403', 100);
    const ran = await drain();
    assert.ok(ran.some((r) => r.job === 'restore-withheld' && r.failed === 'forbidden'), JSON.stringify(ran));
    await onFinalFailure(deps(), 'restore-withheld', s.original.id, 'forbidden');
    const f = (await rows(`SELECT state FROM stored_files WHERE id = $1`, [s.original.id]))[0];
    assert.equal(f.state, 'withheld');
    assert.deepEqual((await rows(`SELECT case_id FROM stored_file_withholds WHERE stored_file_id = $1`, [s.original.id])).map((x) => x.case_id), [caseId]);
    assert.ok((await rows(`SELECT quarantined_at FROM source_versions WHERE id = $1`, [s.versionId]))[0].quarantined_at);
    const notices = await rows(`SELECT user_id, summary FROM notifications WHERE kind = 'held_file_not_restored' ORDER BY user_id`);
    assert.deepEqual(notices.map((x) => x.user_id).sort(), [ids.admin, ids.admin2, ids.store].sort());
    for (const x of notices) assert.equal(x.summary, 'A withheld file could not be put back in storage');
  });

  test('false-alarm release re-uploads the original to the same folder and re-syncs sharing', async () => {
    const title = `Valve audit ${SECRET}`;
    const bytes = Buffer.from(`# ${title}\n\nThe vault code is ${SECRET}.\n`);
    const { out, file } = await filedOutput(title, bytes);
    const typeFolder = (await connector.getItem(driveRoot(), file.item_id)).parentId;
    const projectFolder = (await rows(`SELECT id FROM storage_folders WHERE level = 'project' AND key = $1`, [`${dept}/${project}`]))[0];
    const caseId = await report('output', out);
    await drain();
    const withheld = await fileRow(out);
    assert.equal(withheld.state, 'withheld');
    const of = (await rows(`SELECT item_id FROM storage_folders WHERE level = 'output' AND key = $1`, [`${dept}/${project}/output/${out}`]))[0];
    assert.equal(withheld.upload_folder_id, of.item_id, 'it was withheld from its output folder');

    await releaseUnchanged(caseId);
    const mark = fake.calls.length;
    await drain();
    const f = await fileRow(out);
    assert.equal(f.state, 'stored');
    assert.equal(f.withhold_case_id, null);
    assert.notEqual(f.item_id, file.item_id);
    assert.deepEqual(await download(f.item_id), bytes, 'the original, exactly');
    assert.equal(f.sha256, file.sha256);
    // Uploaded back into the folder it was withheld from, then placed again where its readers need it.
    const upload = fake.calls.slice(mark).find((x) => (x.method === 'PUT' && x.path.endsWith('/content')) || x.path.endsWith('/createUploadSession'));
    assert.ok(upload?.path.includes(of.item_id), JSON.stringify(upload));
    assert.equal((await connector.getItem(driveRoot(), f.item_id)).parentId, typeFolder);
    assert.equal((await rows(`SELECT name FROM stored_files WHERE id = $1`, [f.id]))[0].name, `${title} v1.md`);
    assert.ok((await rows(`SELECT 1 FROM storage_grants g JOIN users u ON u.id = g.user_id WHERE g.folder_id = $1 AND u.email = 'ada@example.org' AND g.state = 'granted'`, [projectFolder.id])).length);
    assert.equal((await c.ada.request('GET', url(`/${out}`))).status, 200);
    assert.ok((await contentOriginals(f.id))[0].restored_at);
    assert.equal((await adminCase(caseId)).stillInStorage, null);
  });

  test('false-alarm release puts a source version original and text back where they were', async () => {
    const s = await storedSource();
    const folderOf = async (itemId: string) => (await connector.getItem(driveRoot(), itemId)).parentId;
    const versionFolder = await folderOf(s.original.item_id);
    const text = (await download(s.text.item_id)).toString('utf8');
    const caseId = await report('source', s.sourceId);
    await drain();
    await releaseUnchanged(caseId);
    await drain();
    const [original, textFile] = await rows(`SELECT * FROM stored_files WHERE id = ANY($1::uuid[]) ORDER BY purpose`, [[s.original.id, s.text.id]]);
    assert.deepEqual([original.state, original.withhold_case_id, textFile.state, textFile.withhold_case_id], ['stored', null, 'stored', null]);
    assert.deepEqual(await download(original.item_id), s.bytes);
    assert.equal(await folderOf(original.item_id), versionFolder);
    assert.equal((await download(textFile.item_id)).toString('utf8'), text);
    assert.equal(await folderOf(textFile.item_id), versionFolder);
    assert.equal((await rows(`SELECT quarantined_at FROM source_versions WHERE id = $1`, [s.versionId]))[0].quarantined_at, null);
    const res = await c.pm.raw('GET', `/notes/${s.sourceId}/versions/1/original`);
    assert.equal(res.status, 200);
    assert.equal(res.text, s.bytes.toString('utf8'));
    for (const f of [original, textFile]) assert.ok((await contentOriginals(f.id)).every((o) => o.restored_at));
  });

  test('a held link is hidden in Kainow, never deleted, and the notice goes to Administrators, storage Administrators and the PM', async () => {
    const plans = (await connector.createFolder({ ...driveRoot(), rootItemId: outputsRoot }, null, 'Plans')).itemId;
    const doc = await connector.upload({ ...driveRoot(), rootItemId: outputsRoot }, plans, 'Plan of works.docx', Buffer.from('plan of works'), { conflict: 'fail' });
    const sub = await c.pm.request('POST', url(), { kind: 'link', url: doc.webUrl, title: `Plan of works ${SECRET}` });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const out = sub.body.id as string;
    assert.equal((await c.pm.request('POST', url(`/${out}/register`), { reportTypeId: await typeId('Status reports'), issueDate: '2026-11-09' })).status, 200);
    const caseId = await report('output', out);
    await drain();
    // Hidden in Kainow, never touched in storage.
    assert.equal((await c.ada.request('GET', url(`/${out}`))).status, 404);
    assert.equal(await exists(doc.itemId), true);
    assert.ok(!fake.calls.some((x) => x.path.includes(doc.itemId) && (x.method === 'DELETE' || x.method === 'PATCH' || x.path.endsWith('/permanentDelete'))));
    assert.equal((await fileRow(out)).state, 'linked');
    // The notice, exactly, to the Administrators, the storage Administrator and the PM.
    const notices = await rows(`SELECT user_id, summary FROM notifications WHERE kind = 'held_link' ORDER BY user_id`);
    assert.deepEqual(notices.map((n) => n.user_id).sort(), [ids.admin, ids.admin2, ids.store, ids.pm].sort());
    for (const n of notices) {
      assert.equal(
        n.summary,
        `A document registered in ${PROJECT} may contain a credential. Kainow has hidden it, but the file is still in storage at its existing location and must be dealt with there.`,
      );
    }
    assert.deepEqual((await heldCase(caseId)).stillInStorage, { label: STILL_IN_STORAGE, files: 0, links: 1 });
  });

  test('quarantine originals for files carry no plain copy anywhere else', async () => {
    const title = `Valve audit ${SECRET}`;
    const { out } = await filedOutput(title, Buffer.from(`# ${title}\n\nThe vault code is ${SECRET}.\n`));
    const s = await storedSource();
    // One report: the source holding the same text is masked as a copy at once, its stored files withheld too.
    await report('output', out);
    await drain();
    // Every registered text column of the project, and the tables that carry no registered text.
    assert.deepEqual(await projectHolding(t.pool, project, SECRET), []);
    for (const table of ['stored_files', 'stored_file_moves', 'storage_folders', 'output_events', 'quarantine_events', 'audit_events', 'notifications', 'storage_attempts', 'storage_outbox']) {
      assert.equal((await rows(`SELECT count(*)::int AS n FROM ${table} x WHERE strpos(x::text, $1) > 0`, [SECRET]))[0].n, 0, table);
    }
    const secret = Buffer.from(SECRET);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_version_bytes WHERE position($1::bytea IN COALESCE(bytes, ''::bytea)) > 0`, [secret]))[0].n, 0);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM source_versions WHERE position($1::bytea IN COALESCE(original_bytes, ''::bytea)) > 0`, [secret]))[0].n, 0);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM quarantine_originals WHERE position($1::bytea IN ciphertext) > 0`, [secret]))[0].n, 0);
    // The files' content is there, encrypted: one per withheld file.
    assert.equal((await rows(`SELECT count(*)::int AS n FROM quarantine_originals WHERE table_name = 'stored_files' AND column_name = 'content'`))[0].n, 3);
  });
});
