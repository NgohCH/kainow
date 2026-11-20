import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { startFakeGraph, type FakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { keyFile } from '../testing/ai-connections';
import { DbStorageConnectorFactory, STORAGE_CONNECTORS, StorageWaitingForKey } from './connector-factory';
import { libraryPermissionProblems } from './destinations.service';
import { StorageSettingsService } from './settings.service';
import { StorageError, type PermissionInfo } from './types';

const SECRET = 'client-secret-test-value-AAAA-0123456789';
const APP_ID = 'client-1';
const reason = 'Setting up storage';
const SITE = 'https://tenant.example.org/sites/outputs';
const EXACT = (who: string) => `Others can open everything in this library: ${who}. Limit the library to site owners before approving it.`;

describe('storage destinations over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let admin: Client;
  let adminId: string;
  let fake: FakeGraph;
  let factory: DbStorageConnectorFactory;
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;

  /** A library limited to its owners group and Kainow's own application. */
  const library = (name = 'Project Outputs', site = SITE) => {
    const d = fake.addDrive({ siteUrl: site, libraryName: name });
    fake.seedPermission(d.driveId, d.rootItemId, { kind: 'owner_group', principal: `${name} Owners`, roles: ['owner'] });
    fake.seedPermission(d.driveId, d.rootItemId, { kind: 'app', principal: APP_ID, roles: ['owner'] });
    return d;
  };
  const addLibrary = (body: Record<string, unknown> = {}) =>
    admin.request('POST', '/admin/storage/destinations', {
      kind: 'sharepoint_library', purpose: 'outputs', label: 'Outputs library', siteUrl: SITE, libraryName: 'Project Outputs', reason, ...body,
    });
  const approve = (id: string, why: unknown = 'Approved after the check') => admin.request('POST', `/admin/storage/destinations/${id}/approve`, why === null ? {} : { reason: why });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-dest-'));
    t = await startTestApp(undefined, { protectedKeyFile: keyFile(dir) });
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.org', $2, now())`, [uuidv7(), adminId]);
    admin = await t.signIn('admin@example.org');
    fake = await startFakeGraph();
    fake.addUser('admin@example.org');
    factory = t.app.get<DbStorageConnectorFactory>(STORAGE_CONNECTORS);
    factory.fetchFn = fake.fetch;
    t.app.get(StorageSettingsService).fetchFn = fake.fetch;
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, tenantId: 'tenant-1', clientId: APP_ID })).status, 200);
    assert.equal((await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: SECRET })).status, 200);
  });
  afterEach(async () => {
    await fake?.close();
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('adding a SharePoint library resolves its ids and runs the check', async () => {
    const d = library();
    const res = await addLibrary();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'proposed');
    assert.equal(res.body.kind, 'sharepoint_library');
    assert.equal(res.body.lastCheck.ok, true, JSON.stringify(res.body.lastCheck));
    assert.deepEqual(res.body.lastCheck.lines.map((l: { key: string }) => l.key),
      ['reachable', 'folder', 'upload', 'delete', 'permissions', 'library_permissions', 'sharing_capability']);
    const [row] = await rows(`SELECT drive_id, root_item_id, site_id, created_by FROM storage_destinations WHERE id = $1`, [res.body.id]);
    assert.equal(row.drive_id, d.driveId);
    assert.equal(row.root_item_id, d.rootItemId);
    assert.equal(row.site_id, d.siteId);
    assert.equal(row.created_by, adminId);
    assert.equal(fake.invites.length, 1, 'the permission line really invited the checking Administrator');
    assert.equal((fake.invites[0].body as { recipients: Array<{ email: string }> }).recipients[0].email, 'admin@example.org');
    // an unknown library is refused with a clear message
    const missing = await addLibrary({ libraryName: 'No Such Library' });
    assert.equal(missing.status, 400);
    assert.match(missing.body.message, /not found/);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_destinations`))[0].n, 1);
  });

  test('only an Enterprise Administrator uses the destination endpoints; the list is ordered by purpose and name', async () => {
    await seedUser(t.pool, 'member@example.org');
    const member = await t.signIn('member@example.org');
    assert.equal((await member.request('GET', '/admin/storage/destinations')).status, 403);
    assert.equal((await member.request('POST', '/admin/storage/destinations', {})).status, 403);
    library('Project Outputs');
    library('Archive Library');
    assert.equal((await addLibrary({ label: 'zeta' })).status, 201);
    assert.equal((await addLibrary({ label: 'Alpha' })).status, 201);
    assert.equal((await addLibrary({ label: 'Source', purpose: 'source_area', libraryName: 'Archive Library' })).status, 201);
    const list = await admin.request('GET', '/admin/storage/destinations');
    assert.deepEqual(list.body.map((d: { label: string }) => d.label), ['Alpha', 'zeta', 'Source']);
    assert.equal((await addLibrary({ reason: ' ' })).status, 400);
    assert.equal((await addLibrary({ purpose: 'elsewhere' })).status, 400);
  });

  test('OneDrive destinations are refused while directory lookup is off', async () => {
    fake.addUser('admin@example.org');
    fake.addUser('owner@example.org');
    fake.addDrive({ ownerEmail: 'owner@example.org' });
    const body = { kind: 'onedrive', purpose: 'outputs', label: 'Shared drive', accountEmail: 'owner@example.org', reason };
    const refused = await admin.request('POST', '/admin/storage/destinations', body);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /directory lookup/i);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_destinations`))[0].n, 0);

    assert.equal((await admin.request('PUT', '/admin/storage', { reason, directoryLookup: true })).status, 200);
    const ok = await admin.request('POST', '/admin/storage/destinations', body);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.accountEmail, 'owner@example.org');
  });

  test('approving a OneDrive destination re-checks directory lookup and turning lookup off is then refused', async () => {
    fake.addUser('admin@example.org');
    fake.addUser('owner@example.org');
    fake.addDrive({ ownerEmail: 'owner@example.org' });
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, directoryLookup: true })).status, 200);
    const added = await admin.request('POST', '/admin/storage/destinations', { kind: 'onedrive', purpose: 'outputs', label: 'Shared drive', accountEmail: 'owner@example.org', reason });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    // lookup goes off before approval: the approval's own transaction sees it
    await t.pool.query(`UPDATE storage_settings SET directory_lookup = false`);
    const refused = await approve(added.body.id);
    assert.equal(refused.status, 409);
    assert.equal((await rows(`SELECT status FROM storage_destinations`))[0].status, 'proposed');
    await t.pool.query(`UPDATE storage_settings SET directory_lookup = true`);
    // the pool-level race: approval and turn-off together never leave an approved OneDrive with lookup off
    const results = await Promise.all([
      approve(added.body.id),
      admin.request('PUT', '/admin/storage', { reason, directoryLookup: false }),
    ]);
    const [{ status }] = await rows(`SELECT status FROM storage_destinations`);
    const [{ directory_lookup: lookup }] = await rows(`SELECT directory_lookup FROM storage_settings`);
    assert.ok(!(status === 'approved' && lookup === false), `approved OneDrive with lookup off: ${results.map((r) => r.status)}`);
  });

  test('a OneDrive account may open its own drive; another named user may not', async () => {
    fake.addUser('admin@example.org');
    fake.addUser('owner@example.org');
    const od = fake.addDrive({ ownerEmail: 'owner@example.org' });
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, directoryLookup: true })).status, 200);
    const body = { kind: 'onedrive', purpose: 'outputs', label: 'Shared drive', accountEmail: 'Owner@Example.org', reason };
    const added = await admin.request('POST', '/admin/storage/destinations', body);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.lastCheck.ok, true, JSON.stringify(added.body.lastCheck));
    assert.equal((await approve(added.body.id)).status, 200);
    fake.seedPermission(od.driveId, od.rootItemId, { kind: 'user', principal: 'other@example.org', roles: ['read'] });
    const again = await admin.request('POST', `/admin/storage/destinations/${added.body.id}/check`);
    assert.equal(again.body.ok, false);
    assert.equal(again.body.lines.find((l: { key: string }) => l.key === 'library_permissions').detail, EXACT('other@example.org'));
  });

  test('a database failure during a check is an error, not a failed check', async () => {
    library();
    const added = await addLibrary();
    await t.pool.query(`ALTER TABLE storage_destination_events RENAME TO sde_tmp`);
    const res = await admin.request('POST', `/admin/storage/destinations/${added.body.id}/check`);
    await t.pool.query(`ALTER TABLE sde_tmp RENAME TO storage_destination_events`);
    assert.equal(res.status, 500);
  });

  test('approval requires a passing check and a reason', async () => {
    library();
    const added = await addLibrary();
    assert.equal(added.status, 201);
    assert.equal((await approve(added.body.id, null)).status, 400);
    assert.equal((await approve(added.body.id, '   ')).status, 400);
    assert.equal((await rows(`SELECT status FROM storage_destinations`))[0].status, 'proposed');
    // a check that does not pass blocks approval
    fake.fault({ method: 'PUT', pathIncludes: '/content' }, '403', 50);
    const failing = await admin.request('POST', `/admin/storage/destinations/${added.body.id}/check`);
    assert.equal(failing.status, 200);
    assert.equal(failing.body.ok, false);
    const blocked = await approve(added.body.id);
    assert.equal(blocked.status, 409);
    assert.equal((await rows(`SELECT status FROM storage_destinations`))[0].status, 'proposed');
    assert.equal((await approve('not-an-id')).status, 404);
  });

  test('a passing check lets the Administrator approve with a reason', async () => {
    library();
    const added = await addLibrary();
    const ok = await approve(added.body.id, 'The library is limited to site owners');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'approved');
    assert.equal((await approve(added.body.id)).status, 409, 'already approved');
  });

  test('a library readable by others is refused with the exact text', async () => {
    const cases: Array<[string, Omit<PermissionInfo, 'id'>, string]> = [
      ['a Members group', { kind: 'group', principal: 'Project Outputs Members', roles: ['write'] }, 'Project Outputs Members'],
      ['a named user', { kind: 'user', principal: 'reader@example.org', roles: ['read'] }, 'reader@example.org'],
      ['an organisation sharing link', { kind: 'link', principal: 'organization', roles: ['read'] }, 'organization'],
    ];
    for (const [i, [what, perm, who]] of cases.entries()) {
      const d = library(`Library ${i}`);
      fake.seedPermission(d.driveId, d.rootItemId, perm);
      const added = await addLibrary({ label: `Library ${i}`, libraryName: `Library ${i}` });
      assert.equal(added.status, 201);
      assert.equal(added.body.lastCheck.ok, false, what);
      assert.equal(added.body.lastCheck.lines.find((l: { key: string }) => l.key === 'library_permissions').detail, EXACT(who), what);
      const refused = await approve(added.body.id);
      assert.equal(refused.status, 409, what);
      assert.equal(refused.body.message, EXACT(who), what);
      assert.equal((await rows(`SELECT status FROM storage_destinations WHERE id = $1`, [added.body.id]))[0].status, 'proposed');
    }
    // the owners group and the application alone pass
    library('Clean Library');
    const clean = await addLibrary({ label: 'Clean', libraryName: 'Clean Library' });
    assert.equal(clean.body.lastCheck.ok, true);
    assert.equal((await approve(clean.body.id)).status, 200);
  });

  test('libraryPermissionProblems lets through owners, site administrators, the application and Kainow grants only', () => {
    const p = (id: string, kind: PermissionInfo['kind'], principal: string): PermissionInfo => ({ id, kind, principal, roles: ['read'] });
    const perms = [
      p('1', 'owner_group', 'Owners'), p('2', 'site_admin', 'admin@example.org'), p('3', 'app', 'Kainow'),
      p('4', 'other_app', 'other'), p('5', 'group', 'Members'), p('6', 'link', 'anonymous'),
      p('7', 'user', 'person@example.org'), p('8', 'user', 'Storage.Admin@example.org'), p('9', 'user', 'granted@example.org'),
    ];
    const none = { storageAdminUserEmails: [], kainowGrantPermissionIds: new Set<string>() };
    assert.deepEqual(libraryPermissionProblems(perms, none).map((x) => x.id), ['4', '5', '6', '7', '8', '9']);
    assert.deepEqual(libraryPermissionProblems(perms.slice(0, 3), none), []);
    const allowed = { storageAdminUserEmails: ['storage.admin@example.org'], kainowGrantPermissionIds: new Set(['9']) };
    assert.deepEqual(libraryPermissionProblems(perms, allowed).map((x) => x.id), ['4', '5', '6', '7']);
  });

  test('a storage Administrator may read a source area but not an outputs library', async () => {
    const storageAdmin = await seedUser(t.pool, 'storage.admin@example.org');
    await t.pool.query(
      `INSERT INTO storage_admins (id, user_id, designated_by, designated_at, reason) VALUES ($1, $2, $3, now(), 'Looks after sources')`,
      [uuidv7(), storageAdmin, adminId],
    );
    const src = library('Source Library');
    fake.seedPermission(src.driveId, src.rootItemId, { kind: 'user', principal: 'storage.admin@example.org', roles: ['write'] });
    const out = library('Output Library');
    fake.seedPermission(out.driveId, out.rootItemId, { kind: 'user', principal: 'storage.admin@example.org', roles: ['write'] });
    const source = await addLibrary({ purpose: 'source_area', label: 'Source', libraryName: 'Source Library' });
    assert.equal(source.body.lastCheck.ok, true, JSON.stringify(source.body.lastCheck));
    const outputs = await addLibrary({ label: 'Outputs', libraryName: 'Output Library' });
    assert.equal(outputs.body.lastCheck.ok, false);
    assert.equal((await approve(outputs.body.id)).body.message, EXACT('storage.admin@example.org'));
  });

  test('only one approved source area', async () => {
    library('Source One');
    library('Source Two');
    const a = await addLibrary({ purpose: 'source_area', label: 'One', libraryName: 'Source One' });
    const b = await addLibrary({ purpose: 'source_area', label: 'Two', libraryName: 'Source Two' });
    assert.equal((await approve(a.body.id)).status, 200);
    const second = await approve(b.body.id);
    assert.equal(second.status, 409);
    assert.match(second.body.message, /source area is already approved/);
    // two outputs destinations may both be approved
    library('Out One');
    library('Out Two');
    const o1 = await addLibrary({ label: 'O1', libraryName: 'Out One' });
    const o2 = await addLibrary({ label: 'O2', libraryName: 'Out Two' });
    assert.equal((await approve(o1.body.id)).status, 200);
    assert.equal((await approve(o2.body.id)).status, 200);
    // withdrawing the first source area frees the place
    assert.equal((await admin.request('POST', `/admin/storage/destinations/${a.body.id}/withdraw`, { reason: 'Moving' })).status, 200);
    assert.equal((await approve(b.body.id)).status, 200);
  });

  test('withdrawing keeps stored files and their references', async () => {
    library();
    const added = await addLibrary();
    assert.equal((await approve(added.body.id)).status, 200);
    const projectId = await seedProject(t.pool, { status: 'active', members: [{ userId: adminId, role: 'pm' }] });
    const fileId = uuidv7();
    await t.pool.query(
      `INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, name, state, created_at)
       VALUES ($1, 'output', $2, $3, 'graph', 'd', 'i', 'Report v1.pdf', 'stored', now())`,
      [fileId, projectId, added.body.id],
    );
    assert.equal((await admin.request('POST', `/admin/storage/destinations/${added.body.id}/withdraw`, {})).status, 400, 'a reason is needed');
    const w = await admin.request('POST', `/admin/storage/destinations/${added.body.id}/withdraw`, { reason: 'Library retired' });
    assert.equal(w.status, 200);
    assert.equal(w.body.status, 'withdrawn');
    const [file] = await rows(`SELECT destination_id, state, item_id FROM stored_files WHERE id = $1`, [fileId]);
    assert.deepEqual(file, { destination_id: added.body.id, state: 'stored', item_id: 'i' });
    assert.equal((await admin.request('POST', `/admin/storage/destinations/${added.body.id}/withdraw`, { reason: 'Again' })).status, 409);
  });

  test('events are recorded for proposed, checked, approved and withdrawn', async () => {
    library();
    const added = await addLibrary();
    t.clock.advanceSeconds(1);
    await admin.request('POST', `/admin/storage/destinations/${added.body.id}/check`);
    t.clock.advanceSeconds(1);
    await approve(added.body.id, 'Checked and fine');
    t.clock.advanceSeconds(1);
    await admin.request('POST', `/admin/storage/destinations/${added.body.id}/withdraw`, { reason: 'Retired' });
    const ev = await rows(`SELECT kind, actor_id, reason, detail FROM storage_destination_events WHERE destination_id = $1 ORDER BY at, id`, [added.body.id]);
    const kinds = ev.map((e) => e.kind);
    assert.equal(kinds[0], 'proposed');
    assert.deepEqual([...new Set(kinds)].sort(), ['approved', 'checked', 'proposed', 'withdrawn']);
    assert.equal(kinds.at(-1), 'withdrawn');
    assert.ok(ev.every((e) => e.actor_id === adminId));
    assert.equal(ev[0].reason, reason);
    assert.equal(ev.find((e) => e.kind === 'approved').reason, 'Checked and fine');
    assert.equal(ev.find((e) => e.kind === 'checked').detail.ok, true);
    assert.equal(JSON.stringify(ev).includes(SECRET), false);
  });

  test('the local connector is never offered when NODE_ENV is production', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'kainow-local-dest-'));
    const env = { node: process.env.NODE_ENV, dir: process.env.KAINOW_LOCAL_STORAGE_DIR };
    try {
      process.env.KAINOW_LOCAL_STORAGE_DIR = localDir;
      process.env.NODE_ENV = 'production';
      await assert.rejects(factory.forNew('local'), (e) => e instanceof StorageError && e.code === 'invalid');
      const refused = await admin.request('POST', '/admin/storage/destinations', { kind: 'local', purpose: 'outputs', label: 'Local', reason });
      assert.equal(refused.status, 400);
      assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_destinations`))[0].n, 0);

      process.env.NODE_ENV = 'development';
      delete process.env.KAINOW_LOCAL_STORAGE_DIR;
      assert.equal((await admin.request('POST', '/admin/storage/destinations', { kind: 'local', purpose: 'outputs', label: 'Local', reason })).status, 400, 'no folder set');

      process.env.KAINOW_LOCAL_STORAGE_DIR = localDir;
      const added = await admin.request('POST', '/admin/storage/destinations', { kind: 'local', purpose: 'outputs', label: 'Local', reason });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      assert.equal(added.body.connector, 'local');
      assert.equal(added.body.lastCheck.ok, true, JSON.stringify(added.body.lastCheck));
      const { connector, dest } = await factory.forDestination(added.body.id);
      assert.equal(connector.kind, 'local');
      assert.equal(dest.connector, 'local');
    } finally {
      if (env.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env.node;
      if (env.dir === undefined) delete process.env.KAINOW_LOCAL_STORAGE_DIR; else process.env.KAINOW_LOCAL_STORAGE_DIR = env.dir;
      rmSync(localDir, { recursive: true, force: true });
    }
  });
});

describe('connector factory without credentials', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  afterEach(async () => {
    await t?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('forNew throws invalid when storage is not configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-dest-'));
    t = await startTestApp(undefined, { protectedKeyFile: keyFile(dir) });
    const factory = t.app.get<DbStorageConnectorFactory>(STORAGE_CONNECTORS);
    await assert.rejects(factory.forNew('sharepoint_library'), (e) => e instanceof StorageError && e.code === 'invalid');
    await assert.rejects(factory.forDestination(uuidv7()), (e) => e instanceof StorageError && e.code === 'invalid');
  });

  test('adding a destination without the protected key writes nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-dest-'));
    t = await startTestApp(undefined, {});
    const adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`UPDATE storage_settings SET tenant_id = 't', client_id = 'c'`);
    await t.pool.query(
      `INSERT INTO storage_connection_secrets (id, ciphertext, nonce, tag, key_id, saved_by, saved_at) VALUES ($1, $3, $3, $3, 'k', $2, now())`,
      [uuidv7(), adminId, Buffer.from([0])],
    );
    const admin = await t.signIn('admin@example.org');
    const res = await admin.request('POST', '/admin/storage/destinations', {
      kind: 'sharepoint_library', purpose: 'outputs', label: 'L', siteUrl: SITE, libraryName: 'Docs', reason,
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /protected key/);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM storage_destinations`)).rows[0].n, 0);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM storage_destination_events`)).rows[0].n, 0);
  });

  test('a saved secret without the protected key makes storage wait for the key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-dest-'));
    t = await startTestApp(undefined, {});
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`UPDATE storage_settings SET tenant_id = 't', client_id = 'c'`);
    await t.pool.query(
      `INSERT INTO storage_connection_secrets (id, ciphertext, nonce, tag, key_id, saved_by, saved_at)
       VALUES ($1, '\\x00', '\\x00', '\\x00', 'k', (SELECT id FROM users LIMIT 1), now())`,
      [uuidv7()],
    );
    const factory = t.app.get<DbStorageConnectorFactory>(STORAGE_CONNECTORS);
    await assert.rejects(factory.forNew('sharepoint_library'), (e) => e instanceof StorageWaitingForKey);
  });
});
