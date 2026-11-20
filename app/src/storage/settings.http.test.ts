import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { startFakeGraph, type FakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';
import { keyFile } from '../testing/ai-connections';
import { StorageSettingsService, storageTokenSource } from './settings.service';

const SECRET_A = 'client-secret-test-value-AAAA-0123456789';
const SECRET_B = 'client-secret-test-value-BBBB-0123456789';
const NO_KEY = 'Storage credentials cannot be saved until the protected key is installed. See INSTALL.md.';

describe('storage connection settings over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let admin: Client;
  let member: Client;
  let adminId: string;
  let fake: FakeGraph | undefined;
  let svc: StorageSettingsService;
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
  const reason = 'Setting up the storage connection';
  const connect = async () => {
    fake = await startFakeGraph();
    svc.fetchFn = fake.fetch;
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, tenantId: 'tenant-1', clientId: 'client-1' })).status, 200);
    assert.equal((await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: SECRET_A })).status, 200);
    return fake;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-storage-'));
    t = await startTestApp(undefined, { protectedKeyFile: keyFile(dir) });
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('member@example.org');
    svc = t.app.get(StorageSettingsService);
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('only an Enterprise Administrator reads or changes storage settings', async () => {
    assert.equal((await member.request('GET', '/admin/storage')).status, 403);
    assert.equal((await member.request('PUT', '/admin/storage', { reason, scheduledChecks: true })).status, 403);
    assert.equal((await member.request('POST', '/admin/storage/secret', { reason, clientSecret: SECRET_A })).status, 403);
    assert.equal((await member.request('POST', '/admin/storage/check')).status, 403);
    const got = await admin.request('GET', '/admin/storage');
    assert.equal(got.status, 200);
    assert.equal(got.body.settings.directoryLookup, false);
    assert.equal(got.body.settings.hasSecret, false);
    assert.equal(got.body.protectedKeyLoaded, true);
    assert.deepEqual(got.body.settings.approvedInputFormats, ['txt', 'md', 'docx', 'pdf']);
  });

  test('changes need a reason and record previous and next without the secret', async () => {
    assert.equal((await admin.request('PUT', '/admin/storage', { tenantId: 'tenant-1' })).status, 400);
    assert.equal((await admin.request('PUT', '/admin/storage', { reason: '  ', tenantId: 'tenant-1' })).status, 400);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_settings_changes`))[0].n, 0);

    const put = await admin.request('PUT', '/admin/storage', { reason, tenantId: 'tenant-1', clientId: 'client-1', scheduledChecks: true });
    assert.equal(put.status, 200);
    const secret = await admin.request('POST', '/admin/storage/secret', { reason: 'First secret', clientSecret: SECRET_A });
    assert.equal(secret.status, 200);

    const changes = await rows(`SELECT actor_id, reason, previous, next FROM storage_settings_changes ORDER BY at, id`);
    assert.equal(changes.length, 2);
    assert.equal(changes[0].actor_id, adminId);
    assert.equal(changes[0].reason, reason);
    assert.equal(changes[0].previous.tenantId, null);
    assert.equal(changes[0].next.tenantId, 'tenant-1');
    assert.equal(changes[0].previous.scheduledChecks, false);
    assert.equal(changes[0].next.scheduledChecks, true);
    assert.equal(changes[1].previous.hasSecret, false);
    assert.equal(changes[1].next.hasSecret, true);

    const audits = await rows(`SELECT * FROM audit_events WHERE action = 'storage.connection_changed'`);
    assert.equal(audits.length, 2);
    const everything = JSON.stringify([changes, await rows(`SELECT * FROM audit_events`), put.body, secret.body, await rows(`SELECT detail FROM audit_events`)]);
    assert.ok(!everything.includes(SECRET_A));
    assert.ok(!everything.includes(Buffer.from(SECRET_A).toString('base64')));
  });

  test('secret is sealed, never returned and replaced append-only', async () => {
    await admin.request('PUT', '/admin/storage', { reason, tenantId: 'tenant-1', clientId: 'client-1' });
    const first = await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: `  ${SECRET_A}  ` });
    assert.equal(first.status, 200);
    assert.equal(first.body.settings.hasSecret, true);
    assert.ok(!JSON.stringify(first.body).includes(SECRET_A));
    const got = await admin.request('GET', '/admin/storage');
    assert.equal(got.body.settings.hasSecret, true);
    assert.equal(got.body.secret, 'saved');
    assert.ok(!JSON.stringify(got.body).toLowerCase().includes('clientsecret'));
    const [one] = await rows(`SELECT * FROM storage_connection_secrets`);
    assert.ok(!one.ciphertext.includes(Buffer.from(SECRET_A)));
    assert.equal(one.superseded_at, null);

    await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: SECRET_B });
    const all = await rows(`SELECT id, superseded_at FROM storage_connection_secrets ORDER BY saved_at, id`);
    assert.equal(all.length, 2);
    assert.equal(all[0].id, one.id);
    assert.notEqual(all[0].superseded_at, null);
    assert.equal(all[1].superseded_at, null);
  });

  test('secret save refused without protected key', async () => {
    const internals = svc as unknown as { protectedKey: unknown };
    const real = internals.protectedKey;
    internals.protectedKey = null;
    try {
      const res = await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: SECRET_A });
      assert.equal(res.status, 409);
      assert.equal(res.body.message, NO_KEY);
      assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_connection_secrets`))[0].n, 0);
      assert.equal((await admin.request('POST', '/admin/storage/check')).body.state, 'not_configured');
    } finally {
      internals.protectedKey = real;
    }
  });

  test('check without the protected key reports protected_key_missing', async () => {
    await connect();
    const internals = svc as unknown as { protectedKey: unknown };
    const real = internals.protectedKey;
    internals.protectedKey = null;
    try {
      assert.deepEqual((await admin.request('POST', '/admin/storage/check')).body, { state: 'protected_key_missing' });
      assert.equal(await storageTokenSource(t.pool, null), null);
    } finally {
      internals.protectedKey = real;
    }
  });

  test('secret length 10–200 printable characters', async () => {
    for (const bad of ['x'.repeat(9), 'x'.repeat(201), `abcdefghij${String.fromCharCode(7)}klm`, 12345, '         ']) {
      const res = await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: bad });
      assert.equal(res.status, 400, String(bad));
      assert.equal(res.body.message, 'This does not look like a client secret.');
    }
    assert.equal((await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: 'x'.repeat(10) })).status, 200);
    assert.equal((await admin.request('POST', '/admin/storage/secret', { reason, clientSecret: 'x'.repeat(200) })).status, 200);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_connection_secrets`))[0].n, 2);
  });

  test('check connection reports connected, refused and unreachable', async () => {
    assert.deepEqual((await admin.request('POST', '/admin/storage/check')).body, { state: 'not_configured' });
    const g = await connect();
    assert.deepEqual((await admin.request('POST', '/admin/storage/check')).body, { state: 'connected' });
    assert.deepEqual(g.tokenScopes, ['https://graph.microsoft.com/.default']);
    assert.ok(g.calls.some((c) => c.path.endsWith('/sites/root')));

    g.fault({ method: 'POST', pathIncludes: 'oauth2' }, '401');
    assert.deepEqual((await admin.request('POST', '/admin/storage/check')).body, { state: 'refused' });

    await g.close();
    assert.deepEqual((await admin.request('POST', '/admin/storage/check')).body, { state: 'unreachable' });
  });

  test("turning directory lookup on runs a lookup of the Administrator's own address", async () => {
    const g = await connect();
    // not granted: the Administrator is not found, nothing is saved
    const refused = await admin.request('PUT', '/admin/storage', { reason, directoryLookup: true });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /User\.ReadBasic\.All/);
    assert.equal((await admin.request('GET', '/admin/storage')).body.settings.directoryLookup, false);
    const before = (await rows(`SELECT count(*)::int AS n FROM storage_settings_changes`))[0].n;

    g.addUser('admin@example.org');
    const ok = await admin.request('PUT', '/admin/storage', { reason, directoryLookup: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.directoryLookup, true);
    assert.equal(ok.body.requestedPermissions.find((p: { name: string }) => p.name === 'User.ReadBasic.All').needed, true);
    assert.ok(g.calls.some((c) => c.path === '/v1.0/users/admin@example.org'), JSON.stringify(g.calls));
    assert.equal((await rows(`SELECT count(*)::int AS n FROM storage_settings_changes`))[0].n, before + 1);
  });

  test('turning directory lookup on is refused when no connection is saved or the lookup call fails', async () => {
    const none = await admin.request('PUT', '/admin/storage', { reason, directoryLookup: true });
    assert.equal(none.status, 400);
    const g = await connect();
    g.addUser('admin@example.org');
    g.fault({ pathIncludes: '/users/' }, '403');
    const failed = await admin.request('PUT', '/admin/storage', { reason, directoryLookup: true });
    assert.equal(failed.status, 400);
    assert.match(failed.body.message, /User\.ReadBasic\.All/);
    assert.equal((await admin.request('GET', '/admin/storage')).body.settings.directoryLookup, false);
  });

  test('turning it off is refused while an OneDrive destination is approved', async () => {
    const g = await connect();
    g.addUser('admin@example.org');
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, directoryLookup: true })).status, 200);
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, account_email, status, created_by, created_at)
       VALUES ($1, 'graph', 'onedrive', 'outputs', 'Admin drive', 'admin@example.org', 'approved', $2, now())`,
      [uuidv7(), adminId],
    );
    const refused = await admin.request('PUT', '/admin/storage', { reason, directoryLookup: false });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /OneDrive/);
    assert.equal((await admin.request('GET', '/admin/storage')).body.settings.directoryLookup, true);
    await t.pool.query(`UPDATE storage_destinations SET status = 'withdrawn'`);
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, directoryLookup: false })).status, 200);
  });

  test('approved formats must keep at least one input format', async () => {
    const empty = await admin.request('PUT', '/admin/storage', { reason, approvedInputFormats: [] });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.message, 'Keep at least one approved input format.');
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, approvedInputFormats: ['exe'] })).status, 400);
    assert.equal((await admin.request('PUT', '/admin/storage', { reason, approvedOutputFormats: ['xlsx'] })).status, 400);
    const ok = await admin.request('PUT', '/admin/storage', { reason, approvedInputFormats: ['pdf', 'txt'], approvedOutputFormats: ['csv'] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.settings.approvedInputFormats, ['txt', 'pdf']);
    assert.deepEqual(ok.body.settings.approvedOutputFormats, ['csv']);
  });

  test('storageTokenSource is null when not configured and never throws when the secret cannot be opened', async () => {
    const real = (svc as unknown as { protectedKey: Parameters<typeof storageTokenSource>[1] }).protectedKey;
    assert.equal(await storageTokenSource(t.pool, real), null);
    await connect();
    assert.notEqual(await storageTokenSource(t.pool, real), null);
    const other = { ...real!, id: 'other', decrypt: () => { throw new Error('bad'); } };
    assert.equal(await storageTokenSource(t.pool, other), null);
  });
});
