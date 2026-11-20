import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { M365TokenSource } from '../../email/m365-token';
import { startFakeGraph, type FakeGraph } from '../../testing/fake-graph';
import { quickXorHash } from '../quickxor';
import { StorageError, type DestinationRef } from '../types';
import { GraphConnector } from './graph';
import { runContractSuite } from './contract-suite';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const cfg = { tenantId: 'test-tenant', clientId: 'client-1', clientSecret: 'secret-value-xyz' };
const people = { known: 'known.person@example.org', unknown: 'unknown.person@example.org' };
const MiB = 1024 * 1024;
const APP_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_APP_ID = '99999999-0000-4000-8000-000000000000';

interface Setup { fake: FakeGraph; connector: GraphConnector; dest: DestinationRef; tokens: M365TokenSource }

async function setup(opts: { lookup?: boolean; domains?: string[]; callTimeoutMs?: number } = {}): Promise<Setup> {
  const fake = await startFakeGraph();
  const tokens = new M365TokenSource(cfg, fake.fetch, undefined, undefined, GRAPH_SCOPE);
  const connector = new GraphConnector(tokens, {
    fetchFn: fake.fetch,
    graphBase: fake.graphBase,
    lookup: opts.lookup ?? true,
    allowedDomains: async () => opts.domains ?? ['example.org'],
    appClientId: APP_ID,
    callTimeoutMs: opts.callTimeoutMs,
  });
  const a = fake.addDrive();
  return { fake, connector, tokens, dest: { id: 'dest-a', connector: 'graph', driveId: a.driveId, rootItemId: a.rootItemId } };
}

function isCode(code: string) {
  return (e: unknown) => e instanceof StorageError && e.code === code;
}

runContractSuite('graph', async () => {
  const s = await setup();
  s.fake.addUser(people.known);
  const b = s.fake.addDrive();
  return {
    connector: s.connector,
    dest: s.dest,
    otherDest: { id: 'dest-b', connector: 'graph', driveId: b.driveId, rootItemId: b.rootItemId },
    people,
    seedPermission: async (itemId, p) => s.fake.seedPermission(s.dest.driveId, itemId, p),
    seedVersion: async (itemId, bytes) => s.fake.changeContent(s.dest.driveId, itemId, bytes),
    close: () => s.fake.close(),
  };
});

test('token request uses the Graph scope', async () => {
  const s = await setup();
  try {
    await s.connector.ensureFolder(s.dest, null, 'Scope');
    assert.deepEqual(s.fake.tokenScopes, [GRAPH_SCOPE]);
  } finally { await s.fake.close(); }
});

test('uploads above 4 MiB use an upload session in 5 MiB chunks', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Big');
    const bytes = randomBytes(11 * MiB + 1000);
    s.fake.calls.length = 0;
    const ref = await s.connector.upload(s.dest, f.itemId, 'big.bin', bytes, { conflict: 'fail' });
    assert.equal(ref.size, bytes.length);
    assert.equal(ref.providerHash, quickXorHash(bytes));
    assert.equal(s.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/createUploadSession')).length, 1);
    const chunks = s.fake.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/upload/'));
    assert.equal(chunks.length, 3);
    assert.ok(!s.fake.calls.some((c) => c.method === 'PUT' && c.path.endsWith(':/content')), 'no simple upload');
    assert.deepEqual(s.fake.chunkSizes, [5 * MiB, 5 * MiB, MiB + 1000]);
    assert.ok((await s.connector.download(s.dest, ref.itemId)).equals(bytes));

    // up to 4 MiB is one simple PUT
    s.fake.calls.length = 0;
    await s.connector.upload(s.dest, f.itemId, 'small.bin', randomBytes(4 * MiB), { conflict: 'fail' });
    assert.equal(s.fake.calls.filter((c) => c.method === 'PUT' && c.path.endsWith(':/content')).length, 1);
    assert.ok(!s.fake.calls.some((c) => c.path.endsWith('/createUploadSession')));
  } finally { await s.fake.close(); }
});

test('the fake refuses an upload chunk that is not a multiple of 320 KiB and a chunk sent with a token', async () => {
  const s = await setup();
  try {
    const token = await s.tokens.token();
    const session = await (await s.fake.fetch(`${s.fake.graphBase}/drives/${encodeURIComponent(s.dest.driveId)}/items/${encodeURIComponent(s.dest.rootItemId)}:/x.bin:/createUploadSession`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
    })).json() as { uploadUrl: string };
    const odd = await s.fake.fetch(session.uploadUrl, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-999/2000000' }, body: Buffer.alloc(1000) });
    assert.equal(odd.status, 400);
    const authed = await s.fake.fetch(session.uploadUrl, {
      method: 'PUT', headers: { 'Content-Range': 'bytes 0-327679/2000000', Authorization: `Bearer ${token}` }, body: Buffer.alloc(327_680),
    });
    assert.equal(authed.status, 401);
  } finally { await s.fake.close(); }
});

