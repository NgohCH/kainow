import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { M365TokenSource } from '../email/m365-token';
import { SKIP_NO_DB } from '../testing/db';
import { type FakeGraph, startFakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';
import { dailySourceAreaAccess, sourceAreaOthers } from './admins.service';
import type { StorageConnectorFactory } from './connector-factory';
import { GraphConnector } from './connectors/graph';
import { type StorageDeps, storageHandler } from './jobs';
import { makeStorageNotify } from './notices';
import type { DestinationRef } from './types';
import '../outputs/sharing';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';

describe('storage Administrators', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let fake: FakeGraph;
  let connector: GraphConnector;
  let drive: { driveId: string; rootItemId: string };
  let destId: string;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  const factory: StorageConnectorFactory = {
    forDestination: async (id) => ({ connector, dest: { id, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId } }),
    forNew: async () => connector,
  };
  const dest = (): DestinationRef => ({ id: destId, connector: 'graph', driveId: drive.driveId, rootItemId: drive.rootItemId });
  const deps = (): StorageDeps => ({ pool: t.pool, connectors: factory, key: null, clock: t.clock.now, notify: makeStorageNotify(t.pool, t.clock.now) });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;

  /** Runs the queued storage work as the worker would, until none is left. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const next = (
        await rows(`UPDATE storage_outbox SET sent_at = now() WHERE id = (SELECT id FROM storage_outbox WHERE sent_at IS NULL ORDER BY urgent DESC, created_at, id LIMIT 1) RETURNING job, subject_id`)
      )[0];
      if (!next) return;
      await storageHandler(next.job)!(deps(), next.subject_id, 1);
    }
    throw new Error('the outbox did not drain');
  }
  const sourceFolder = async () => (await rows(`SELECT id, item_id FROM storage_folders WHERE level = 'source_root' AND key = 'projects'`))[0] as { id: string; item_id: string } | undefined;
  const sharedWith = async (itemId: string) =>
    (await connector.listPermissions(dest(), itemId)).filter((p) => p.kind === 'user').map((p) => `${p.principal}:${p.roles.join('+')}`).sort();
  const designate = (who: string, reason = 'Looks after the source files') => c.admin.request('POST', '/admin/storage/admins', { userId: ids[who], reason });

  beforeEach(async () => {
    fake = await startFakeGraph();
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'test-secret-value' }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    connector = new GraphConnector(tokens, { fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: true, allowedDomains: async () => ['example.org'], appClientId: APP_ID });
    drive = fake.addDrive();
    t = await startTestApp(undefined, { storageConnectors: factory });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    ids.admin2 = await seedUser(t.pool, 'admin2@example.org', 'enterprise_administrator');
    for (const k of ['carol', 'bob', 'dave']) {
      ids[k] = await seedUser(t.pool, `${k}@example.org`);
      fake.addUser(`${k}@example.org`);
    }
    destId = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at, last_check)
       VALUES ($1, 'graph', 'sharepoint_library', 'source_area', 'Sources', $2, $3, 'approved', $4, now(), '{"ok":true,"lines":[],"quotaBytes":null,"usedBytes":null,"others":[]}')`,
      [destId, drive.driveId, drive.rootItemId, ids.admin],
    );
    for (const k of ['admin', 'admin2', 'bob']) c[k] = await t.signIn(`${k}@example.org`);
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  test('an Enterprise Administrator designates another active person with a reason; not themselves', async () => {
    const mine = await c.admin.request('POST', '/admin/storage/admins', { userId: ids.admin, reason: 'Me' });
    assert.equal(mine.status, 400);
    assert.match(JSON.stringify(mine.body), /cannot make yourself/);
    assert.equal((await c.admin.request('POST', '/admin/storage/admins', { userId: ids.bob })).status, 400, 'a reason is needed');
    assert.equal((await c.admin.request('POST', '/admin/storage/admins', { userId: 'nope', reason: 'x' })).status, 400);
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ids.dave]);
    assert.equal((await designate('dave')).status, 400, 'only an active account');
    assert.equal((await c.bob.request('POST', '/admin/storage/admins', { userId: ids.carol, reason: 'x' })).status, 403, 'members cannot designate');

    const ok = await designate('bob');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await designate('bob')).status, 409, 'already designated');
    // A second Enterprise Administrator may designate the first.
    assert.equal((await c.admin2.request('POST', '/admin/storage/admins', { userId: ids.admin, reason: 'Second pair of hands' })).status, 201);
    const audit = await rows(`SELECT action, actor_user_id, detail FROM audit_events WHERE action = 'storage.admin_designated' ORDER BY occurred_at, id`);
    assert.equal(audit.length, 2);
    assert.equal(audit[0].detail.userId, ids.bob);
    const list = await c.admin.request('GET', '/admin/storage/admins');
    assert.deepEqual(list.body.admins.map((a: { displayName: string }) => a.displayName), ['admin', 'bob']);
    assert.equal(list.body.admins[1].reason, 'Looks after the source files');
  });

  test('designation grants write on the source-area folder; ending or account disable revokes it', async () => {
    assert.equal((await designate('bob')).status, 201);
    await drain();
    const f = await sourceFolder();
    assert.ok(f, 'the source-area folder is recorded');
    assert.notEqual(f.item_id, drive.rootItemId, 'never the library root');
    assert.deepEqual(await sharedWith(f.item_id), ['bob@example.org:write']);
    assert.deepEqual(fake.invites.map((i) => [i.itemId, (i.body as { roles: string[] }).roles]), [[f.item_id, ['write']]]);
    assert.deepEqual((await rows(`SELECT role, state FROM storage_grants WHERE folder_id = $1`, [f.id])).map((r) => `${r.role}:${r.state}`), ['write:granted']);
    assert.equal((await c.admin.request('GET', '/admin/storage/admins')).body.admins[0].access, 'granted');

    // Ending revokes.
    const id = (await rows(`SELECT id FROM storage_admins WHERE user_id = $1`, [ids.bob]))[0].id;
    assert.equal((await c.admin.request('POST', `/admin/storage/admins/${id}/end`, {})).status, 400, 'a reason is needed');
    assert.equal((await c.admin.request('POST', `/admin/storage/admins/${id}/end`, { reason: 'Moved to another team' })).status, 200);
    assert.equal((await c.admin.request('POST', `/admin/storage/admins/${id}/end`, { reason: 'again' })).status, 409);
    await drain();
    assert.deepEqual(await sharedWith(f.item_id), []);
    assert.deepEqual((await rows(`SELECT state FROM storage_grants WHERE folder_id = $1`, [f.id])).map((r) => r.state), ['revoked']);
    const ended = (await c.admin.request('GET', '/admin/storage/admins')).body;
    assert.equal(ended.admins.length, 0);
    assert.equal(ended.ended[0].endReason, 'Moved to another team');
    assert.equal((await rows(`SELECT 1 FROM audit_events WHERE action = 'storage.admin_ended'`)).length, 1);

    // Designated again, then the account is disabled: access goes at once; enabling restores it.
    assert.equal((await designate('bob', 'Back on the team')).status, 201);
    await drain();
    assert.deepEqual(await sharedWith(f.item_id), ['bob@example.org:write']);
    assert.equal((await c.admin.request('POST', `/users/${ids.bob}/disable`)).status, 204);
    await drain();
    assert.deepEqual(await sharedWith(f.item_id), [], 'a disabled account keeps no direct access');
    assert.equal((await rows(`SELECT 1 FROM storage_admins WHERE user_id = $1 AND ended_at IS NULL`, [ids.bob])).length, 1, 'the designation stands');
    assert.equal((await c.admin.request('POST', `/users/${ids.bob}/enable`)).status, 204);
    await drain();
    assert.deepEqual(await sharedWith(f.item_id), ['bob@example.org:write']);
  });

  test('an Enterprise Administrator standing alone gives no grant', async () => {
    assert.equal((await designate('bob')).status, 201);
    await drain();
    const f = (await sourceFolder())!;
    assert.deepEqual(await sharedWith(f.item_id), ['bob@example.org:write'], 'only the designated person, not admin or admin2');
    assert.equal((await rows(`SELECT 1 FROM storage_grants WHERE user_id = ANY($1::uuid[])`, [[ids.admin, ids.admin2]])).length, 0);
    // With nobody designated at all, nothing is created in the provider.
    await t.pool.query(`UPDATE storage_admins SET ended_at = now(), ended_by = $1, end_reason = 'x'`, [ids.admin]);
    const before = fake.invites.length;
    await drain();
    assert.equal(fake.invites.length, before);
  });

  test('daily check warns about anyone else with access and never removes it', async () => {
    assert.equal((await designate('bob')).status, 201);
    await drain();
    const f = (await sourceFolder())!;
    fake.seedPermission(drive.driveId, drive.rootItemId, { kind: 'owner_group', principal: 'Sources Owners', roles: ['owner'] });
    fake.seedPermission(drive.driveId, drive.rootItemId, { kind: 'app', principal: APP_ID, roles: ['owner'] });
    assert.deepEqual(await sourceAreaOthers(deps()), [], 'designated people, the connection and owners are not others');
    await dailySourceAreaAccess(deps());
    assert.equal((await c.admin.request('GET', '/admin/storage/admins')).body.warning, null);

    fake.seedPermission(drive.driveId, drive.rootItemId, { kind: 'user', principal: 'stranger@example.org', roles: ['write'] });
    const link = fake.seedPermission(drive.driveId, f.item_id, { kind: 'link', principal: 'Anyone link', roles: ['read'] });
    const before = fake.calls.length;
    await dailySourceAreaAccess(deps());
    const warning = (await c.admin.request('GET', '/admin/storage/admins')).body.warning;
    assert.equal(warning, 'The source area is also open to: a sharing link, stranger@example.org');
    assert.equal(fake.calls.slice(before).filter((x) => x.method === 'DELETE').length, 0, 'nothing is removed');
    assert.equal((await connector.listPermissions(dest(), drive.rootItemId)).filter((p) => p.principal === 'stranger@example.org').length, 1);
    assert.ok((await connector.listPermissions(dest(), f.item_id)).some((p) => p.id === link));
    assert.equal((await rows(`SELECT last_check->>'sourceAreaWarning' AS w FROM storage_destinations WHERE id = $1`, [destId]))[0].w, warning);

    // Once the others are gone (removed by someone else), the warning clears.
    await connector.revoke(dest(), f.item_id, link);
    const stranger = (await connector.listPermissions(dest(), drive.rootItemId)).find((p) => p.principal === 'stranger@example.org')!;
    await connector.revoke(dest(), drive.rootItemId, stranger.id);
    await dailySourceAreaAccess(deps());
    assert.equal((await c.admin.request('GET', '/admin/storage/admins')).body.warning, null);
  });

  test('events are recorded and listed ordered by name', async () => {
    assert.equal((await designate('dave', 'Second reason')).status, 201);
    assert.equal((await designate('bob', 'First reason')).status, 201);
    assert.equal((await designate('carol', 'Third reason')).status, 201);
    const bobId = (await rows(`SELECT id FROM storage_admins WHERE user_id = $1`, [ids.bob]))[0].id;
    assert.equal((await c.admin2.request('POST', `/admin/storage/admins/${bobId}/end`, { reason: 'Finished' })).status, 200);
    const { events, admins } = (await c.admin.request('GET', '/admin/storage/admins')).body;
    assert.deepEqual(events.map((e: { displayName: string; kind: string }) => `${e.displayName}:${e.kind}`), ['bob:designated', 'bob:ended', 'carol:designated', 'dave:designated']);
    assert.deepEqual(events.map((e: { actorName: string }) => e.actorName), ['admin', 'admin2', 'admin', 'admin']);
    assert.deepEqual(admins.map((a: { displayName: string }) => a.displayName), ['carol', 'dave']);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_admin_events`))[0].n, 4);
    await assert.rejects(t.pool.query(`UPDATE storage_admin_events SET reason = 'changed'`), 'the event table is append-only');
  });
});
