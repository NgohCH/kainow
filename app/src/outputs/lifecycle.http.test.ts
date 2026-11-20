import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { M365TokenSource } from '../email/m365-token';
import type { StorageConnectorFactory } from '../storage/connector-factory';
import { GraphConnector } from '../storage/connectors/graph';
import { type StorageDeps, type StorageJob, storageHandler } from '../storage/jobs';
import { makeStorageNotify } from '../storage/notices';
import { type DestinationRef, StorageError } from '../storage/types';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = 'lifecycleboundary42';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

describe('withdrawing, deleting and restoring outputs', { skip: SKIP_NO_DB }, () => {
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
    forDestination: async (id) => {
      const r = (await t.pool.query(`SELECT drive_id, root_item_id FROM storage_destinations WHERE id = $1`, [id])).rows[0];
      if (!r) throw new StorageError('invalid');
      return { connector, dest: { id, connector: 'graph', driveId: r.drive_id, rootItemId: r.root_item_id } };
    },
    forNew: async () => connector,
  };
  const dest = (): DestinationRef => ({ id: destId, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId });
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now) });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const typeId = async (name: string) => (await rows(`SELECT id FROM report_types WHERE name = $1`, [name]))[0].id as string;
  const url = (p = '') => `/projects/${project}/outputs${p}`;
  const fileRow = async (outputId: string) =>
    (await rows(`SELECT f.* FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id WHERE v.output_id = $1 AND v.version_no = 1`, [outputId]))[0];
  const folder = async (level: string, key: string) => (await rows(`SELECT id, item_id FROM storage_folders WHERE level = $1 AND key = $2`, [level, key]))[0] as { id: string; item_id: string } | undefined;
  const parentOf = async (itemId: string) => (await connector.getItem(dest(), itemId)).parentId;
  const granted = async (folderId: string) =>
    (await rows(`SELECT u.email FROM storage_grants g JOIN users u ON u.id = g.user_id WHERE g.folder_id = $1 AND g.state = 'granted' ORDER BY u.email`, [folderId])).map((r) => r.email);

  async function drain(): Promise<Array<{ job: StorageJob; failed?: string }>> {
    const ran: Array<{ job: StorageJob; failed?: string }> = [];
    for (let i = 0; i < 100; i++) {
      const next = (
        await rows(`UPDATE storage_outbox SET sent_at = now() WHERE id = (SELECT id FROM storage_outbox WHERE sent_at IS NULL ORDER BY urgent DESC, created_at, id LIMIT 1) RETURNING job, subject_id`)
      )[0];
      if (!next) return ran;
      const entry: { job: StorageJob; failed?: string } = { job: next.job };
      try {
        await storageHandler(next.job)!(deps(), next.subject_id, 1);
      } catch (err) {
        entry.failed = (err as { code?: string }).code ?? 'internal';
      }
      ran.push(entry);
    }
    throw new Error('the outbox did not drain');
  }

  async function filedOutput(title: string, restrictTo?: string[]): Promise<{ out: string; file: Record<string, any> }> {
    const m = multipart({ title }, { name: 'report.md', bytes: Buffer.from(`# ${title}\n\nThe valve audit is on Friday.\n`) });
    const sub = await c.pm.upload('POST', url(), m.body, m.type);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const body: Record<string, unknown> = { reportTypeId: await typeId('Status reports'), issueDate: '2026-11-09' };
    if (restrictTo) body.audience = { mode: 'restricted', namedUserIds: restrictTo };
    assert.equal((await c.pm.request('POST', url(`/${sub.body.id}/register`), body)).status, 200);
    assert.equal((await c.pm.request('POST', url(`/${sub.body.id}/versions/1/file`))).status, 200);
    await drain();
    const file = await fileRow(sub.body.id);
    assert.equal(file.state, 'stored');
    return { out: sub.body.id, file };
  }
  const outputFolder = (outputId: string) => folder('output', `${dept}/${project}/output/${outputId}`);
  const projectFolder = () => folder('project', `${dept}/${project}`);
  const touched = (itemId: string) => fake.calls.filter((x) => x.path.includes(itemId) && (x.method === 'DELETE' || x.path.endsWith('/permanentDelete')));

  beforeEach(async () => {
    fake = await startFakeGraph();
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    connector = new GraphConnector(tokens, { fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: true, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
    drive = fake.addDrive();
    t = await startTestApp(undefined, { storageConnectors: factory });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'owner', 'ada']) {
      ids[k] = await seedUser(t.pool, `${k}@example.org`);
      fake.addUser(`${k}@example.org`);
    }
    dept = await seedDepartment(t.pool, 'Water Services');
    project = await seedProject(t.pool, {
      status: 'active',
      name: 'Pump station renewal',
      departmentId: dept,
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
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
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.org', $2, now())`, [uuidv7(), ids.admin]);
    for (const k of ['pm', 'deputy', 'owner', 'ada']) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  test('withdraw needs a reason, is final, moves files to the output folder with no grants', async () => {
    const { out, file } = await filedOutput('Weekly status');
    const pf = await projectFolder();
    assert.ok(pf);
    assert.ok((await granted(pf.id)).includes('ada@example.org'), 'the project folder is shared with the project');
    // Put for approval, so the withdrawal has a request to end.
    assert.equal((await c.pm.request('POST', url(`/${out}/versions/1/approval`))).status, 201);

    // A reason is required; only the PM or a Deputy withdraws; others who cannot see it are told nothing.
    assert.equal((await c.pm.request('POST', url(`/${out}/withdraw`), {})).status, 400);
    assert.equal((await c.ada.request('POST', url(`/${out}/withdraw`), { reason: 'Superseded by the board pack' })).status, 403);
    assert.equal((await c.owner.request('POST', url(`/${out}/withdraw`), { reason: 'Superseded by the board pack' })).status, 403);
    const r = await c.deputy.request('POST', url(`/${out}/withdraw`), { reason: 'Superseded by the board pack' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'withdrawn');
    assert.deepEqual(
      (await rows(`SELECT kind, reason FROM output_events WHERE output_id = $1 AND kind = 'withdrawn'`, [out])).map((e) => [e.kind, e.reason]),
      [['withdrawn', 'Superseded by the board pack']],
    );
    assert.equal((await rows(`SELECT status FROM change_requests WHERE kind = 'approve_output'`))[0].status, 'withdrawn');
    // Final: it cannot be withdrawn again, changed or given new versions.
    assert.equal((await c.pm.request('POST', url(`/${out}/withdraw`), { reason: 'Again' })).status, 409);
    assert.equal((await c.pm.request('PUT', url(`/${out}`), { title: 'Renamed' })).status, 409);
    // Members no longer see it; its file has left the shared project folder for its own folder, which nobody is granted.
    assert.equal((await c.ada.request('GET', url(`/${out}`))).status, 404);
    await drain();
    const of = await outputFolder(out);
    assert.ok(of, 'the output has its own folder');
    assert.equal(await parentOf(file.item_id), of.item_id);
    assert.deepEqual(await granted(of.id), []);
    assert.equal((await fileRow(out)).folder_id, of.id);
    assert.ok((await granted(pf.id)).includes('ada@example.org'), 'the project folder keeps its readers');
    assert.deepEqual(touched(file.item_id), [], 'the file itself is never deleted');
  });

  // TODO (Tasks 18 and 22): search and CSV exports of outputs must keep `deleted_at IS NULL` and test it here.
  test('delete hides the output from the register and moves files out of shared folders; restore brings them back; the external file is never deleted', async () => {
    const { out, file } = await filedOutput('Weekly status');
    const typeFolder = await parentOf(file.item_id);
    const pf = (await projectFolder())!;

    assert.equal((await c.pm.request('POST', url(`/${out}/delete`), {})).status, 400, 'a reason is required');
    assert.equal((await c.ada.request('POST', url(`/${out}/delete`), { reason: 'Registered twice' })).status, 403);
    assert.equal((await c.owner.request('POST', url(`/${out}/delete`), { reason: 'Registered twice' })).status, 403);
    t.clock.advanceSeconds(1);
    const del = await c.pm.request('POST', url(`/${out}/delete`), { reason: 'Registered twice' });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.deepEqual(del.body, { id: out, deleted: true });
    const row = (await rows(`SELECT deleted_at, deleted_by, delete_reason, status FROM outputs WHERE id = $1`, [out]))[0];
    assert.ok(row.deleted_at);
    assert.deepEqual([row.deleted_by, row.delete_reason, row.status], [ids.pm, 'Registered twice', 'registered']);

    // Hidden from every ordinary view: the register, the detail, opening, a second delete.
    for (const who of ['pm', 'deputy', 'ada', 'owner']) {
      assert.deepEqual((await c[who].request('GET', url())).body.outputs, [], who);
      assert.equal((await c[who].request('GET', url(`/${out}`))).status, 404, who);
      assert.equal((await c[who].raw('GET', url(`/${out}/versions/1/open`))).status, 404, who);
    }
    assert.equal((await c.pm.request('POST', url(`/${out}/delete`), { reason: 'Again' })).status, 404);
    // Listed for the PM and Deputies to restore, with who, when and why; nobody else.
    const listed = (await c.deputy.request('GET', url('/deleted'))).body.outputs;
    assert.deepEqual(listed.map((o: any) => [o.id, o.title, o.deletedBy.id, o.reason]), [[out, 'Weekly status', ids.pm, 'Registered twice']]);
    assert.deepEqual((await c.ada.request('GET', url('/deleted'))).body.outputs, []);

    // Its file leaves the shared project folder for its own folder, which has no grants; it is never deleted.
    await drain();
    const of = (await outputFolder(out))!;
    assert.equal(await parentOf(file.item_id), of.item_id);
    assert.deepEqual(await granted(of.id), []);
    assert.deepEqual(touched(file.item_id), []);
    assert.equal((await fileRow(out)).state, 'stored');

    // Restore: a reason, the PM or a Deputy, any project state (here Closed); the file goes back and is shared again.
    assert.equal((await c.deputy.request('POST', url(`/${out}/restore`), {})).status, 400);
    assert.equal((await c.ada.request('POST', url(`/${out}/restore`), { reason: 'Only copy' })).status, 403);
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [project]);
    t.clock.advanceSeconds(1);
    const res = await c.deputy.request('POST', url(`/${out}/restore`), { reason: 'It was the only copy' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.id, out);
    assert.deepEqual(res.body.history.slice(-2).map((h: any) => [h.kind, h.reason]), [['deleted', 'Registered twice'], ['restored', 'It was the only copy']]);
    assert.deepEqual((await rows(`SELECT deleted_at, deleted_by, delete_reason FROM outputs WHERE id = $1`, [out]))[0], { deleted_at: null, deleted_by: null, delete_reason: null });
    assert.equal((await c.ada.request('GET', url(`/${out}`))).status, 200);
    await drain();
    assert.equal(await parentOf(file.item_id), typeFolder);
    assert.ok((await granted(pf.id)).includes('ada@example.org'));
    assert.deepEqual(touched(file.item_id), []);
    assert.equal((await c.pm.request('POST', url(`/${out}/restore`), { reason: 'Again' })).status, 404, 'not deleted any more');
    // Deleting is refused while the project is Closed.
    assert.equal((await c.pm.request('POST', url(`/${out}/delete`), { reason: 'Registered twice' })).status, 403);
    assert.deepEqual(
      (await rows(`SELECT action FROM audit_events WHERE subject_id = $1 AND action IN ('output.deleted', 'output.restored') ORDER BY occurred_at, id`, [out])).map((a) => a.action),
      ['output.deleted', 'output.restored'],
    );
  });

  test('restore re-checks that the restorer would read the output', async () => {
    const { out } = await filedOutput('Board briefing', [ids.pm, ids.ada]);
    assert.equal((await c.deputy.request('POST', url(`/${out}/delete`), { reason: 'Not in its audience' })).status, 404, 'the Deputy does not read it');
    assert.equal((await c.pm.request('POST', url(`/${out}/delete`), { reason: 'Registered twice' })).status, 200);
    // The Deputy may restore outputs but would not read this one: told nothing.
    assert.equal((await c.deputy.request('POST', url(`/${out}/restore`), { reason: 'Bring it back' })).status, 404);
    assert.deepEqual((await c.deputy.request('GET', url('/deleted'))).body.outputs, []);
    assert.equal((await c.pm.request('POST', url(`/${out}/restore`), { reason: 'Bring it back' })).status, 200);
  });
});
