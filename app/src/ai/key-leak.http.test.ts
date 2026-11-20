import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { captureLogs } from '../testing/logs';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { KEY_A, KEY_B, ORG, keyFile, modelBody } from '../testing/ai-connections';
import { ConnectionsService } from './connections.service';

describe('an AI key never leaves the process in any other form', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let admin: Client;
  let pm: Client;
  let projectId: string;
  let model: string;
  let svc: ConnectionsService;
  const url = (suffix = '') => `/projects/${projectId}/ai/connections${suffix}`;
  const dump = async (table: string) => (await t.pool.query(`SELECT to_jsonb(x)::text AS j FROM ${table} x`)).rows.map((r) => r.j as string);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-leak-'));
    t = await startTestApp(undefined, { protectedKeyFile: keyFile(dir) });
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    const pmId = await seedUser(t.pool, 'pm@example.org');
    projectId = await seedProject(t.pool, { status: 'active', members: [{ userId: pmId, role: 'pm' }] });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    model = (await admin.request('POST', '/ai/models', modelBody('openai', 'gpt-test-1'))).body.model.id;
    await admin.request('PUT', '/ai/spend-settings', { ...ORG, projectsMayManageConnections: true });
    svc = t.app.get(ConnectionsService);
    svc.keyChecker = async () => ({ outcome: 'ok' });
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('leak test 1: add and replace leave the key out of logs, audit, events, notifications, email and every response', async () => {
    const cap = captureLogs();
    const bodies: string[] = [];
    try {
      const raw = async (method: string, path: string, body: unknown) => {
        const r = await pm.raw(method, path, body);
        bodies.push(r.text);
        return r;
      };
      const added = await raw('POST', url(), { modelRef: model, label: 'Main', apiKey: KEY_A, reason: 'Project key' });
      assert.equal(added.status, 201);
      const id = JSON.parse(added.text).connection.id;
      assert.equal((await raw('PUT', url(`/${id}/key`), { apiKey: KEY_B, reason: 'Rotated' })).status, 200);
      assert.equal((await raw('POST', url(`/${id}/check`), { reason: 'Looking' })).status, 200);
      assert.equal((await raw('GET', url(), undefined)).status, 200);
      // Error paths that hold the key in scope.
      assert.equal((await raw('POST', url(), { modelRef: model, label: '', apiKey: KEY_A, reason: 'Project key' })).status, 400);
      assert.equal((await raw('POST', url(), { modelRef: model, label: 'Main', apiKey: KEY_A, reason: '' })).status, 400);
      assert.equal((await raw('PUT', url(`/${id}/key`), { apiKey: `${KEY_B} ${KEY_B}`, reason: 'x' })).status, 400);
      svc.keyChecker = async () => ({ outcome: 'refused', status: 401 });
      assert.equal((await raw('POST', url(), { modelRef: model, label: 'Other', apiKey: KEY_A, reason: 'Project key' })).status, 400);
      svc.keyChecker = async () => {
        throw new Error('the checker failed');
      };
      assert.equal((await raw('POST', url(), { modelRef: model, label: 'Other', apiKey: KEY_A, reason: 'Project key' })).status, 500);
      assert.equal((await raw('PUT', url(`/${id}/key`), { apiKey: KEY_B, reason: 'Again' })).status, 500);
    } finally {
      cap.stop();
    }
    assert.ok(cap.lines.length > 0, 'the capture saw the error logs');
    for (const secret of [KEY_A, KEY_B]) {
      const hit = (s: string) => s.includes(secret) || s.includes(Buffer.from(secret).toString('base64')) || s.includes(Buffer.from(secret).toString('hex'));
      assert.deepEqual(cap.lines.filter(hit), [], 'log lines');
      assert.deepEqual(bodies.filter(hit), [], 'response bodies');
      for (const table of ['audit_events', 'ai_connection_events', 'notifications', 'email_outbox', 'ai_connections']) {
        assert.deepEqual((await dump(table)).filter(hit), [], table);
      }
    }
    assert.ok((await dump('ai_connection_events')).length >= 4);
    assert.ok((await dump('audit_events')).some((r) => r.includes('ai.connection_key_replaced')));
  });

  test('a validation error does not echo the apiKey', async () => {
    const cap = captureLogs();
    let res: { status: number; text: string };
    try {
      res = await pm.raw('POST', url(), { modelRef: 'nope', label: 'Main', apiKey: KEY_A, reason: 'Project key' });
    } finally {
      cap.stop();
    }
    assert.equal(res.status, 400);
    assert.ok(!res.text.includes(KEY_A) && !/apiKey/.test(res.text) && !res.text.includes('x'.repeat(40)));
    assert.deepEqual(cap.lines.filter((l) => l.includes(KEY_A)), []);
  });

  test('leak test 2: a key row copied onto another connection is unreadable there', async () => {
    const first = (await pm.request('POST', url(), { modelRef: model, label: 'One', apiKey: KEY_A, reason: 'Project key' })).body.connection.id;
    const second = (await pm.request('POST', url(), { modelRef: model, label: 'Two', apiKey: KEY_B, reason: 'Project key' })).body.connection.id;
    const list = (await pm.request('GET', url())).body.connections;
    assert.deepEqual(list.map((c: any) => c.state), ['ready', 'ready']);
    // The copy: the second connection's current key row is replaced by the first connection's sealed bytes (same protected key id).
    const src = (await t.pool.query(`SELECT ciphertext, nonce, tag, key_id FROM ai_connection_keys WHERE connection_id = $1`, [first])).rows[0];
    await t.pool.query(`UPDATE ai_connection_keys SET superseded_at = now() WHERE connection_id = $1 AND superseded_at IS NULL`, [second]);
    await t.pool.query(
      `INSERT INTO ai_connection_keys (id, connection_id, ciphertext, nonce, tag, key_id, saved_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
      [second, src.ciphertext, src.nonce, src.tag, src.key_id],
    );
    const after = (await pm.request('GET', url())).body.connections;
    assert.equal(after.find((c: any) => c.id === first).state, 'ready');
    const copied = after.find((c: any) => c.id === second);
    assert.equal(copied.state, 'key_unreadable');
    assert.equal(copied.stateLabel, 'Key unreadable — enter it again');
    assert.equal((await pm.request('POST', url(`/${second}/check`), { reason: 'x' })).status, 409);
  });
});