test('429 maps to throttled with retryAfterMs from Retry-After', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'T');
    s.fake.fault({ method: 'GET', pathIncludes: f.itemId }, '429');
    await assert.rejects(s.connector.getItem(s.dest, f.itemId), (e: unknown) => {
      assert.ok(e instanceof StorageError);
      assert.equal(e.code, 'throttled');
      assert.equal(e.status, 429);
      assert.equal(e.retryAfterMs, 2000);
      return true;
    });
    assert.equal((await s.connector.getItem(s.dest, f.itemId)).itemId, f.itemId, 'fault used once');
  } finally { await s.fake.close(); }
});

test('status codes map to storage error codes', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Codes');
    const cases: Array<['401' | '403' | '404' | '503' | '500', string]> = [
      ['401', 'unauthorised'], ['403', 'forbidden'], ['404', 'not_found'], ['503', 'server'], ['500', 'server'],
    ];
    for (const [kind, code] of cases) {
      s.fake.fault({ method: 'GET', pathIncludes: f.itemId }, kind);
      await assert.rejects(s.connector.getItem(s.dest, f.itemId), isCode(code), kind);
    }
    s.fake.fault({ method: 'GET', pathIncludes: f.itemId }, '503');
    await assert.rejects(s.connector.getItem(s.dest, f.itemId), (e: unknown) => e instanceof StorageError && e.retryAfterMs === 3000);
  } finally { await s.fake.close(); }
});

test('a dropped connection maps to unreachable', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Drop');
    s.fake.fault({ method: 'GET', pathIncludes: f.itemId }, 'drop_after_body');
    await assert.rejects(s.connector.getItem(s.dest, f.itemId), isCode('unreachable'));
  } finally { await s.fake.close(); }
});

test('a slow reply maps to timeout', async () => {
  const keepAlive = setInterval(() => undefined, 1_000);
  const s = await setup({ callTimeoutMs: 150 });
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Slow');
    s.fake.fault({ method: 'GET', pathIncludes: f.itemId }, 'timeout');
    await assert.rejects(s.connector.getItem(s.dest, f.itemId), isCode('timeout'));
  } finally {
    clearInterval(keepAlive);
    await s.fake.close();
  }
});

test('upload with dropped reply leaves the file findable by findChild', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Uncertain');
    const bytes = Buffer.from('stored even though the reply was lost');
    s.fake.fault({ method: 'PUT', pathIncludes: '/content' }, 'drop_after_body');
    await assert.rejects(s.connector.upload(s.dest, f.itemId, 'u.txt', bytes, { conflict: 'fail' }), isCode('unreachable'));
    const found = await s.connector.findChild(s.dest, f.itemId, 'u.txt');
    assert.ok(found);
    assert.equal(found.size, bytes.length);
    assert.equal(found.providerHash, quickXorHash(bytes));
  } finally { await s.fake.close(); }
});

test('lookupPerson with lookup on (User.ReadBasic.All): member → account, guest → not_found, unknown → not_found', async () => {
  const s = await setup({ lookup: true });
  try {
    s.fake.addUser('member@example.org');
    s.fake.addUser('guest@example.net', { userType: 'Guest' });
    s.fake.addUser('disabled@example.org', { enabled: false });
    assert.equal(await s.connector.lookupPerson('member@example.org'), 'account');
    assert.equal(await s.connector.lookupPerson('guest@example.net'), 'not_found');
    // ReadBasic does not expose accountEnabled: a disabled account cannot be told apart
    assert.equal(await s.connector.lookupPerson('disabled@example.org'), 'account');
    assert.equal(await s.connector.lookupPerson('nobody@example.org'), 'not_found');
    assert.ok(s.fake.calls.some((c) => c.method === 'GET' && c.path === '/v1.0/users/member@example.org'));
  } finally { await s.fake.close(); }
});

test('grant with lookup on refuses a guest without inviting', async () => {
  const s = await setup({ lookup: true });
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Guests');
    s.fake.addUser('guest@example.net', { userType: 'Guest' });
    assert.deepEqual(await s.connector.grant(s.dest, f.itemId, 'guest@example.net', 'read'), { notFound: true });
    assert.equal(s.fake.invites.length, 0);
    assert.ok(!s.fake.calls.some((c) => c.path.endsWith('/invite')));
  } finally { await s.fake.close(); }
});

