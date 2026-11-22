import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { M365TokenSource } from '../email/m365-token';
import type { StorageConnectorFactory } from '../storage/connector-factory';
import { GraphConnector } from '../storage/connectors/graph';
import type { StorageDeps } from '../storage/jobs';
import { makeStorageNotify } from '../storage/notices';
import { type DestinationRef, StorageError } from '../storage/types';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { FILE_NOT_AS_FILED, NOT_CHECKED } from './approval-handler';
import {
  CHANGED_SINCE_APPROVAL, KAINOW_FILES, NOT_APPROVED_PLACE, NOT_CHANGED, NOT_FILED_BY_KAINOW, NOT_RECOVERED, REGISTER_FAILED, SHARED_FILE, checkOutputs,
  checkStoredFile, registerChangedContent,
} from './checks';
import { fileOutputVersion } from './filing';
import { LINKED_OPEN_ONLY } from './output-files.service';
import { placeOutput } from './sharing';
import { onFinalFailure } from '../storage/jobs';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = 'checksboundary42';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

describe('opening, checking and reconciling output files', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let fake: FakeGraph;
  let connector: GraphConnector;
  let drive: { driveId: string; rootItemId: string };
  /** The output destination: the "Outputs" folder of the drive, so other folders of the drive lie outside it. */
  let destId: string;
  let outputsRoot: string;
  let project: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  // Each destination as recorded: its own root folder.
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => {
      const r = (await t.pool.query(`SELECT drive_id, root_item_id FROM storage_destinations WHERE id = $1`, [id])).rows[0];
      if (!r) throw new StorageError('invalid');
      return { connector, dest: { id, connector: 'graph', driveId: r.drive_id, rootItemId: r.root_item_id } };
    },
    forNew: async () => connector,
  };
  const driveRoot = (): DestinationRef => ({ id: 'drive', connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId });
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now) });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const typeId = async (name: string) => (await rows(`SELECT id FROM report_types WHERE name = $1`, [name]))[0].id as string;
  const url = (p = '') => `/projects/${project}/outputs${p}`;
  const vUrl = (outputId: string, n: number, what: string) => url(`/${outputId}/versions/${n}/${what}`);

  async function destination(label: string, rootItemId: string, status = 'approved'): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'graph', 'sharepoint_library', 'outputs', $2, $3, $4, $5, $6, now())`,
      [id, label, drive.driveId, rootItemId, status, ids.admin],
    );
    return id;
  }
  async function registered(title: string, opts: { restrictTo?: string[]; bytes?: Buffer } = {}): Promise<string> {
    const m = multipart({ title }, { name: 'report.md', bytes: opts.bytes ?? Buffer.from(`# ${title}\n\nThe valve audit is on Friday.\n`) });
    const sub = await c.pm.upload('POST', url(), m.body, m.type);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const body: Record<string, unknown> = { reportTypeId: await typeId('Status reports'), issueDate: '2026-11-09' };
    if (opts.restrictTo) body.audience = { mode: 'restricted', namedUserIds: opts.restrictTo };
    const reg = await c.pm.request('POST', url(`/${sub.body.id}/register`), body);
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    return sub.body.id;
  }
  const versionId = async (outputId: string, n = 1) =>
    (await rows(`SELECT id FROM output_versions WHERE output_id = $1 AND version_no = $2`, [outputId, n]))[0].id as string;
  const fileRow = async (outputId: string, n = 1) =>
    (await rows(`SELECT f.* FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id WHERE v.output_id = $1 AND v.version_no = $2`, [outputId, n]))[0];
  async function fileNow(outputId: string, n = 1): Promise<Record<string, any>> {
    const r = await c.pm.request('POST', vUrl(outputId, n, 'file'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await fileOutputVersion(deps(), await versionId(outputId, n));
    const f = await fileRow(outputId, n);
    assert.equal(f.state, 'stored');
    return f;
  }
  /** A registered output with version 1 filed, and the clock moved on past the one-minute check window. */
  async function filedOutput(title: string, opts: { restrictTo?: string[]; bytes?: Buffer } = {}): Promise<{ out: string; file: Record<string, any> }> {
    const out = await registered(title, opts);
    const file = await fileNow(out);
    t.clock.advanceMinutes(2);
    return { out, file };
  }
  const version = async (who: Client, outputId: string, n = 1) => {
    const r = await who.request('GET', url(`/${outputId}`));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.versions.find((v: { no: number }) => v.no === n);
  };
  const itemReads = (itemId: string) => fake.calls.filter((x) => x.method === 'GET' && x.path.endsWith(`/drives/${drive.driveId}/items/${itemId}`)).length;
  const events = async (outputId: string, kind: string) =>
    (await rows(`SELECT count(*)::int AS n FROM output_events WHERE output_id = $1 AND kind = $2`, [outputId, kind]))[0].n as number;
  /** The PM or a Deputy asks; the request is answered 202 with the job queued. */
  async function askToRegister(who: Client, outputId: string, n = 1): Promise<Record<string, any>> {
    const r = await who.request('POST', vUrl(outputId, n, 'register-changed'));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const vid = await versionId(outputId, n);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox WHERE job = 'register-changed' AND subject_id = $1`, [vid]))[0].n >= 1, true);
    return r.body;
  }
  /** Runs the register-changed job once. */
  const runRegister = async (outputId: string, n = 1) => registerChangedContent(deps(), await versionId(outputId, n));
  const notices = async (kind: string) => (await rows(`SELECT user_id, summary FROM notifications WHERE kind = $1 ORDER BY user_id`, [kind]));

  beforeEach(async () => {
    fake = await startFakeGraph();
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    connector = new GraphConnector(tokens, { fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: true, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
    drive = fake.addDrive();
    t = await startTestApp(undefined, { storageConnectors: factory });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'ada', 'eve']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    const dept = await seedDepartment(t.pool, 'Water Services');
    project = await seedProject(t.pool, {
      status: 'active',
      name: 'Pump station renewal',
      departmentId: dept,
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    outputsRoot = (await connector.createFolder(driveRoot(), null, 'Outputs')).itemId;
    destId = await destination('Outputs library', outputsRoot);
    await t.pool.query(`INSERT INTO project_output_settings (project_id, destination_id) VALUES ($1, $2)`, [project, destId]);
    for (const k of Object.keys(ids)) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  test('open checks then redirects with 303 for a reader; 404 for a non-reader', async () => {
    const { out, file } = await filedOutput('Weekly status');
    const before = itemReads(file.item_id);
    const r = await c.ada.raw('GET', vUrl(out, 1, 'open'));
    assert.equal(r.status, 303, r.text);
    assert.equal(itemReads(file.item_id), before + 1, 'one check by Kainow');
    assert.equal(r.headers.get('location'), (await connector.getItem(driveRoot(), file.item_id)).webUrl);
    const f = await fileRow(out);
    assert.equal(f.check_status, 'ok');
    assert.equal(new Date(f.last_checked_at).getTime(), t.clock.ms);
    // Someone outside the project, and someone outside a Restricted audience, are told nothing.
    assert.equal((await c.eve.raw('GET', vUrl(out, 1, 'open'))).status, 404);
    const restricted = await filedOutput('Board briefing', { restrictTo: [ids.pm, ids.deputy] });
    assert.equal((await c.ada.raw('GET', vUrl(restricted.out, 1, 'open'))).status, 404);
    assert.equal((await c.pm.raw('GET', vUrl(restricted.out, 1, 'open'))).status, 303);
    // A version with no file has nothing to open.
    const unfiled = await registered('Not filed yet');
    const none = await c.pm.request('GET', vUrl(unfiled, 1, 'open'));
    assert.equal(none.status, 409);
    assert.equal(none.body.state, 'not_filed');
  });

  test('a second open within a minute does not call the provider again', async () => {
    const { out, file } = await filedOutput('Weekly status');
    assert.equal((await c.ada.raw('GET', vUrl(out, 1, 'open'))).status, 303);
    const once = itemReads(file.item_id);
    t.clock.advanceSeconds(30);
    assert.equal((await c.pm.raw('GET', vUrl(out, 1, 'open'))).status, 303);
    assert.equal(itemReads(file.item_id), once, 'no second provider call within the minute');
    t.clock.advanceSeconds(31);
    assert.equal((await c.pm.raw('GET', vUrl(out, 1, 'open'))).status, 303);
    assert.equal(itemReads(file.item_id), once + 1, 'checked again after a minute');
  });

  test('open shows Changed, Missing or Access denied instead of redirecting', async () => {
    const changed = await filedOutput('Weekly status');
    fake.changeContent(drive.driveId, changed.file.item_id, Buffer.from('Someone edited this in SharePoint.'));
    const r = await c.pm.request('GET', vUrl(changed.out, 1, 'open'));
    assert.equal(r.status, 409);
    assert.equal(r.body.state, 'changed');
    assert.equal(r.body.label, 'Changed');
    assert.deepEqual(r.body.actions, ['register_changed']);
    const seen = await c.ada.request('GET', vUrl(changed.out, 1, 'open'));
    assert.equal(seen.status, 409);
    assert.deepEqual(seen.body.actions, [], 'what the PM can do is offered to the PM and Deputies');
    // Opened again within the minute: answered from the recorded result, without the provider.
    const reads = itemReads(changed.file.item_id);
    assert.equal((await c.pm.request('GET', vUrl(changed.out, 1, 'open'))).body.state, 'changed');
    assert.equal(itemReads(changed.file.item_id), reads, 'no provider call within the minute');
    // Found once: one event and one notice each for the PM and the Deputy, however often it is opened.
    t.clock.advanceMinutes(2);
    assert.equal((await c.pm.request('GET', vUrl(changed.out, 1, 'open'))).status, 409);
    assert.equal(await events(changed.out, 'changed_found'), 1);
    const told = await notices('output_file_changed');
    assert.deepEqual(told.map((n) => n.user_id).sort(), [ids.pm, ids.deputy].sort());
    assert.match(told[0].summary, /^The file of output "Weekly status" in Pump station renewal has changed in storage/);

    const missing = await filedOutput('Monthly status');
    fake.deleteItem(drive.driveId, missing.file.item_id);
    const m = await c.pm.request('GET', vUrl(missing.out, 1, 'open'));
    assert.equal(m.status, 409);
    assert.deepEqual([m.body.state, m.body.label], ['missing', 'Missing']);
    assert.deepEqual(m.body.actions, ['relink', 'add_version']);
    assert.equal(await events(missing.out, 'missing_found'), 1);
    assert.equal((await notices('output_file_missing')).length, 2);

    const denied = await filedOutput('Risk summary');
    await t.pool.query(`UPDATE storage_destinations SET status = 'withdrawn' WHERE id = $1`, [destId]);
    const d = await c.ada.request('GET', vUrl(denied.out, 1, 'open'));
    assert.equal(d.status, 409);
    assert.deepEqual([d.body.state, d.body.label], ['access_denied', 'Access denied']);
    assert.equal((await fileRow(denied.out)).check_status, 'access_denied');
    // A provider refusal reads the same way.
    await t.pool.query(`UPDATE storage_destinations SET status = 'approved' WHERE id = $1`, [destId]);
    t.clock.advanceMinutes(2);
    fake.fault({ method: 'GET', pathIncludes: denied.file.item_id }, '403', 1);
    assert.equal((await c.ada.request('GET', vUrl(denied.out, 1, 'open'))).body.state, 'access_denied');
    // The register shows the same states.
    assert.equal((await version(c.pm, missing.out)).filing.checkLabel, 'Missing');
  });

  test('daily check runs only with scheduled checks on, oldest first, at most 2,000', async () => {
    const a = await filedOutput('Alpha');
    const b = await filedOutput('Bravo');
    const cc = await filedOutput('Charlie');
    // Bravo was never checked, Charlie checked longest ago, Alpha most recently.
    const daysAgo = (n: number) => new Date(t.clock.ms - n * 86_400_000);
    await t.pool.query(`UPDATE stored_files SET last_checked_at = NULL WHERE id = $1`, [b.file.id]);
    await t.pool.query(`UPDATE stored_files SET last_checked_at = $2 WHERE id = $1`, [cc.file.id, daysAgo(3)]);
    await t.pool.query(`UPDATE stored_files SET last_checked_at = $2 WHERE id = $1`, [a.file.id, daysAgo(1)]);
    const reads = () => itemReads(a.file.item_id) + itemReads(b.file.item_id) + itemReads(cc.file.item_id);
    const before = reads();
    assert.deepEqual(await checkOutputs(deps(), t.clock.now()), { checked: 0, flagged: 0 }, 'scheduled checks are off by default');
    assert.equal(reads(), before);

    await t.pool.query(`UPDATE storage_settings SET scheduled_checks = true`);
    fake.changeContent(drive.driveId, cc.file.item_id, Buffer.from('Edited outside Kainow.'));
    const run = await checkOutputs(deps(), t.clock.now(), 2);
    assert.deepEqual(run, { checked: 2, flagged: 1 });
    const at = t.clock.ms;
    const stamped = async (o: string) => {
      const f = await fileRow(o);
      return f.last_checked_at ? new Date(f.last_checked_at).getTime() === at : false;
    };
    assert.deepEqual([await stamped(b.out), await stamped(cc.out), await stamped(a.out)], [true, true, false], 'never checked, then oldest; Alpha waits');
    assert.equal((await fileRow(cc.out)).check_status, 'changed');
    // The next run starts with Alpha, now the oldest.
    t.clock.advanceMinutes(1);
    assert.deepEqual(await checkOutputs(deps(), t.clock.now(), 1), { checked: 1, flagged: 0 });
    assert.equal(new Date((await fileRow(a.out)).last_checked_at).getTime(), t.clock.ms);
    // With the default limit (2,000) one run reaches every file; Charlie stays Changed and is not flagged again.
    t.clock.advanceMinutes(1);
    assert.deepEqual(await checkOutputs(deps(), t.clock.now()), { checked: 3, flagged: 0 });
    assert.equal(await events(cc.out, 'changed_found'), 1);
  });

  test('changed approved version stays Approved as a record, shows the label and blocks approval requests', async () => {
    const { out, file } = await filedOutput('Weekly status');
    await t.pool.query(`UPDATE output_versions SET status = 'approved' WHERE output_id = $1 AND version_no = 1`, [out]);
    const m = multipart({}, { name: 'report.md', bytes: Buffer.from('# Weekly status\n\nVersion two.\n') });
    assert.equal((await c.pm.upload('POST', url(`/${out}/versions`), m.body, m.type)).status, 201);
    const second = await fileNow(out, 2);
    fake.changeContent(drive.driveId, file.item_id, Buffer.from('Edited after approval.'));
    fake.changeContent(drive.driveId, second.item_id, Buffer.from('Edited before approval.'));
    assert.equal(await checkStoredFile(deps(), file.id), 'changed');
    assert.equal(await checkStoredFile(deps(), second.id), 'changed');
    const v1 = await version(c.ada, out, 1);
    assert.equal(v1.status, 'approved', 'kept as a record');
    assert.equal(v1.filing.checkStatus, 'changed');
    assert.equal(v1.filing.checkLabel, 'File changed since approval — this is not the approved content');
    assert.equal(CHANGED_SINCE_APPROVAL, v1.filing.checkLabel);
    assert.equal((await version(c.ada, out, 2)).filing.checkLabel, 'Changed');
    const ask = await c.pm.request('POST', vUrl(out, 2, 'approval'));
    assert.equal(ask.status, 409);
    assert.equal(ask.body.message, FILE_NOT_AS_FILED);
  });

  test('register-changed makes a separate file and restores the original from version history', async () => {
    const original = Buffer.from('# Weekly status\n\nThe valve audit is on Friday.\n');
    const { out, file } = await filedOutput('Weekly status', { bytes: original });
    await t.pool.query(`UPDATE output_versions SET status = 'approved' WHERE output_id = $1 AND version_no = 1`, [out]);
    const edited = Buffer.from('# Weekly status\n\nThe valve audit moved to Monday.\n');
    fake.changeContent(drive.driveId, file.item_id, edited);
    assert.equal(await checkStoredFile(deps(), file.id), 'changed');
    assert.equal((await c.ada.request('POST', vUrl(out, 1, 'register-changed'))).status, 403, 'the PM or a Deputy only');

    const asked = await askToRegister(c.deputy, out);
    assert.equal(asked.versions.length, 1, 'nothing is made until the job runs');
    assert.equal(asked.versions[0].filing.registering, 'Registering the changed file as a new version');
    assert.deepEqual(asked.versions[0].filing.actions, [], 'not offered again while under way');
    assert.equal((await c.pm.request('POST', vUrl(out, 1, 'register-changed'))).status, 409, 'one request at a time');
    await runRegister(out);
    const r = await c.pm.request('GET', url(`/${out}`));
    const v2 = r.body.versions.find((v: { no: number }) => v.no === 2);
    assert.deepEqual([v2.origin, v2.status, v2.filing.state], ['changed_file', 'draft', 'stored']);
    const f2 = await fileRow(out, 2);
    assert.equal(f2.name, 'Weekly status v2.md');
    assert.equal(f2.path, 'Water Services/Pump station renewal/2026/Status reports/Weekly status v2.md');
    assert.notEqual(f2.item_id, file.item_id);
    assert.ok((await connector.download(driveRoot(), f2.item_id)).equals(edited), 'the changed content is the new file');
    assert.equal((await connector.getItem(driveRoot(), f2.item_id)).parentId, (await connector.getItem(driveRoot(), file.item_id)).parentId, 'in the output’s folder');
    assert.equal((await rows(`SELECT created_by FROM output_versions WHERE output_id = $1 AND version_no = 2`, [out]))[0].created_by, ids.deputy);
    // The original is restored from the provider's history and Checked again; still Approved.
    assert.ok((await connector.download(driveRoot(), file.item_id)).equals(original));
    const v1 = r.body.versions.find((v: { no: number }) => v.no === 1);
    assert.deepEqual([v1.status, v1.filing.checkStatus, v1.filing.checkLabel, v1.filing.recovery], ['approved', 'ok', 'Checked', undefined]);
    assert.equal(await events(out, 'changed_registered'), 1);
    // Nothing is left to register, and running the job again does nothing.
    const again = await c.pm.request('POST', vUrl(out, 1, 'register-changed'));
    assert.equal(again.status, 409);
    await runRegister(out);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_versions WHERE output_id = $1`, [out]))[0].n, 2);
  });

  test('register-changed is retried by the job, and after its last attempt the PM may ask again', async () => {
    const { out, file } = await filedOutput('Weekly status');
    fake.changeContent(drive.driveId, file.item_id, Buffer.from('Rewritten outside Kainow.'));
    await checkStoredFile(deps(), file.id);
    await askToRegister(c.pm, out);
    fake.fault({ method: 'GET', pathIncludes: `${file.item_id}/content` }, '503', 1);
    await assert.rejects(runRegister(out), (e: unknown) => e instanceof StorageError);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_versions WHERE output_id = $1`, [out]))[0].n, 1);
    await onFinalFailure(deps(), 'register-changed', await versionId(out), 'throttled');
    const v1 = await version(c.pm, out);
    assert.equal(v1.filing.registerFailed, REGISTER_FAILED);
    assert.deepEqual(v1.filing.actions, ['register_changed']);
    await askToRegister(c.pm, out);
    await runRegister(out);
    assert.equal((await version(c.pm, out, 2)).origin, 'changed_file');
  });

  test('a filed file edited and moved is Missing outside approved places; inside one its new version goes to the output’s own folder', async () => {
    const outside = await filedOutput('Weekly status');
    const elsewhere = (await connector.createFolder(driveRoot(), null, 'Elsewhere')).itemId;
    fake.changeContent(drive.driveId, outside.file.item_id, Buffer.from('Edited and taken away.'));
    fake.moveItem(drive.driveId, outside.file.item_id, elsewhere);
    assert.equal(await checkStoredFile(deps(), outside.file.id), 'missing');
    const refused = await c.pm.request('POST', vUrl(outside.out, 1, 'register-changed'));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, NOT_CHANGED);
    assert.equal(await connector.findChild(driveRoot(), elsewhere, 'Weekly status v2.md'), null, 'nothing put in an unapproved place');

    const inside = await filedOutput('Monthly status');
    const archive = (await connector.createFolder({ ...driveRoot(), rootItemId: outputsRoot }, null, 'Archive')).itemId;
    fake.changeContent(drive.driveId, inside.file.item_id, Buffer.from('Edited and archived.'));
    fake.moveItem(drive.driveId, inside.file.item_id, archive);
    assert.equal(await checkStoredFile(deps(), inside.file.id), 'changed');
    await askToRegister(c.pm, inside.out);
    await runRegister(inside.out);
    const f2 = await fileRow(inside.out, 2);
    assert.equal(f2.path, 'Water Services/Pump station renewal/2026/Status reports/Monthly status v2.md');
    assert.equal(f2.folder_id, inside.file.folder_id);
    assert.equal(await connector.findChild({ ...driveRoot(), rootItemId: outputsRoot }, archive, 'Monthly status v2.md'), null, 'never next to the moved original');
  });

  test('when no matching version exists the original stays Changed with the exact text', async () => {
    const { out, file } = await filedOutput('Weekly status');
    fake.changeContent(drive.driveId, file.item_id, Buffer.from('Rewritten outside Kainow.'));
    assert.equal(await checkStoredFile(deps(), file.id), 'changed');
    const real = connector.listVersions.bind(connector);
    connector.listVersions = async () => []; // the history no longer holds the recorded content
    try {
      await askToRegister(c.pm, out);
      await runRegister(out);
    } finally {
      connector.listVersions = real;
    }
    const v1 = await version(c.pm, out, 1);
    assert.equal(v1.filing.checkStatus, 'changed');
    assert.equal(v1.filing.recovery, 'The approved content could not be recovered from storage');
    assert.equal(NOT_RECOVERED, v1.filing.recovery);
    assert.equal((await version(c.pm, out, 2)).origin, 'changed_file');
    // Registered once: asking again does not make another version.
    assert.equal((await c.pm.request('POST', vUrl(out, 1, 'register-changed'))).status, 409);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_versions WHERE output_id = $1`, [out]))[0].n, 2);
  });

  test('two versions never share a stored file', async () => {
    const { out, file } = await filedOutput('Weekly status');
    fake.changeContent(drive.driveId, file.item_id, Buffer.from('Rewritten outside Kainow.'));
    await checkStoredFile(deps(), file.id);
    await askToRegister(c.pm, out);
    await runRegister(out);
    const f1 = await fileRow(out, 1);
    const f2 = await fileRow(out, 2);
    assert.notEqual(f1.id, f2.id);
    assert.notEqual(f1.item_id, f2.item_id);
    // Relinking version 2 to version 1's file is refused, whatever the file holds.
    await t.pool.query(`UPDATE stored_files SET check_status = 'missing' WHERE id = $1`, [f2.id]);
    const r = await c.pm.request('POST', vUrl(out, 2, 'relink'), { url: (await connector.getItem(driveRoot(), f1.item_id)).webUrl });
    assert.equal(r.status, 409);
    assert.equal(r.body.message, SHARED_FILE);
    assert.equal((await fileRow(out, 2)).item_id, f2.item_id);
  });

  test('moved within an approved destination is relinked by PM or Deputy with old and new recorded', async () => {
    const { out, file } = await filedOutput('Weekly status');
    const archive = (await connector.createFolder({ ...driveRoot(), rootItemId: outputsRoot }, null, 'Archive')).itemId;
    fake.moveItem(drive.driveId, file.item_id, archive, 'Weekly status (old).md');
    // Opening a moved file still takes the reader to it, also when opened again within the minute (no provider call).
    const before = itemReads(file.item_id);
    const open = await c.ada.raw('GET', vUrl(out, 1, 'open'));
    t.clock.advanceSeconds(20);
    const reopen = await c.pm.raw('GET', vUrl(out, 1, 'open'));
    assert.equal(itemReads(file.item_id), before + 1, 'one provider call for both opens');
    const current = (await connector.getItem(driveRoot(), file.item_id)).webUrl;
    assert.notEqual(current, file.web_url);
    assert.deepEqual([open.status, open.headers.get('location')], [303, current]);
    assert.deepEqual([reopen.status, reopen.headers.get('location')], [303, current]);
    assert.equal((await fileRow(out)).path, file.path, 'the recorded place waits for a relink');
    assert.equal((await fileRow(out)).check_status, 'moved');
    assert.equal(await events(out, 'moved_found'), 1);
    assert.equal((await notices('output_file_moved')).length, 2);
    assert.deepEqual((await version(c.pm, out)).filing.actions, ['relink']);

    assert.equal((await c.ada.request('POST', vUrl(out, 1, 'relink'), {})).status, 403);
    const r = await c.deputy.request('POST', vUrl(out, 1, 'relink'), {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = await fileRow(out);
    // Kainow's own file keeps the name Kainow gave it: renamed back where it now is, and that name recorded (never the provider's).
    assert.deepEqual([f.path, f.name, f.check_status, f.item_id, f.destination_id], ['Archive/Weekly status v1.md', 'Weekly status v1.md', 'ok', file.item_id, destId]);
    assert.equal((await connector.getItem(driveRoot(), file.item_id)).name, 'Weekly status v1.md');
    const moves = await rows(`SELECT * FROM stored_file_moves WHERE stored_file_id = $1`, [file.id]);
    assert.equal(moves.length, 1);
    assert.deepEqual([moves[0].old_path, moves[0].new_path, moves[0].actor_id], [file.path, 'Archive/Weekly status v1.md', ids.deputy]);
    assert.equal(await events(out, 'relinked'), 1);
    assert.equal((await c.pm.request('GET', url(`/${out}`))).body.versions[0].filing.path, 'Archive/Weekly status v1.md');
    // A file where Kainow recorded it has nothing to relink, nor has a changed one.
    assert.equal((await c.pm.request('POST', vUrl(out, 1, 'relink'), {})).status, 409);
    fake.changeContent(drive.driveId, file.item_id, Buffer.from('Edited.'));
    assert.equal(await checkStoredFile(deps(), file.id), 'changed');
    assert.equal((await c.pm.request('POST', vUrl(out, 1, 'relink'), {})).status, 409);
  });

  test('a file relinked inside the project tree still moves out of it when its readers narrow', async () => {
    const { out, file } = await filedOutput('Weekly status');
    const projectFolder = (await rows(`SELECT item_id FROM storage_folders WHERE level = 'project'`))[0].item_id as string;
    const loose = (await connector.createFolder({ ...driveRoot(), rootItemId: outputsRoot }, projectFolder, 'Loose papers')).itemId;
    fake.moveItem(drive.driveId, file.item_id, loose);
    assert.equal(await checkStoredFile(deps(), file.id), 'moved');
    assert.equal((await c.pm.request('POST', vUrl(out, 1, 'relink'), {})).status, 200);
    const relinked = await fileRow(out);
    assert.deepEqual([relinked.path, relinked.folder_id], ['Water Services/Pump station renewal/Loose papers/Weekly status v1.md', null]);
    const narrowed = await c.pm.request('PUT', url(`/${out}/audience`), { mode: 'restricted', userIds: [ids.pm, ids.deputy], reason: 'Board only' });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    await placeOutput(deps(), out);
    const f = await fileRow(out);
    assert.equal(f.path, 'Water Services/Pump station renewal (restricted)/Weekly status/Weekly status v1.md');
    assert.notEqual(f.folder_id, null);
  });

  test('moved outside approved destinations shows Missing or Access denied and is relinkable only after the place is approved as a destination', async () => {
    const { out, file } = await filedOutput('Weekly status');
    const elsewhere = (await connector.createFolder(driveRoot(), null, 'Elsewhere')).itemId;
    fake.moveItem(drive.driveId, file.item_id, elsewhere);
    assert.equal(await checkStoredFile(deps(), file.id), 'missing');
    assert.equal(await events(out, 'missing_found'), 1);
    const refused = await c.pm.request('POST', vUrl(out, 1, 'relink'), {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, NOT_APPROVED_PLACE);
    // A link to it is refused the same way.
    const byLink = await c.pm.request('POST', vUrl(out, 1, 'relink'), { url: (await connector.getItem(driveRoot(), file.item_id)).webUrl });
    assert.equal(byLink.body.message, NOT_APPROVED_PLACE);
    // An Enterprise Administrator approves that place as a destination: now it is Moved, and relinked.
    const other = await destination('Elsewhere library', elsewhere);
    assert.equal(await checkStoredFile(deps(), file.id), 'moved');
    const r = await c.pm.request('POST', vUrl(out, 1, 'relink'), {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = await fileRow(out);
    assert.deepEqual([f.destination_id, f.path, f.check_status, f.folder_id], [other, 'Weekly status v1.md', 'ok', null]);
    assert.equal(r.body.versions[0].filing.destination, 'Elsewhere library', 'labelled with its destination');
    // Once that destination is withdrawn the file reads as Access denied.
    await t.pool.query(`UPDATE storage_destinations SET status = 'withdrawn' WHERE id = $1`, [other]);
    assert.equal(await checkStoredFile(deps(), file.id), 'access_denied');
  });

  test('registered links are checked when their document is in an approved destination', async () => {
    const plans = (await connector.createFolder({ ...driveRoot(), rootItemId: outputsRoot }, null, 'Plans')).itemId;
    const doc = await connector.upload({ ...driveRoot(), rootItemId: outputsRoot }, plans, 'Plan of works.docx', Buffer.from('plan of works'), { conflict: 'fail' });
    const sub = await c.pm.request('POST', url(), { kind: 'link', url: doc.webUrl, title: 'Plan of works' });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const out = sub.body.id as string;
    assert.equal((await c.pm.request('POST', url(`/${out}/register`), { reportTypeId: await typeId('Status reports'), issueDate: '2026-11-09' })).status, 200);
    assert.equal((await c.pm.request('POST', vUrl(out, 1, 'approval'))).body.message, NOT_CHECKED);
    const open = await c.ada.raw('GET', vUrl(out, 1, 'open'));
    assert.equal(open.status, 303);
    assert.equal(open.headers.get('location'), doc.webUrl);
    assert.equal((await fileRow(out)).check_status, 'ok');
    assert.equal((await version(c.pm, out)).filing.checkLabel, 'Checked');
    assert.equal((await c.pm.request('POST', vUrl(out, 1, 'approval'))).status, 201, 'a checked link can be put for approval');
    // A changed linked document is found changed.
    const f = await fileRow(out);
    fake.changeContent(drive.driveId, doc.itemId, Buffer.from('plan of works, revised'));
    assert.equal(await checkStoredFile(deps(), f.id), 'changed');
    // Kainow never touches a linked document: no new file next to it, no restoring its history.
    assert.deepEqual((await version(c.pm, out)).filing.actions, []);
    const register = await c.pm.request('POST', vUrl(out, 1, 'register-changed'));
    assert.equal(register.status, 409);
    assert.equal(register.body.message, NOT_FILED_BY_KAINOW);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox WHERE job = 'register-changed'`))[0].n, 0);
    // Its destination withdrawn: Access denied, without asking the provider.
    await t.pool.query(`UPDATE storage_destinations SET status = 'withdrawn' WHERE id = $1`, [destId]);
    const before = itemReads(doc.itemId);
    assert.equal(await checkStoredFile(deps(), f.id), 'access_denied');
    assert.equal(itemReads(doc.itemId), before);
  });

  test('a link to a file Kainow filed, or to anything in Kainow’s folders, is refused, also when relinking a linked document', async () => {
    // Another project's restricted output, filed by Kainow; Ada is not in that project.
    const otherDept = await seedDepartment(t.pool, 'Treasury');
    const other = await seedProject(t.pool, {
      status: 'active', name: 'Board pay review', departmentId: otherDept, members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.deputy, role: 'deputy_pm' }],
    });
    await t.pool.query(`INSERT INTO project_output_settings (project_id, destination_id) VALUES ($1, $2)`, [other, destId]);
    const home = project;
    project = other;
    const secret = await filedOutput('Pay review', { restrictTo: [ids.pm, ids.deputy] });
    project = home;
    const refusedLink = async (link: string) => {
      const r = await c.ada.request('POST', url(), { kind: 'link', url: link, title: 'Linked plan' });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.message, KAINOW_FILES);
    };
    await refusedLink(secret.file.web_url);
    // A document someone else put into one of Kainow's folders (the other project's restricted root) is refused too.
    const restrictedRoot = (await rows(`SELECT item_id FROM storage_folders WHERE level = 'restricted_root'`))[0].item_id as string;
    const dropped = await connector.upload({ ...driveRoot(), rootItemId: outputsRoot }, restrictedRoot, 'Notes.docx', Buffer.from('notes'), { conflict: 'fail' });
    await refusedLink(dropped.webUrl as string);
    // A file Kainow filed that someone moved out of Kainow's folders still stands for its output version.
    const moved = await filedOutput('Weekly status');
    const loose = (await connector.createFolder({ ...driveRoot(), rootItemId: outputsRoot }, null, 'Loose')).itemId;
    fake.moveItem(drive.driveId, moved.file.item_id, loose);
    await refusedLink((await connector.getItem(driveRoot(), moved.file.item_id)).webUrl as string);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files WHERE state = 'linked'`))[0].n, 0, 'nothing registered');

    // A linked document moved into one of Kainow's folders cannot be relinked there, by its id or by a link.
    const plans = (await connector.createFolder({ ...driveRoot(), rootItemId: outputsRoot }, null, 'Plans')).itemId;
    const doc = await connector.upload({ ...driveRoot(), rootItemId: outputsRoot }, plans, 'Plan of works.docx', Buffer.from('plan of works'), { conflict: 'fail' });
    const sub = await c.pm.request('POST', url(), { kind: 'link', url: doc.webUrl, title: 'Plan of works' });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    fake.moveItem(drive.driveId, doc.itemId, restrictedRoot);
    const linked = await fileRow(sub.body.id);
    assert.equal(await checkStoredFile(deps(), linked.id), 'moved');
    for (const body of [{}, { url: (await connector.getItem(driveRoot(), doc.itemId)).webUrl }]) {
      const r = await c.pm.request('POST', vUrl(sub.body.id, 1, 'relink'), body);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.message, KAINOW_FILES);
    }
    assert.equal((await fileRow(sub.body.id)).item_id, doc.itemId);
    assert.equal((await fileRow(sub.body.id)).path, linked.path, 'the recorded place is unchanged');
    // Relinking a linked document by a link to a Kainow-filed file is refused as well.
    fake.moveItem(drive.driveId, doc.itemId, plans);
    const byLink = await c.pm.request('POST', vUrl(sub.body.id, 1, 'relink'), { url: secret.file.web_url });
    assert.equal(byLink.status, 409);
  });

  test('a linked document opens in SharePoint only: Kainow never streams its bytes', async () => {
    const plans = (await connector.createFolder({ ...driveRoot(), rootItemId: outputsRoot }, null, 'Plans')).itemId;
    const doc = await connector.upload({ ...driveRoot(), rootItemId: outputsRoot }, plans, 'Plan of works.docx', Buffer.from('plan of works'), { conflict: 'fail' });
    const sub = await c.ada.request('POST', url(), { kind: 'link', url: doc.webUrl, title: 'Plan of works' });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const before = fake.calls.filter((x) => x.method === 'GET' && x.path.endsWith('/content')).length;
    const r = await c.ada.raw('GET', vUrl(sub.body.id, 1, 'download'));
    assert.equal(r.status, 409, r.text);
    assert.equal(JSON.parse(r.text).message, LINKED_OPEN_ONLY);
    assert.equal(fake.calls.filter((x) => x.method === 'GET' && x.path.endsWith('/content')).length, before, 'no bytes fetched');
    assert.equal((await c.ada.raw('GET', vUrl(sub.body.id, 1, 'open'))).status, 303, 'Open still redirects to the document');
  });

  test('download streams the file to readers only', async () => {
    const bytes = Buffer.from('# Weekly status\n\nThe valve audit is on Friday.\n');
    const { out, file } = await filedOutput('Weekly status', { bytes });
    const r = await c.ada.raw('GET', vUrl(out, 1, 'download'));
    assert.equal(r.status, 200);
    assert.equal(r.text, bytes.toString('utf8'));
    assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename="Weekly status v1\.md"/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await c.eve.raw('GET', vUrl(out, 1, 'download'))).status, 404);
    // A file changed in storage is not handed out as the version.
    fake.changeContent(drive.driveId, file.item_id, Buffer.from('Edited outside Kainow.'));
    const changed = await c.ada.request('GET', vUrl(out, 1, 'download'));
    assert.equal(changed.status, 409);
    assert.equal(changed.body.state, 'changed');
    assert.equal((await fileRow(out)).check_status, 'changed');
  });
});
