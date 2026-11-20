import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { M365TokenSource } from '../email/m365-token';
import type { StorageConnectorFactory } from '../storage/connector-factory';
import { GraphConnector } from '../storage/connectors/graph';
import { type StorageDeps, onFinalFailure } from '../storage/jobs';
import { makeStorageNotify } from '../storage/notices';
import { type DestinationRef, StorageError } from '../storage/types';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { DIFFERENT_FILE, NOT_KEPT, NO_DESTINATION, dropUnfiledBytes, fileOutputVersion } from './filing';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';
const DAY = 86_400_000;

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = 'filingboundary42';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

describe('filing output versions', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let fake: FakeGraph;
  let connector: GraphConnector;
  let drive: { driveId: string; rootItemId: string };
  let destId: string;
  let dept: string;
  let project: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => ({ connector, dest: { id, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId } }),
    forNew: async () => connector,
  };
  const dest = (): DestinationRef => ({ id: destId, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId });
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now) });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const typeId = async (name: string) => (await rows(`SELECT id FROM report_types WHERE name = $1`, [name]))[0].id as string;
  const url = (p = '') => `/projects/${project}/outputs${p}`;
  const fileUrl = (outputId: string, n = 1) => url(`/${outputId}/versions/${n}/file`);

  /** An uploaded Markdown output registered by the PM (Status reports unless told otherwise). */
  async function registered(title: string, opts: { issueDate?: string | null; restrictTo?: string[]; type?: string; bytes?: Buffer } = {}): Promise<string> {
    const m = multipart({ title }, { name: 'report.md', bytes: opts.bytes ?? Buffer.from(`# ${title}\n\nThe valve audit is on Friday.\n`) });
    const sub = await c.pm.upload('POST', url(), m.body, m.type);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const body: Record<string, unknown> = { reportTypeId: await typeId(opts.type ?? 'Status reports') };
    if (opts.issueDate !== null) body.issueDate = opts.issueDate ?? '2026-11-09';
    if (opts.restrictTo) body.audience = { mode: 'restricted', namedUserIds: opts.restrictTo };
    const reg = await c.pm.request('POST', url(`/${sub.body.id}/register`), body);
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    return sub.body.id;
  }
  const versionId = async (outputId: string, n = 1) =>
    (await rows(`SELECT id FROM output_versions WHERE output_id = $1 AND version_no = $2`, [outputId, n]))[0].id as string;
  const fileRow = async (outputId: string, n = 1) =>
    (await rows(`SELECT f.* FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id WHERE v.output_id = $1 AND v.version_no = $2`, [outputId, n]))[0];
  const filing = async (who: Client, outputId: string, n = 1) => {
    const r = await who.request('GET', url(`/${outputId}`));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.versions.find((v: { no: number }) => v.no === n).filing;
  };
  /** Requests filing and runs the job once. */
  async function fileNow(outputId: string, n = 1): Promise<Record<string, any>> {
    const r = await c.pm.request('POST', fileUrl(outputId, n));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await fileOutputVersion(deps(), await versionId(outputId, n));
    return fileRow(outputId, n);
  }
  /** The item's path in the provider, walking its parents up to the destination root. */
  async function providerPath(itemId: string): Promise<string> {
    const names: string[] = [];
    let id = itemId;
    while (id !== drive.rootItemId) {
      const it = await connector.getItem(dest(), id);
      names.unshift(it.name);
      id = it.parentId;
    }
    return names.join('/');
  }
  const uploads = () => fake.calls.filter((x) => x.method === 'PUT' && x.path.endsWith(':/content')).length;

  beforeEach(async () => {
    fake = await startFakeGraph();
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    connector = new GraphConnector(tokens, { fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: true, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
    drive = fake.addDrive();
    t = await startTestApp(undefined, { storageConnectors: factory });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'ada']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    dept = await seedDepartment(t.pool, 'Water Services');
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
    destId = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'graph', 'sharepoint_library', 'outputs', 'Outputs library', $2, $3, 'approved', $4, now())`,
      [destId, drive.driveId, drive.rootItemId, ids.admin],
    );
    await t.pool.query(`INSERT INTO project_output_settings (project_id, destination_id) VALUES ($1, $2)`, [project, destId]);
    for (const k of Object.keys(ids)) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  test('filing needs a project destination', async () => {
    const out = await registered('Weekly status');
    await t.pool.query(`UPDATE project_output_settings SET destination_id = NULL WHERE project_id = $1`, [project]);
    const r = await c.pm.request('POST', fileUrl(out));
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Choose where this project files its outputs first (Project settings › Outputs).');
    assert.equal(NO_DESTINATION, r.body.message);
    // A destination that has since been withdrawn is no place to file either.
    await t.pool.query(`UPDATE project_output_settings SET destination_id = $2 WHERE project_id = $1`, [project, destId]);
    await t.pool.query(`UPDATE storage_destinations SET status = 'withdrawn' WHERE id = $1`, [destId]);
    assert.equal((await c.pm.request('POST', fileUrl(out))).body.message, NO_DESTINATION);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files`))[0].n, 0);
    // Only the PM or a Deputy files.
    assert.equal((await c.ada.request('POST', fileUrl(out))).status, 403);
  });

  test('Project-wide output files under Department / Project / Year / Report Type with Title vN.ext', async () => {
    const out = await registered('Weekly status', { issueDate: '2026-11-09' });
    const r = await c.pm.request('POST', fileUrl(out));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.versions[0].filing.state, 'pending');
    assert.equal(r.body.versions[0].filing.label, 'Waiting to file');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox WHERE job = 'file-output'`))[0].n, 1);
    await fileOutputVersion(deps(), await versionId(out));
    const f = await fileRow(out);
    assert.equal(f.state, 'stored');
    assert.equal(f.path, 'Water Services/Pump station renewal/2026/Status reports/Weekly status v1.md');
    assert.equal(f.name, 'Weekly status v1.md');
    assert.equal(await providerPath(f.item_id), f.path);
    const levels = await rows(`SELECT level, key, name FROM storage_folders WHERE destination_id = $1 ORDER BY length(key), level`, [destId]);
    const type = await typeId('Status reports');
    assert.deepEqual(
      levels.map((l) => [l.level, l.key, l.name]),
      [
        ['department', dept, 'Water Services'],
        ['project', `${dept}/${project}`, 'Pump station renewal'],
        ['year', `${dept}/${project}/2026`, '2026'],
        ['report_type', `${dept}/${project}/2026/${type}`, 'Status reports'],
      ],
    );
    const shown = await filing(c.pm, out);
    assert.equal(shown.label, 'Filed');
    assert.equal(shown.path, f.path);
    assert.equal((await filing(c.ada, out)).path, undefined, 'the path is for the PM, Deputies, Owner and Sponsors');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_events WHERE output_id = $1 AND kind = 'filed'`, [out]))[0].n, 1);
    const again = await c.pm.request('POST', fileUrl(out));
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'This version is already filed.');
  });

  test('Restricted output files under Department / Project (restricted) / Output title', async () => {
    const out = await registered('Board briefing', { restrictTo: [ids.pm, ids.deputy] });
    const f = await fileNow(out);
    assert.equal(f.state, 'stored');
    assert.equal(f.path, 'Water Services/Pump station renewal (restricted)/Board briefing/Board briefing v1.md');
    assert.equal(await providerPath(f.item_id), f.path);
    // Another output with the same title gets its own folder.
    const twin = await registered('Board briefing', { restrictTo: [ids.pm] });
    const g = await fileNow(twin);
    assert.equal(g.path, 'Water Services/Pump station renewal (restricted)/Board briefing (2)/Board briefing v1.md');
    const keys = (await rows(`SELECT level, key FROM storage_folders WHERE level IN ('restricted_root', 'output') ORDER BY key`)).map((r) => `${r.level}:${r.key}`);
    assert.deepEqual(keys.sort(), [
      `output:${dept}/${project}/output/${out}`,
      `output:${dept}/${project}/output/${twin}`,
      `restricted_root:${dept}/${project}/restricted`,
    ].sort());
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_folders WHERE level IN ('project', 'year', 'report_type')`))[0].n, 0, 'no project tree for restricted outputs');
  });

  test('folders are created once and reused by id after the project and department are renamed', async () => {
    const out = await registered('Weekly status');
    const first = await fileNow(out);
    const folders = await rows(`SELECT id, item_id FROM storage_folders ORDER BY id`);
    await t.pool.query(`UPDATE departments SET name = 'Water and Drainage' WHERE id = $1`, [dept]);
    await t.pool.query(`UPDATE projects SET name = 'Pump station upgrade' WHERE id = $1`, [project]);
    await t.pool.query(`UPDATE report_types SET name = 'Status updates' WHERE name = 'Status reports'`);
    const m = multipart({}, { name: 'report.md', bytes: Buffer.from('# Weekly status\n\nVersion two.\n') });
    assert.equal((await c.pm.upload('POST', url(`/${out}/versions`), m.body, m.type)).status, 201);
    const second = await fileNow(out, 2);
    assert.equal(second.path, 'Water Services/Pump station renewal/2026/Status reports/Weekly status v2.md');
    assert.equal((await connector.getItem(dest(), second.item_id)).parentId, (await connector.getItem(dest(), first.item_id)).parentId);
    assert.deepEqual(await rows(`SELECT id, item_id FROM storage_folders ORDER BY id`), folders, 'no new folder');
    // A second project-wide output in the same project reuses the department and project folders too.
    const other = await registered('Risk summary', { type: 'Risk summaries' });
    const g = await fileNow(other);
    assert.equal(g.path, 'Water Services/Pump station renewal/2026/Risk summaries/Risk summary v1.md');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_folders WHERE level IN ('department', 'project')`))[0].n, 2);
  });

  test('issue year comes from the issue date in UTC+8', async () => {
    const dec = await registered('Year end', { issueDate: '2026-12-31' });
    assert.match((await fileNow(dec)).path, /^Water Services\/Pump station renewal\/2026\/Status reports\//);
    const jan = await registered('New year', { issueDate: '2027-01-01' });
    assert.match((await fileNow(jan)).path, /^Water Services\/Pump station renewal\/2027\/Status reports\//);
    // Registered without a date at 00:30 on 1 January in UTC+8 (still 31 December in UTC): the year is 2027.
    t.clock.ms = Date.UTC(2026, 11, 31, 16, 30);
    c.pm = await t.signIn('pm@example.org');
    const midnight = await registered('Midnight', { issueDate: null });
    assert.equal((await rows(`SELECT to_char(issue_date, 'YYYY-MM-DD') AS d FROM outputs WHERE id = $1`, [midnight]))[0].d, '2027-01-01');
    assert.match((await fileNow(midnight)).path, /\/2027\/Status reports\/Midnight v1\.md$/);
  });

  test('filed only after hash confirmation; bytes then removed from the database', async () => {
    const out = await registered('Weekly status');
    const vid = await versionId(out);
    assert.equal((await c.pm.request('POST', fileUrl(out))).status, 200);
    // The provider reports a different size and hash (the upload is altered on the way): nothing is filed, the bytes stay.
    const real = connector.upload.bind(connector);
    connector.upload = async (d, folder, name, bytes, opts) => real(d, folder, name, Buffer.concat([bytes, Buffer.from('tampered')]), opts);
    await assert.rejects(fileOutputVersion(deps(), vid), (e: unknown) => e instanceof StorageError && e.code === 'server');
    connector.upload = real;
    let f = await fileRow(out);
    assert.equal(f.state, 'pending');
    assert.equal(f.item_id, null);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_version_bytes WHERE output_version_id = $1 AND bytes IS NOT NULL`, [vid]))[0].n, 1);
    assert.equal((await filing(c.pm, out)).label, 'Waiting to file');
    assert.equal(await connector.findChild(dest(), (await rows(`SELECT item_id FROM storage_folders WHERE level = 'report_type'`))[0].item_id, 'Weekly status v1.md'), null, 'the bad upload was removed');
    // The next attempt is confirmed: filed, with both checksums, and the bytes leave the database.
    await fileOutputVersion(deps(), vid);
    f = await fileRow(out);
    assert.equal(f.state, 'stored');
    const v = (await rows(`SELECT sha256, size_bytes FROM output_versions WHERE id = $1`, [vid]))[0];
    assert.equal(f.sha256, v.sha256);
    assert.equal(Number(f.size_bytes), Number(v.size_bytes));
    assert.equal(f.provider_hash, (await connector.getItem(dest(), f.item_id)).providerHash);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_version_bytes WHERE output_version_id = $1`, [vid]))[0].n, 0);
  });

  test('uncertain upload adopts the matching file on retry and never creates a second', async () => {
    const out = await registered('Weekly status');
    const vid = await versionId(out);
    assert.equal((await c.pm.request('POST', fileUrl(out))).status, 200);
    fake.fault({ method: 'PUT', pathIncludes: ':/content' }, 'drop_after_body', 1);
    await assert.rejects(fileOutputVersion(deps(), vid), (e: unknown) => e instanceof StorageError);
    let f = await fileRow(out);
    assert.equal(f.state, 'pending');
    assert.equal(f.attempts, 1);
    await fileOutputVersion(deps(), vid);
    f = await fileRow(out);
    assert.equal(f.state, 'stored');
    assert.equal(f.name, 'Weekly status v1.md', 'the earlier upload was adopted under its own name');
    const folder = (await rows(`SELECT item_id FROM storage_folders WHERE level = 'report_type'`))[0].item_id;
    assert.equal((await connector.findChild(dest(), folder, 'Weekly status v1.md'))?.itemId, f.item_id);
    assert.equal(await connector.findChild(dest(), folder, 'Weekly status v1 (2).md'), null, 'no second copy');
  });

  test('concurrent file requests produce one stored file', async () => {
    const out = await registered('Weekly status');
    const vid = await versionId(out);
    const [a, b] = await Promise.all([c.pm.request('POST', fileUrl(out)), c.deputy.request('POST', fileUrl(out))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((a.status === 409 ? a : b).body.message, 'This version is already being filed.');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files WHERE purpose = 'output'`))[0].n, 1);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox WHERE job = 'file-output' AND subject_id = $1`, [vid]))[0].n, 1);
    // Two runs of the job at once (a redelivery) upload once.
    await Promise.all([fileOutputVersion(deps(), vid), fileOutputVersion(deps(), vid)]);
    await fileOutputVersion(deps(), vid);
    assert.equal((await fileRow(out)).state, 'stored');
    assert.equal(uploads(), 1, 'one provider item');
  });

  test('a different file with the same name gives (2), never overwrites', async () => {
    const out = await registered('Weekly status');
    // Someone already put a different "Weekly status v1.md" in the report type folder.
    let parent: string | null = null;
    for (const name of ['Water Services', 'Pump station renewal', '2026', 'Status reports']) parent = (await connector.ensureFolder(dest(), parent, name)).itemId;
    const theirs = Buffer.from('Somebody else’s notes.');
    const existing = await connector.upload(dest(), parent as string, 'Weekly status v1.md', theirs, { conflict: 'fail' });
    const f = await fileNow(out);
    assert.equal(f.state, 'stored');
    assert.equal(f.name, 'Weekly status v1 (2).md');
    assert.equal(f.path, 'Water Services/Pump station renewal/2026/Status reports/Weekly status v1 (2).md');
    assert.ok((await connector.download(dest(), existing.itemId)).equals(theirs), 'their file is untouched');
    assert.notEqual(f.item_id, existing.itemId);
    assert.equal(DIFFERENT_FILE, 'A different file already has this name');
  });

  test('final failure shows Filing failed with reason and Try again works', async () => {
    const out = await registered('Weekly status');
    const vid = await versionId(out);
    assert.equal((await c.pm.request('POST', fileUrl(out))).status, 200);
    fake.fault({ method: 'PUT', pathIncludes: ':/content' }, '403', 1);
    let code = '';
    await assert.rejects(fileOutputVersion(deps(), vid), (e: unknown) => e instanceof StorageError && !!(code = e.code));
    await onFinalFailure(deps(), 'file-output', vid, code as 'forbidden');
    const failed = await filing(c.pm, out);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.label, 'Filing failed — The storage connection does not have permission for this');
    assert.equal(failed.tryAgain, true);
    assert.equal((await filing(c.ada, out)).tryAgain, undefined, 'Try again is for the PM and Deputies');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_events WHERE output_id = $1 AND kind = 'filing_failed'`, [out]))[0].n, 1);
    // A conflict the retries could not resolve names the clash.
    await t.pool.query(`UPDATE stored_files SET failure_code = 'conflict' WHERE id = (SELECT stored_file_id FROM output_versions WHERE id = $1)`, [vid]);
    assert.equal((await filing(c.pm, out)).label, `Filing failed — ${DIFFERENT_FILE}`);
    // Try again: back to waiting, queued again, and filed.
    const again = await c.pm.request('POST', fileUrl(out));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.versions[0].filing.state, 'pending');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_outbox WHERE job = 'file-output' AND subject_id = $1`, [vid]))[0].n, 2);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files WHERE purpose = 'output'`))[0].n, 1, 'the same stored file');
    await fileOutputVersion(deps(), vid);
    assert.equal((await filing(c.pm, out)).label, 'Filed');
  });

  test('linked versions cannot be filed', async () => {
    const out = await registered('Weekly status');
    const fileId = uuidv7();
    await t.pool.query(
      `INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, path, name, size_bytes, state, created_at)
       VALUES ($1, 'output', $2, $3, 'graph', $4, 'item-1', 'Plans/plan.docx', 'plan.docx', 10, 'linked', now())`,
      [fileId, project, destId, drive.driveId],
    );
    await t.pool.query(
      `INSERT INTO output_versions (id, output_id, version_no, origin, format, stored_file_id, status, sha256, size_bytes, created_by, created_at)
       VALUES ($1, $2, 2, 'link', 'docx', $3, 'draft', '', 10, $4, now())`,
      [uuidv7(), out, fileId, ids.pm],
    );
    const r = await c.pm.request('POST', fileUrl(out, 2));
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'A linked version stays where it is and is not filed.');
    assert.equal((await rows(`SELECT state FROM stored_files WHERE id = $1`, [fileId]))[0].state, 'linked');
    assert.equal((await c.pm.request('POST', fileUrl(out, 3))).status, 404);
  });

  test('unfiled draft bytes are dropped after 90 days and the version says so', async () => {
    const out = await registered('Weekly status');
    const vid = await versionId(out);
    const filed = await registered('Filed status');
    await fileNow(filed);
    t.clock.ms += 89 * DAY;
    c.pm = await t.signIn('pm@example.org');
    await dropUnfiledBytes(deps());
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_version_bytes WHERE output_version_id = $1`, [vid]))[0].n, 1, 'kept for 90 days');
    assert.equal((await filing(c.pm, out)).label, 'Not filed');
    t.clock.ms += 2 * DAY;
    c.pm = await t.signIn('pm@example.org');
    await dropUnfiledBytes(deps());
    assert.equal((await rows(`SELECT count(*)::int AS n FROM output_version_bytes WHERE output_version_id = $1`, [vid]))[0].n, 0);
    assert.equal((await filing(c.pm, out)).label, 'Not filed — file no longer kept; generate or upload it again');
    assert.equal((await filing(c.pm, filed)).label, 'Filed', 'filed versions are unaffected');
    const r = await c.pm.request('POST', fileUrl(out));
    assert.equal(r.status, 409);
    assert.equal(r.body.message, NOT_KEPT);
    assert.equal(NOT_KEPT, 'Not filed — file no longer kept; generate or upload it again');
  });

  test('Deferred and Closed refuse filing', async () => {
    const out = await registered('Weekly status');
    for (const status of ['deferred', 'closed']) {
      await t.pool.query(`UPDATE projects SET status = $2, closure_outcome = CASE WHEN $2 = 'closed' THEN 'abandoned' ELSE NULL END WHERE id = $1`, [project, status]);
      const r = await c.pm.request('POST', fileUrl(out));
      assert.equal(r.status, 403, status);
      assert.equal(r.body.message, 'Only the Project Manager or a Deputy can register, decline or change outputs, and not while the project is Deferred or Closed.');
    }
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_files`))[0].n, 0);
  });
});