test('grant refuses the library root', async () => {
  const s = await setup({ lookup: true });
  try {
    s.fake.addUser(people.known);
    await assert.rejects(s.connector.grant(s.dest, s.dest.rootItemId, people.known, 'read'), isCode('invalid'));
    assert.equal(s.fake.invites.length, 0);
  } finally { await s.fake.close(); }
});

test('423 resourceLocked maps to a temporary server error', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Locked');
    s.fake.fault({ method: 'GET', pathIncludes: f.itemId }, '423');
    await assert.rejects(s.connector.getItem(s.dest, f.itemId), (e: unknown) => e instanceof StorageError && e.code === 'server' && e.status === 423);
  } finally { await s.fake.close(); }
});

test('a next page outside Graph is refused and never sent the token', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Paged');
    const foreign: string[] = [];
    // rewrites the permissions page so its next link names another host
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://elsewhere.example.net')) { foreign.push(url); return new Response('{"value":[]}', { status: 200 }); }
      const res = await s.fake.fetch(input, init);
      if (!url.includes('/permissions')) return res;
      const body = await res.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, '@odata.nextLink': 'https://elsewhere.example.net/v1.0/next' }), { status: 200 });
    }) as typeof fetch;
    const c = new GraphConnector(s.tokens, { fetchFn, graphBase: s.fake.graphBase, lookup: true, allowedDomains: async () => [], appClientId: APP_ID });
    await assert.rejects(c.listPermissions(s.dest, f.itemId), isCode('invalid'));
    assert.deepEqual(foreign, []);
  } finally { await s.fake.close(); }
});

test('lookupPerson with lookup off returns unknown and makes no call', async () => {
  const s = await setup({ lookup: false });
  try {
    s.fake.addUser('member@example.org');
    assert.equal(await s.connector.lookupPerson('member@example.org'), 'unknown');
    assert.equal(s.fake.calls.length, 0);
  } finally { await s.fake.close(); }
});

test('grant refuses an address outside allowed domains with lookup off', async () => {
  const s = await setup({ lookup: false, domains: ['example.org'] });
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Out');
    s.fake.addUser('outsider@example.net');
    s.fake.calls.length = 0;
    assert.deepEqual(await s.connector.grant(s.dest, f.itemId, 'outsider@example.net', 'read'), { notFound: true });
    assert.equal(s.fake.calls.length, 0);
    assert.equal(s.fake.invites.length, 0);
  } finally { await s.fake.close(); }
});

test('grant invites with requireSignIn true and sendInvitation false and roles read', async () => {
  const s = await setup({ lookup: false, domains: ['Example.org'] });
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'In');
    s.fake.addUser('reader@example.org');
    const r = await s.connector.grant(s.dest, f.itemId, 'reader@example.org', 'read');
    assert.ok('permissionId' in r);
    assert.equal(s.fake.invites.length, 1);
    assert.deepEqual(s.fake.invites[0].body, {
      recipients: [{ email: 'reader@example.org' }], roles: ['read'], requireSignIn: true, sendInvitation: false,
    });
    assert.equal(s.fake.invites[0].itemId, f.itemId);
    // an approved domain the provider does not know is refused by the provider and reported not found
    assert.deepEqual(await s.connector.grant(s.dest, f.itemId, 'ghost@example.org', 'read'), { notFound: true });
    // a file is never shared
    const file = await s.connector.upload(s.dest, f.itemId, 'f.txt', Buffer.from('x'), { conflict: 'fail' });
    await assert.rejects(s.connector.grant(s.dest, file.itemId, 'reader@example.org', 'read'), isCode('invalid'));
  } finally { await s.fake.close(); }
});

test('no error message or log contains the bearer token', async () => {
  const s = await setup({ callTimeoutMs: 150 });
  const keepAlive = setInterval(() => undefined, 1_000);
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    const token = await s.tokens.token();
    const f = await s.connector.ensureFolder(s.dest, null, 'Leak');
    const seen: string[] = [];
    for (const kind of ['401', '403', '404', '429', '500', '503', 'drop_after_body', 'timeout'] as const) {
      s.fake.fault({ method: 'GET', pathIncludes: f.itemId }, kind);
      await assert.rejects(s.connector.getItem(s.dest, f.itemId), (e: unknown) => {
        assert.ok(e instanceof StorageError, kind);
        seen.push(e.message, String(e.stack), JSON.stringify(e));
        return true;
      });
    }
    assert.equal(seen.length, 24);
    for (const text of [...seen, ...logged]) assert.ok(!text.includes(token), 'token leaked');
  } finally {
    Object.assign(console, orig);
    clearInterval(keepAlive);
    await s.fake.close();
  }
});

