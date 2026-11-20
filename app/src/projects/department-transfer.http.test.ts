import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { M365TokenSource } from '../email/m365-token';
import { leadershipProjectIds } from '../leadership/grants';
import type { StorageConnectorFactory } from '../storage/connector-factory';
import { GraphConnector } from '../storage/connectors/graph';
import { type StorageDeps, type StorageJob, onFinalFailure, storageHandler } from '../storage/jobs';
import { makeStorageNotify } from '../storage/notices';
import type { DestinationRef } from '../storage/types';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { todayUtc8 } from './membership';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT = 'Pump station renewal';
const OLD = 'Water Services';
const NEW = 'Asset Management';

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = 'transferboundary42';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

describe('owning department transfer', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let fake: FakeGraph;
  let connector: GraphConnector;
  let drive: { driveId: string; rootItemId: string };
  let destId: string;
  let dept: string;
  let newDept: string;
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
  const url = (p = '') => `/projects/${project}/outputs${p}`;
  const transferUrl = () => `/projects/${project}/owning-department`;

  async function registered(title: string, restrictTo?: string[], extra: Record<string, unknown> = {}): Promise<string> {
    const m = multipart({ title }, { name: 'report.md', bytes: Buffer.from(`# ${title}\n\nThe valve audit is on Friday.\n`) });
    const sub = await c.pm.upload('POST', url(), m.body, m.type);
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const typeId = (await rows(`SELECT id FROM report_types WHERE name = 'Status reports'`))[0].id;
    const body: Record<string, unknown> = { reportTypeId: typeId, issueDate: '2026-11-09', ...extra };
    if (restrictTo) body.audience = { mode: 'restricted', namedUserIds: restrictTo };
    const reg = await c.pm.request('POST', url(`/${sub.body.id}/register`), body);
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    return sub.body.id;
  }
  const fileRow = async (outputId: string) =>
    (await rows(`SELECT f.* FROM output_versions v JOIN stored_files f ON f.id = v.stored_file_id WHERE v.output_id = $1 AND v.version_no = 1`, [outputId]))[0];
  async function filed(outputId: string): Promise<Record<string, any>> {
    const r = await c.pm.request('POST', url(`/${outputId}/versions/1/file`));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const f = await fileRow(outputId);
    assert.equal(f.state, 'stored');
    return f;
  }

  /** Runs the queued storage work as the worker would (one attempt each), urgent first, until none is left. */
  async function drain(): Promise<Array<{ job: StorageJob; subjectId: string; failed?: string }>> {
    const ran: Array<{ job: StorageJob; subjectId: string; failed?: string }> = [];
    for (let i = 0; i < 100; i++) {
      const next = (
        await rows(`UPDATE storage_outbox SET sent_at = now() WHERE id = (SELECT id FROM storage_outbox WHERE sent_at IS NULL ORDER BY urgent DESC, created_at, id LIMIT 1) RETURNING job, subject_id`)
      )[0];
      if (!next) return ran;
      const entry: { job: StorageJob; subjectId: string; failed?: string } = { job: next.job, subjectId: next.subject_id };
      try {
        await storageHandler(next.job)!(deps(), next.subject_id, 1);
      } catch (err) {
        entry.failed = (err as { code?: string }).code ?? 'internal';
      }
      ran.push(entry);
    }
    throw new Error('the outbox did not drain');
  }

  const folder = async (level: string, key: string) =>
    (await rows(`SELECT id, item_id, name FROM storage_folders WHERE level = $1 AND key = $2`, [level, key]))[0] as { id: string; item_id: string; name: string } | undefined;
  const granted = async (folderId: string) =>
    (await rows(`SELECT u.email FROM storage_grants g JOIN users u ON u.id = g.user_id WHERE g.folder_id = $1 AND g.state = 'granted' ORDER BY u.email`, [folderId])).map((r) => r.email);
  const sharedWith = async (itemId: string) => (await connector.listPermissions(dest(), itemId)).filter((p) => p.kind === 'user').map((p) => p.principal).sort();
  const item = (itemId: string) => connector.getItem(dest(), itemId);
  const plain = (p: string) => p.replace(/^\/+/, '');
  const transfer = (who: Client, body: Record<string, unknown>) => who.request('PUT', transferUrl(), body);
  const versionFiling = async (outputId: string) => (await c.pm.request('GET', url(`/${outputId}`))).body.versions[0].filing;

  beforeEach(async () => {
    fake = await startFakeGraph();
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    connector = new GraphConnector(tokens, { fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: true, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
    drive = fake.addDrive();
    t = await startTestApp(undefined, { storageConnectors: factory });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'lea']) {
      ids[k] = await seedUser(t.pool, `${k}@example.org`);
      fake.addUser(`${k}@example.org`);
    }
    dept = await seedDepartment(t.pool, OLD);
    newDept = await seedDepartment(t.pool, NEW);
    project = await seedProject(t.pool, {
      status: 'active',
      name: PROJECT,
      departmentId: dept,
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
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
    for (const k of ['admin', 'pm', 'ada']) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  test('only an Enterprise Administrator transfers, in any project state, with a reason', async () => {
    const pm = await transfer(c.pm, { departmentId: newDept, reason: 'Reorganised' });
    assert.equal(pm.status, 403);
    assert.equal(pm.body.message, "Only an Enterprise Administrator can change a project's owning department.");
    assert.equal((await transfer(c.ada, { departmentId: newDept, reason: 'Reorganised' })).status, 403);
    assert.equal((await transfer(c.admin, { departmentId: newDept })).status, 400, 'a reason is required');
    assert.equal((await transfer(c.admin, { departmentId: newDept, reason: '   ' })).status, 400);
    assert.equal((await transfer(c.admin, { departmentId: 'not-a-uuid', reason: 'Reorganised' })).status, 400);
    const same = await transfer(c.admin, { departmentId: dept, reason: 'Reorganised' });
    assert.equal(same.status, 409);
    assert.equal(same.body.message, 'The project already belongs to that department.');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM project_department_transfers`))[0].n, 0, 'nothing recorded by a refusal');

    // Any project state: a Deferred project.
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    const ok = await transfer(c.admin, { departmentId: newDept, reason: '  Reorganised  ' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.state, 'done');
    assert.ok(ok.body.transferId);
    assert.equal((await rows(`SELECT owning_department_id FROM projects WHERE id = $1`, [project]))[0].owning_department_id, newDept);
    const tr = (await rows(`SELECT * FROM project_department_transfers WHERE project_id = $1`, [project]))[0];
    assert.deepEqual(
      [tr.id, tr.from_department_id, tr.to_department_id, tr.reason, tr.folder_choice, tr.state, tr.actor_id],
      [ok.body.transferId, dept, newDept, 'Reorganised', null, 'done', ids.admin],
    );
    const audit = await rows(`SELECT actor_user_id, subject_type, subject_id, detail FROM audit_events WHERE action = 'project.department_transferred'`);
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].actor_user_id, audit[0].subject_type, audit[0].subject_id], [ids.admin, 'project', project]);
    assert.deepEqual(audit[0].detail, { from: dept, to: newDept, folderChoice: null, filedFiles: 0 });
    const view = await c.admin.request('GET', transferUrl());
    assert.equal(view.status, 200);
    assert.equal(view.body.department.name, NEW);
    assert.equal(view.body.transfer.from.name, OLD);
    assert.equal(view.body.transfer.label, null);
    assert.equal((await c.pm.request('GET', transferUrl())).status, 403);
  });

  test('folder choice required only when outputs are filed', async () => {
    const out = await registered('Weekly status');
    // Registered but not filed: no choice needed.
    const first = await transfer(c.admin, { departmentId: newDept, reason: 'Reorganised' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    t.clock.advanceSeconds(60);
    await filed(out);
    assert.equal((await c.admin.request('GET', transferUrl())).body.filedFiles, 1);
    const missing = await transfer(c.admin, { departmentId: dept, reason: 'Back again' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.message, "This project has filed outputs. Choose whether to move the project's folder or keep it where it is.");
    assert.equal((await transfer(c.admin, { departmentId: dept, reason: 'Back again', folderChoice: 'sideways' })).status, 400);
    assert.equal((await rows(`SELECT owning_department_id FROM projects WHERE id = $1`, [project]))[0].owning_department_id, newDept);
    const kept = await transfer(c.admin, { departmentId: dept, reason: 'Back again', folderChoice: 'keep' });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.state, 'done');
    // The earlier route cannot skip the choice either.
    t.clock.advanceSeconds(60);
    const old = await c.admin.request('POST', `/projects/${project}/department`, { departmentId: newDept, reason: 'Again' });
    assert.equal(old.status, 400);
    assert.equal(old.body.message, "This project has filed outputs. Choose whether to move the project's folder or keep it where it is.");
  });

  test('move relocates both folders, keeps grants and item ids, refreshes paths', async () => {
    const wide = await registered('Weekly status');
    const narrow = await registered('Board briefing', [ids.pm, ids.ada]);
    const fw = await filed(wide);
    const fn = await filed(narrow);
    assert.equal(fw.path, `${OLD}/${PROJECT}/2026/Status reports/Weekly status v1.md`);
    assert.equal(fn.path, `${OLD}/${PROJECT} (restricted)/Board briefing/Board briefing v1.md`);
    const pf = (await folder('project', `${dept}/${project}`))!;
    const rr = (await folder('restricted_root', `${dept}/${project}/restricted`))!;
    const of = (await folder('output', `${dept}/${project}/output/${narrow}`))!;
    const grantsBefore = await rows(`SELECT id, folder_id, user_id, permission_id, state FROM storage_grants ORDER BY id`);
    const sharedBefore = [await sharedWith(pf.item_id), await sharedWith(of.item_id)];
    assert.ok(sharedBefore[0].length > 0 && sharedBefore[1].length > 0);

    const r = await transfer(c.admin, { departmentId: newDept, reason: 'Reorganised', folderChoice: 'move' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'moving');
    assert.equal((await c.admin.request('GET', transferUrl())).body.transfer.label, 'Moving files');
    assert.equal((await versionFiling(wide)).location, 'Moving files');
    // Nothing is described as moved yet.
    assert.equal((await fileRow(wide)).path, fw.path);

    // The provider moves the project folder but the answer is lost, and putting it back fails too: the next attempt
    // looks it up, finds it where it went, and neither moves it again nor makes another.
    fake.fault({ method: 'PATCH', pathIncludes: pf.item_id }, 'drop_after_body');
    fake.fault({ method: 'PATCH', pathIncludes: pf.item_id }, '500');
    const first = await drain();
    assert.equal(first.length, 1);
    assert.ok(first[0].failed, 'the lost answer fails the attempt');
    assert.equal((await rows(`SELECT state FROM project_department_transfers WHERE id = $1`, [r.body.transferId]))[0].state, 'moving');
    assert.equal((await fileRow(wide)).path, fw.path, 'nothing recorded as moved after a failed attempt');
    await t.pool.query(`INSERT INTO storage_outbox (id, job, subject_id, urgent, created_at) VALUES ($1, 'transfer-folders', $2, false, now())`, [uuidv7(), r.body.transferId]);
    assert.deepEqual((await drain()).map((x) => x.failed), [undefined]);
    assert.equal(fake.calls.filter((x) => x.method === 'PATCH' && x.path.includes(pf.item_id)).length, 2, 'the lost move and the failed put-back only');
    assert.equal((await rows(`SELECT state FROM project_department_transfers WHERE id = $1`, [r.body.transferId]))[0].state, 'done');

    // Both folders now sit in the new department's folder, keeping their item ids; no duplicate was made.
    const nd = (await folder('department', newDept))!;
    assert.equal(nd.name, NEW);
    assert.equal((await item(pf.item_id)).parentId, nd.item_id);
    assert.equal((await item(rr.item_id)).parentId, nd.item_id);
    assert.equal((await folder('project', `${newDept}/${project}`))!.item_id, pf.item_id);
    assert.equal((await folder('restricted_root', `${newDept}/${project}/restricted`))!.item_id, rr.item_id);
    assert.equal((await folder('output', `${newDept}/${project}/output/${narrow}`))!.item_id, of.item_id);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_folders WHERE key LIKE $1`, [`${dept}/%`]))[0].n, 0, 'no folder left keyed under the old department');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_folders WHERE level = 'project'`))[0].n, 1);

    // Item ids kept; paths refreshed to where the provider now has them; one move row per file.
    const aw = await fileRow(wide);
    const an = await fileRow(narrow);
    assert.deepEqual([aw.item_id, an.item_id], [fw.item_id, fn.item_id]);
    assert.equal(aw.path, `${NEW}/${PROJECT}/2026/Status reports/Weekly status v1.md`);
    assert.equal(an.path, `${NEW}/${PROJECT} (restricted)/Board briefing/Board briefing v1.md`);
    assert.equal(plain((await item(aw.item_id)).path), aw.path);
    assert.equal(plain((await item(an.item_id)).path), an.path);
    const moves = await rows(`SELECT stored_file_id, reason, old_item_id, new_item_id, old_path, new_path, actor_id FROM stored_file_moves ORDER BY old_path`);
    assert.deepEqual(moves.map((m) => [m.stored_file_id, m.reason, m.old_item_id === m.new_item_id, m.old_path, m.new_path, m.actor_id]), [
      [fw.id, 'Department transfer', true, fw.path, aw.path, ids.admin],
      [fn.id, 'Department transfer', true, fn.path, an.path, ids.admin],
    ]);

    // Grants are unchanged: the same Kainow rows and the same provider permissions on the same folder items.
    assert.deepEqual(await rows(`SELECT id, folder_id, user_id, permission_id, state FROM storage_grants ORDER BY id`), grantsBefore);
    assert.deepEqual([await sharedWith(pf.item_id), await sharedWith(of.item_id)], sharedBefore);

    // The register says nothing about a move any more, and new filings go to the moved folders.
    assert.equal((await versionFiling(wide)).location, undefined);
    assert.equal((await c.admin.request('GET', transferUrl())).body.transfer.label, null);
    const later = await registered('Monthly status');
    const fl = await filed(later);
    assert.equal(fl.path, `${NEW}/${PROJECT}/2026/Status reports/Monthly status v1.md`);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_folders WHERE level = 'project'`))[0].n, 1);
  });

  test('failure leaves the old paths and offers Try again', async () => {
    const wide = await registered('Weekly status');
    const narrow = await registered('Board briefing', [ids.pm, ids.ada]);
    const fw = await filed(wide);
    const fn = await filed(narrow);
    const od = (await folder('department', dept))!;
    const pf = (await folder('project', `${dept}/${project}`))!;
    const rr = (await folder('restricted_root', `${dept}/${project}/restricted`))!;
    const r = await transfer(c.admin, { departmentId: newDept, reason: 'Reorganised', folderChoice: 'move' });
    assert.equal(r.body.state, 'moving');

    // The project folder moves, then the (restricted) folder is refused: the project folder is put back.
    fake.fault({ method: 'PATCH', pathIncludes: rr.item_id }, '403');
    const ran = await drain();
    assert.deepEqual(ran.map((x) => [x.job, x.failed]), [['transfer-folders', 'forbidden']]);
    await onFinalFailure(deps(), 'transfer-folders', r.body.transferId, 'forbidden');
    assert.equal((await rows(`SELECT state FROM project_department_transfers WHERE id = $1`, [r.body.transferId]))[0].state, 'move_failed');
    assert.equal((await item(pf.item_id)).parentId, od.item_id);
    assert.equal((await item(rr.item_id)).parentId, od.item_id);
    assert.deepEqual([(await fileRow(wide)).path, (await fileRow(narrow)).path], [fw.path, fn.path]);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_file_moves`))[0].n, 0);
    assert.ok(await folder('project', `${dept}/${project}`), 'records keep the old department');
    const view = (await c.admin.request('GET', transferUrl())).body;
    assert.equal(view.transfer.state, 'move_failed');
    assert.equal(view.transfer.label, `Files not moved — still at ${OLD}/${PROJECT}`);
    assert.equal(view.transfer.tryAgain, true);
    assert.equal((await versionFiling(wide)).location, `Kept at its existing location (filed under ${OLD})`);

    // Filing meanwhile goes into the folder that is still where it was, so it moves with the rest.
    const later = await registered('Monthly status');
    const fl = await filed(later);
    assert.equal(fl.path, `${OLD}/${PROJECT}/2026/Status reports/Monthly status v1.md`);

    // Try again: Enterprise Administrator only.
    assert.equal((await c.pm.request('POST', `${transferUrl()}/retry`)).status, 403);
    const again = await c.admin.request('POST', `${transferUrl()}/retry`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body, { transferId: r.body.transferId, state: 'moving' });
    assert.equal((await c.admin.request('POST', `${transferUrl()}/retry`)).status, 409, 'nothing to try again while moving');
    assert.deepEqual((await drain()).map((x) => x.failed), [undefined]);
    assert.equal((await rows(`SELECT state FROM project_department_transfers WHERE id = $1`, [r.body.transferId]))[0].state, 'done');
    assert.equal((await fileRow(wide)).path, `${NEW}/${PROJECT}/2026/Status reports/Weekly status v1.md`);
    assert.equal((await fileRow(later)).path, `${NEW}/${PROJECT}/2026/Status reports/Monthly status v1.md`);
    assert.equal((await fileRow(narrow)).path, `${NEW}/${PROJECT} (restricted)/Board briefing/Board briefing v1.md`);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM stored_file_moves`))[0].n, 3);
  });

  test('keep labels filed outputs and files new ones under the new department', async () => {
    const out = await registered('Weekly status');
    const f = await filed(out);
    const pf = (await folder('project', `${dept}/${project}`))!;
    const r = await transfer(c.admin, { departmentId: newDept, reason: 'Reorganised', folderChoice: 'keep' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'done');
    assert.deepEqual(await rows(`SELECT job FROM storage_outbox WHERE sent_at IS NULL AND job = 'transfer-folders'`), []);
    const kept = `Kept at its existing location (filed under ${OLD})`;
    assert.equal((await versionFiling(out)).location, kept);
    assert.equal((await c.admin.request('GET', transferUrl())).body.transfer.label, kept);
    assert.equal((await fileRow(out)).path, f.path);
    assert.equal((await item(pf.item_id)).parentId, (await folder('department', dept))!.item_id);

    // A new output is filed under the new department, in a project folder of its own there, shared like the first.
    const later = await registered('Monthly status');
    const fl = await filed(later);
    assert.equal(fl.path, `${NEW}/${PROJECT}/2026/Status reports/Monthly status v1.md`);
    const npf = (await folder('project', `${newDept}/${project}`))!;
    assert.notEqual(npf.item_id, pf.item_id);
    assert.equal((await versionFiling(later)).location, undefined);
    assert.deepEqual(await granted(npf.id), await granted(pf.id));
    assert.ok((await granted(npf.id)).includes('ada@example.org'));
  });

  test('history shows the old department, reason and choice', async () => {
    const out = await registered('Weekly status');
    await filed(out);
    assert.equal((await transfer(c.admin, { departmentId: newDept, reason: 'Reorganised', folderChoice: 'keep' })).status, 200);
    const h = await c.ada.request('GET', `/projects/${project}/history/deletions`);
    assert.equal(h.status, 200);
    const line = h.body.lines.find((l: { kind: string }) => l.kind === 'department_transfer');
    assert.ok(line, JSON.stringify(h.body));
    assert.equal(line.action, 'transferred');
    assert.equal(line.reason, 'Reorganised');
    assert.equal(line.fromDepartment, OLD);
    assert.equal(line.toDepartment, NEW);
    assert.equal(line.folderChoice, 'keep');
    assert.ok(line.actor);
  });

  test('leadership department scope follows the new owner', async () => {
    const grant = uuidv7();
    await t.pool.query(
      `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, reason, granted_by, granted_at) VALUES ($1, $2, 'departments', '2026-11-01', 'Oversight', $3, now())`,
      [grant, ids.lea, ids.admin],
    );
    await t.pool.query(`INSERT INTO leadership_grant_departments (grant_id, department_id) VALUES ($1, $2)`, [grant, newDept]);
    const scope = () => leadershipProjectIds(t.pool, ids.lea, todayUtc8(t.clock.now()));
    assert.deepEqual(await scope(), []);
    assert.equal((await transfer(c.admin, { departmentId: newDept, reason: 'Reorganised' })).status, 200);
    assert.deepEqual(await scope(), [project]);
  });

  test('contributor attribution is unchanged', async () => {
    const helper = await seedDepartment(t.pool, 'Facilities');
    await t.pool.query(`INSERT INTO project_departments (project_id, department_id) VALUES ($1, $2)`, [project, helper]);
    const out = await registered('Weekly status', undefined, { contributors: { people: [{ userId: ids.ada, departmentId: dept }], departmentIds: [helper] } });
    const before = await rows(`SELECT user_id, department_id, added_at FROM output_contributors WHERE output_id = $1 ORDER BY user_id NULLS LAST, department_id`, [out]);
    assert.equal(before.length, 2);
    const contributing = await rows(`SELECT department_id FROM project_departments WHERE project_id = $1 ORDER BY department_id`, [project]);
    const refused = await transfer(c.admin, { departmentId: helper, reason: 'Reorganised' });
    assert.equal(refused.status, 409, 'a contributing department is removed from the contributors first');
    assert.equal((await transfer(c.admin, { departmentId: newDept, reason: 'Reorganised' })).status, 200);
    assert.deepEqual(await rows(`SELECT user_id, department_id, added_at FROM output_contributors WHERE output_id = $1 ORDER BY user_id NULLS LAST, department_id`, [out]), before);
    assert.deepEqual(await rows(`SELECT department_id FROM project_departments WHERE project_id = $1 ORDER BY department_id`, [project]), contributing);
    const o = (await c.pm.request('GET', url(`/${out}`))).body;
    assert.deepEqual(o.contributors.people.map((p: { id: string; departmentId: string }) => [p.id, p.departmentId]), [[ids.ada, dept]]);
  });
});
