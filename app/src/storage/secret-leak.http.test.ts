import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { keyFile } from '../testing/ai-connections';
import { SKIP_NO_DB } from '../testing/db';
import { startFakeGraph, type FakeGraph } from '../testing/fake-graph';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { captureLogs } from '../testing/logs';
import { seedUser } from '../testing/projects';
import { StorageSettingsService } from './settings.service';

const SECRET = 'leak-test-client-secret-QWERTY-9876543210';

describe('the storage client secret never leaves the process in any other form', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let admin: Client;
  let fake: FakeGraph | undefined;
  const reason = 'Setting up the storage connection';
  const dump = async (sql: string) => (await t.pool.query(sql)).rows.map((r) => JSON.stringify(r));
  const hit = (s: string) => s.includes(SECRET) || s.includes(Buffer.from(SECRET).toString('base64')) || s.includes(Buffer.from(SECRET).toString('hex'));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-storage-leak-'));
    t = await startTestApp(undefined, { protectedKeyFile: keyFile(dir) });
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    admin = await t.signIn('admin@example.org');
    fake = await startFakeGraph();
    t.app.get(StorageSettingsService).fetchFn = fake.fetch;
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('save, validation errors, malformed JSON and a failure inside the transaction leave the secret out of logs, responses and rows', async () => {
    const cap = captureLogs();
    const bodies: string[] = [];
    const statuses: number[] = [];
    try {
      const raw = async (method: string, path: string, body?: unknown) => {
        const r = await admin.raw(method, path, body);
        bodies.push(r.text);
        statuses.push(r.status);
        return r;
      };
      assert.equal((await raw('PUT', '/admin/storage', { reason, tenantId: 'tenant-1', clientId: 'client-1' })).status, 200);
      assert.equal((await raw('POST', '/admin/storage/secret', { reason, clientSecret: SECRET })).status, 200);
      assert.equal((await raw('GET', '/admin/storage')).status, 200);
      assert.equal((await raw('POST', '/admin/storage/check')).status, 200);

      // validation errors with the secret in the body
      assert.equal((await raw('POST', '/admin/storage/secret', { reason, clientSecret: SECRET.repeat(6) })).status, 400); // too long
      assert.equal((await raw('POST', '/admin/storage/secret', { clientSecret: SECRET })).status, 400); // no reason
      assert.equal((await raw('POST', '/admin/storage/secret', { reason: '', clientSecret: SECRET })).status, 400);
      assert.equal((await raw('PUT', '/admin/storage', { reason: '', tenantId: 'tenant-1', clientSecret: SECRET })).status, 400);

      // malformed JSON that contains the secret
      for (const text of [`{"reason": "x", "clientSecret": "${SECRET}"`, `{"clientSecret": ${SECRET}}`]) {
        const r = await admin.rawText('POST', '/admin/storage/secret', text);
        bodies.push(r.text);
        statuses.push(r.status);
        assert.equal(r.status, 400);
      }

      // a forced failure inside the saveSecret transaction (after the old row was superseded)
      await t.pool.query(`CREATE FUNCTION test_fail_secret_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END; $$`);
      await t.pool.query(`CREATE TRIGGER test_fail_secret_insert BEFORE INSERT ON storage_connection_secrets FOR EACH ROW EXECUTE FUNCTION test_fail_secret_insert()`);
      const failed = await raw('POST', '/admin/storage/secret', { reason, clientSecret: `${SECRET}-second` });
      assert.equal(failed.status, 500);
      await t.pool.query(`DROP TRIGGER test_fail_secret_insert ON storage_connection_secrets`);
      // the failed save rolled back: the first secret is still current
      assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM storage_connection_secrets WHERE superseded_at IS NULL`)).rows[0].n, 1);
      assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM storage_connection_secrets`)).rows[0].n, 1);
      assert.ok(statuses.includes(500));
    } finally {
      cap.stop();
    }
    assert.ok(cap.lines.length > 0, 'the capture saw the error logs');
    assert.deepEqual(cap.lines.filter(hit), [], 'log lines');
    assert.deepEqual(cap.lines.filter((l) => l.includes('-second')), [], 'log lines (second secret)');
    assert.deepEqual(bodies.filter(hit), [], 'response bodies');
    assert.deepEqual(bodies.filter((b) => b.includes('-second')), [], 'response bodies (second secret)');
    for (const [name, sql] of [
      ['storage_settings_changes', `SELECT * FROM storage_settings_changes`],
      ['storage_connection_secrets', `SELECT id, nonce, tag, key_id, saved_by, saved_at, superseded_at FROM storage_connection_secrets`],
      ['audit_events', `SELECT * FROM audit_events`],
      ['notifications', `SELECT * FROM notifications`],
      ['email_outbox', `SELECT * FROM email_outbox`],
    ]) {
      assert.deepEqual((await dump(sql)).filter(hit), [], name);
    }
  });
});