test('listPermissions classifies owner group, site admin, app, user, group and link', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Perms');
    const seed = (kind: 'owner_group' | 'site_admin' | 'app' | 'other_app' | 'user' | 'group' | 'link', principal: string, roles: string[]) =>
      s.fake.seedPermission(s.dest.driveId, f.itemId, { kind, principal, roles });
    const ids = {
      owners: seed('owner_group', 'Outputs Owners', ['owner']),
      admin: seed('site_admin', 'admin@example.org', ['owner']),
      app: seed('app', APP_ID, ['write']),
      otherApp: seed('other_app', OTHER_APP_ID, ['write']),
      user: seed('user', 'someone@example.org', ['read']),
      members: seed('group', 'Outputs Members', ['write']),
      link: seed('link', 'organization', ['read']),
      // a site group with full control that is not the owners group is "another group"
      helpers: seed('owner_group', 'Helpers', ['owner']),
    };
    const perms = await s.connector.listPermissions(s.dest, f.itemId);
    const by = new Map(perms.map((p) => [p.id, p]));
    assert.equal(by.get(ids.owners)?.kind, 'owner_group');
    assert.equal(by.get(ids.owners)?.principal, 'Outputs Owners');
    // a site user with full control is not trusted as a site administrator (fail closed)
    assert.equal(by.get(ids.admin)?.kind, 'user');
    assert.equal(by.get(ids.admin)?.principal, 'admin@example.org');
    assert.equal(by.get(ids.app)?.kind, 'app');
    assert.equal(by.get(ids.otherApp)?.kind, 'other_app');
    assert.equal(by.get(ids.otherApp)?.principal, OTHER_APP_ID);
    assert.equal(by.get(ids.user)?.kind, 'user');
    assert.equal(by.get(ids.user)?.principal, 'someone@example.org');
    assert.deepEqual(by.get(ids.user)?.roles, ['read']);
    assert.equal(by.get(ids.members)?.kind, 'group');
    assert.equal(by.get(ids.link)?.kind, 'link');
    assert.equal(by.get(ids.link)?.principal, 'organization');
    assert.equal(by.get(ids.helpers)?.kind, 'group');
  } finally { await s.fake.close(); }
});

test('checkDestination passes a library limited to owners and lists anyone else', async () => {
  const s = await setup();
  try {
    s.fake.addUser(people.known);
    s.fake.seedPermission(s.dest.driveId, s.dest.rootItemId, { kind: 'owner_group', principal: 'Outputs Owners', roles: ['owner'] });
    s.fake.seedPermission(s.dest.driveId, s.dest.rootItemId, { kind: 'app', principal: APP_ID, roles: ['owner'] });
    const good = await s.connector.checkDestination(s.dest, { testPerson: people.known });
    assert.equal(good.ok, true, JSON.stringify(good.lines));
    assert.deepEqual(good.lines.map((l) => l.key), ['reachable', 'folder', 'upload', 'delete', 'permissions', 'library_permissions', 'sharing_capability']);
    assert.ok(good.quotaBytes && good.quotaBytes > 0);
    assert.equal(good.others.length, 0);
    assert.deepEqual(s.fake.recycleBin(s.dest.driveId), [], 'probe file removed permanently');
    assert.equal(s.fake.invites.length, 1, 'test person invited once');
    const check = await s.connector.findChild(s.dest, s.dest.rootItemId, '.kainow-check');
    assert.ok(check);
    assert.deepEqual(await s.connector.listPermissions(s.dest, check.itemId), [], 'test permission revoked');

    // without a test person, creating permissions is not checked and the check does not pass
    const untested = await s.connector.checkDestination(s.dest);
    assert.equal(untested.ok, false);
    assert.deepEqual(untested.lines.find((l) => l.key === 'permissions'),
      { key: 'permissions', ok: false, detail: 'Creating permissions was not checked: no test person given' });
    assert.equal(untested.lines.find((l) => l.key === 'library_permissions')?.ok, true, 'library still checked');

    // a test person who cannot be given access fails the line
    const refused = await s.connector.checkDestination(s.dest, { testPerson: 'nobody@example.org' });
    assert.equal(refused.lines.find((l) => l.key === 'permissions')?.ok, false);

    s.fake.seedPermission(s.dest.driveId, s.dest.rootItemId, { kind: 'group', principal: 'Outputs Members', roles: ['write'] });
    s.fake.seedPermission(s.dest.driveId, s.dest.rootItemId, { kind: 'other_app', principal: OTHER_APP_ID, roles: ['write'] });
    const bad = await s.connector.checkDestination(s.dest, { testPerson: people.known });
    assert.equal(bad.ok, false);
    assert.equal(bad.lines.find((l) => l.key === 'library_permissions')?.ok, false);
    assert.deepEqual(bad.others.map((o) => o.principal), ['Outputs Members', OTHER_APP_ID]);
  } finally { await s.fake.close(); }
});

