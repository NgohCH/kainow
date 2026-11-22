import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { M365TokenSource } from '../email/m365-token';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import type { StorageConnectorFactory } from './connector-factory';
import { GraphConnector } from './connectors/graph';
import { DESTINATION_LIBRARY_OPEN, PROJECT_LIBRARY_WARNING, dailyDestinationLibrary } from './destination-library';
import type { StorageDeps } from './jobs';
import { makeStorageNotify } from './notices';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';

describe('daily output-library permission check', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let fake: FakeGraph;
  let connector: GraphConnector;
  let drive: { driveId: string; rootItemId: string };
  let destId: string;
  let project: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => ({ connector, dest: { id, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId } }),
    forNew: async () => connector,
  };
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now) });
  const notices = async () =>
    (await t.pool.query(`SELECT user_id, summary, link FROM notifications WHERE kind = $1 ORDER BY user_id, created_at, id`, [DESTINATION_LIBRARY_OPEN])).rows;
  const storagePageWarning = async () => {
    const r = await c.admin.request('GET', '/admin/storage/summary');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.destinations.find((d: { id: string }) => d.id === destId).lastCheck?.libraryWarning ?? null;
  };
  const projectWarning = async () => {
    const r = await c.pm.request('GET', `/projects/${project}/output-settings`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.destination.libraryWarning;
  };

  beforeEach(async () => {
    fake = await startFakeGraph();
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    connector = new GraphConnector(tokens, { fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: true, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
    drive = fake.addDrive();
    t = await startTestApp(undefined, { storageConnectors: factory });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    ids.pm = await seedUser(t.pool, 'pm@example.org');
    destId = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at, last_check)
       VALUES ($1, 'graph', 'sharepoint_library', 'outputs', 'Outputs library', $2, $3, 'approved', $4, now(), '{"ok":true,"lines":[],"quotaBytes":null,"usedBytes":null,"others":[]}')`,
      [destId, drive.driveId, drive.rootItemId, ids.admin],
    );
    project = await seedProject(t.pool, { status: 'active', name: 'Pump station renewal', members: [{ userId: ids.pm, role: 'pm' }] });
    await t.pool.query(`INSERT INTO project_output_settings (project_id, destination_id) VALUES ($1, $2)`, [project, destId]);
    fake.seedPermission(drive.driveId, drive.rootItemId, { kind: 'owner_group', principal: 'Outputs Owners', roles: ['owner'] });
    fake.seedPermission(drive.driveId, drive.rootItemId, { kind: 'app', principal: APP_ID, roles: ['owner'] });
    for (const k of ['admin', 'pm']) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  test('a library limited to site owners and Kainow raises nothing', async () => {
    await dailyDestinationLibrary(deps());
    assert.deepEqual(await notices(), []);
    assert.equal(await storagePageWarning(), null);
    assert.equal(await projectWarning(), null);
  });

  test('a library opened to others after approval gives one notice per new problem and the warnings, never removing anything', async () => {
    fake.seedPermission(drive.driveId, drive.rootItemId, { kind: 'group', principal: 'Outputs Members', roles: ['read'] });
    const before = fake.calls.length;
    await dailyDestinationLibrary(deps());
    assert.equal(fake.calls.slice(before).filter((x) => x.method === 'DELETE').length, 0, 'nothing is removed');
    const first = await notices();
    assert.equal(first.length, 1, 'one notice to the one Administrator');
    assert.equal(first[0].user_id, ids.admin);
    assert.equal(first[0].summary, 'Others can open everything in the output library "Outputs library": Outputs Members. Limit the library to site owners.');
    assert.equal(await storagePageWarning(), 'Others can open everything in this library: Outputs Members. Limit the library to site owners.');
    assert.equal(await projectWarning(), PROJECT_LIBRARY_WARNING);

    // The same problem at the next daily check: no new notice.
    await dailyDestinationLibrary(deps());
    assert.equal((await notices()).length, 1);

    // A further problem: one more notice, naming it.
    t.clock.advanceMinutes(1);
    fake.seedPermission(drive.driveId, drive.rootItemId, { kind: 'link', principal: 'Anyone link', roles: ['read'] });
    await dailyDestinationLibrary(deps());
    const later = await notices();
    assert.equal(later.length, 2);
    assert.equal(later[1].summary, 'Others can open everything in the output library "Outputs library": a sharing link. Limit the library to site owners.');
    assert.equal(await storagePageWarning(), 'Others can open everything in this library: a sharing link, Outputs Members. Limit the library to site owners.');
  });
});