test('resolveSharePointLibrary and resolveOneDrive find the drive and root', async () => {
  const s = await setup({ lookup: true });
  try {
    const lib = s.fake.addDrive({ siteUrl: 'https://tenant.example.org/sites/outputs', libraryName: 'Project Outputs' });
    const r = await s.connector.resolveSharePointLibrary('https://tenant.example.org/sites/outputs/', 'project outputs');
    assert.deepEqual(r, lib);
    await assert.rejects(s.connector.resolveSharePointLibrary('https://tenant.example.org/sites/outputs', 'Nope'), isCode('not_found'));
    await assert.rejects(s.connector.resolveSharePointLibrary('https://tenant.example.org/sites/none', 'Documents'), isCode('not_found'));

    s.fake.addUser('owner@example.org');
    const od = s.fake.addDrive({ ownerEmail: 'owner@example.org' });
    const odDest: DestinationRef = { id: 'od', connector: 'graph', driveId: od.driveId, rootItemId: od.rootItemId };
    const kf = await s.connector.ensureFolder(odDest, null, 'Kainow');
    const sub = await s.connector.ensureFolder(odDest, kf.itemId, 'Filed');
    assert.deepEqual(await s.connector.resolveOneDrive('owner@example.org'), { driveId: od.driveId, rootItemId: od.rootItemId });
    const inFolder = await s.connector.resolveOneDrive('owner@example.org', '/Kainow/Filed');
    assert.deepEqual(inFolder, { driveId: od.driveId, rootItemId: sub.itemId });

    // paths are relative to a folder destination's root
    const folderDest: DestinationRef = { id: 'odf', connector: 'graph', ...inFolder };
    const ref = await s.connector.upload(folderDest, inFolder.rootItemId, 'a.txt', Buffer.from('a'), { conflict: 'fail' });
    assert.equal(ref.path, '/a.txt');

    const off = new GraphConnector(s.tokens, { fetchFn: s.fake.fetch, graphBase: s.fake.graphBase, lookup: false, allowedDomains: async () => [], appClientId: APP_ID });
    await assert.rejects(off.resolveOneDrive('owner@example.org'), isCode('unsupported'));
  } finally { await s.fake.close(); }
});

test('resolveLink finds an item by its web URL', async () => {
  const s = await setup();
  try {
    const f = await s.connector.ensureFolder(s.dest, null, 'Linked Folder');
    const ref = await s.connector.upload(s.dest, f.itemId, 'l x.txt', Buffer.from('x'), { conflict: 'fail' });
    assert.ok(ref.webUrl);
    const r = await s.connector.resolveLink(ref.webUrl);
    assert.equal(r.item.itemId, ref.itemId);
    assert.equal(r.item.path, '/Linked Folder/l x.txt');
    assert.equal(r.dest?.driveId, s.dest.driveId);
    await assert.rejects(s.connector.resolveLink('https://tenant.example.org/nothing-here'), isCode('not_found'));
    await assert.rejects(s.connector.resolveLink('not a url'), isCode('invalid'));
  } finally { await s.fake.close(); }
});

test('copyTo polls the monitor until the copy completes', async () => {
  const s = await setup();
  try {
    const b = s.fake.addDrive();
    const other: DestinationRef = { id: 'b', connector: 'graph', driveId: b.driveId, rootItemId: b.rootItemId };
    const f = await s.connector.ensureFolder(s.dest, null, 'Src');
    const ref = await s.connector.upload(s.dest, f.itemId, 'c.txt', Buffer.from('copy'), { conflict: 'fail' });
    s.fake.calls.length = 0;
    const copy = await s.connector.copyTo(s.dest, ref.itemId, other, other.rootItemId, 'c.txt');
    assert.ok(s.fake.calls.filter((c) => c.path.startsWith('/monitor/')).length >= 2, 'polled at least twice');
    assert.equal(copy.path, '/c.txt');
    await assert.rejects(s.connector.copyTo(s.dest, ref.itemId, other, other.rootItemId, 'c.txt'), isCode('conflict'));
  } finally { await s.fake.close(); }
});
