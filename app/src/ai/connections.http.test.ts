import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { KEY_A, KEY_B, ORG, keyFile, modelBody } from '../testing/ai-connections';
import { type KeyChecker, ConnectionsService } from './connections.service';
import { loadProtectedKey } from '../quarantine/protected-key';
import type { KeyCheck } from './key-check';

describe('project AI connections over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let dir: string;
  let admin: Client;
  let pm: Client;
  let deputy: Client;
  let ann: Client;
  let outsider: Client;
  let projectId: string;
  let openaiModel: string;
  let anthropicModel: string;
  let svc: ConnectionsService;
  let calls: Array<[string, string, string]>;
  let answer: KeyCheck;
  const url = (suffix = '', id = projectId) => `/projects/${id}/ai/connections${suffix}`;
  const checker: KeyChecker = async (provider, apiKey, modelId) => {
    calls.push([provider, apiKey, modelId]);
    return answer;
  };
  const putOrg = (patch: Record<string, unknown> = {}) => admin.request('PUT', '/ai/spend-settings', { ...ORG, ...patch });
  const add = (client: Client, patch: Record<string, unknown> = {}) =>
    client.request('POST', url(), { modelRef: openaiModel, label: 'Main key', apiKey: KEY_A, reason: 'Project key for extraction', ...patch });
  const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kainow-conn-'));
    t = await startTestApp(undefined, { protectedKeyFile: keyFile(dir) });
    const ids: Record<string, string> = {};
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['owner', 'pm', 'deputy', 'ann', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    deputy = await t.signIn('deputy@example.org');
    ann = await t.signIn('ann@example.org');
    outsider = await t.signIn('outsider@example.org');
    openaiModel = (await admin.request('POST', '/ai/models', modelBody('openai', 'gpt-test-1'))).body.model.id;
    anthropicModel = (await admin.request('POST', '/ai/models', modelBody('anthropic', 'claude-test-1'))).body.model.id;
    await putOrg({ projectsMayManageConnections: true });
    calls = [];
    answer = { outcome: 'ok' };
    svc = t.app.get(ConnectionsService);
    svc.keyChecker = checker;
  });
  afterEach(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a key the provider refuses gives 400 and stores nothing; no_model names the model; unreachable saves as unchecked', async () => {
    answer = { outcome: 'refused', status: 401 };
    const refused = await add(pm);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.message, 'The provider refused this key');
    answer = { outcome: 'no_model' };
    const missing = await add(pm);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.message, 'This key cannot use gpt-test-1');
    for (const table of ['ai_connections', 'ai_connection_keys', 'ai_connection_events']) {
      assert.equal((await rows(`SELECT count(*)::int AS n FROM ${table}`))[0].n, 0, table);
    }
    answer = { outcome: 'unreachable' };
    const saved = await add(pm);
    assert.equal(saved.status, 201);
    assert.equal(saved.body.connection.state, 'unchecked');
    assert.equal(saved.body.check.message, 'Could not reach OpenAI to check the key. It will be checked on first use.');
    assert.deepEqual(calls[0], ['openai', KEY_A, 'gpt-test-1']);
  });

  test('a good key saves as ready with its key sealed, an added event with the reason, and positions in order', async () => {
    const first = await add(pm);
    assert.equal(first.status, 201);
    assert.equal(first.body.connection.state, 'ready');
    assert.equal(first.body.connection.stateLabel, 'Ready');
    assert.equal(first.body.check.message, 'Key works and can use this model');
    const second = await add(pm, { modelRef: anthropicModel, label: 'Backup', apiKey: KEY_B });
    assert.equal(second.body.connection.position, 2);
    const k = await rows(`SELECT * FROM ai_connection_keys WHERE connection_id = $1`, [first.body.connection.id]);
    assert.equal(k.length, 1);
    assert.equal(k[0].superseded_at, null);
    assert.ok(!k[0].ciphertext.includes(Buffer.from(KEY_A)));
    const ev = await rows(`SELECT action, reason, detail FROM ai_connection_events WHERE connection_id = $1 ORDER BY at, id`, [first.body.connection.id]);
    assert.deepEqual(ev.map((e) => e.action).sort(), ['added', 'key_saved']);
    assert.ok(ev.every((e) => e.reason === 'Project key for extraction'));
    assert.ok(!JSON.stringify(ev).includes(KEY_A));
    const list = await pm.request('GET', url());
    assert.deepEqual(list.body.connections.map((c: any) => [c.label, c.position]), [['Main key', 1], ['Backup', 2]]);
  });

  test('add checks the body: label, reason, key shape, an approved model', async () => {
    for (const patch of [
      { label: ' ' },
      { label: 'x'.repeat(101) },
      { label: 'key sk-test-' + 'z'.repeat(40) },
      { reason: '' },
      { reason: undefined },
      { modelRef: 'not-a-uuid' },
      { modelRef: '0190a000-0000-7000-8000-000000000000' },
    ]) {
      assert.equal((await add(pm, patch)).status, 400, JSON.stringify(patch));
    }
    const bad = await add(pm, { apiKey: 'short' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, 'This does not look like an API key.');
    assert.equal((await add(pm, { apiKey: `sk-test-${'x'.repeat(10)} ${'x'.repeat(10)}` })).body.message, 'This does not look like an API key.');
    await admin.request('POST', `/ai/models/${openaiModel}/withdraw`, { reason: 'Retired' });
    assert.equal((await add(pm)).status, 400, 'a withdrawn model cannot be picked');
    assert.equal(calls.length, 0, 'nothing was checked for a bad body');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM ai_connections`))[0].n, 0);
  });

  test('replacing a key adds a row, supersedes the old one and records key_replaced without any key', async () => {
    const id = (await add(pm)).body.connection.id;
    t.clock.advanceSeconds(5);
    const res = await pm.request('PUT', url(`/${id}/key`, projectId), { apiKey: KEY_B, reason: 'Rotated after the audit' });
    assert.equal(res.status, 200);
    assert.equal(res.body.connection.state, 'ready');
    const keys = await rows(`SELECT id, superseded_at FROM ai_connection_keys WHERE connection_id = $1 ORDER BY saved_at, id`, [id]);
    assert.equal(keys.length, 2);
    assert.ok(keys[0].superseded_at);
    assert.equal(keys[1].superseded_at, null);
    const ev = await rows(`SELECT reason, detail FROM ai_connection_events WHERE connection_id = $1 AND action = 'key_replaced'`, [id]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].reason, 'Rotated after the audit');
    assert.ok(!JSON.stringify(ev).includes(KEY_A) && !JSON.stringify(ev).includes(KEY_B));
    answer = { outcome: 'refused', status: 403 };
    assert.equal((await pm.request('PUT', url(`/${id}/key`), { apiKey: KEY_A, reason: 'Try again' })).status, 400);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM ai_connection_keys WHERE connection_id = $1`, [id]))[0].n, 2, 'a refused replacement stores nothing');
    assert.equal((await pm.request('PUT', url(`/${id}/key`), { apiKey: 'short', reason: 'x' })).status, 400);
    assert.equal((await pm.request('PUT', url(`/${randomUuid()}/key`), { apiKey: KEY_A, reason: 'x' })).status, 404);
  });

  test('Check key: unchecked becomes ready; a refusal rejects; a rejected key is not freed by a passing check, only by a replaced key', async () => {
    answer = { outcome: 'unreachable' };
    const id = (await add(pm)).body.connection.id;
    assert.equal((await pm.request('GET', url())).body.connections[0].state, 'unchecked');
    answer = { outcome: 'ok' };
    calls = [];
    const ok = await pm.request('POST', url(`/${id}/check`), { reason: 'Looking again' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.connection.state, 'ready');
    assert.deepEqual(calls, [['openai', KEY_A, 'gpt-test-1']], 'the stored key is what is checked');
    answer = { outcome: 'refused', status: 401 };
    const refused = await pm.request('POST', url(`/${id}/check`), { reason: 'Looking again' });
    assert.equal(refused.body.connection.state, 'key_rejected');
    assert.equal(refused.body.connection.rejectedStatus, 401);
    assert.equal(refused.body.check.message, 'The provider refused this key');
    // The same rejected-key behaviour as a real call (Ruling P8): one key_rejected event and the notices, once.
    const rejectedEvents = async () => (await rows(`SELECT count(*)::int AS n FROM ai_connection_events WHERE connection_id = $1 AND action = 'key_rejected'`, [id]))[0].n;
    const notices = async () => rows(`SELECT user_id, summary FROM notifications WHERE kind = 'ai_key_rejected'`);
    assert.equal(await rejectedEvents(), 1);
    const sent = await notices();
    assert.ok(sent.length > 0, 'the Administrators and managers are told');
    for (const n of sent) {
      assert.match(n.summary, /^The OpenAI key for AI connection ".+" in .+ was refused, or this key may not use the model\./);
      assert.ok(!n.summary.includes(KEY_A));
    }
    assert.equal(new Set(sent.map((n) => n.user_id)).size, sent.length, 'one notice each');
    assert.equal((await pm.request('POST', url(`/${id}/check`), { reason: 'Looking again' })).body.connection.state, 'key_rejected');
    assert.equal(await rejectedEvents(), 1, 'a second refusal changes nothing');
    assert.equal((await notices()).length, sent.length);
    answer = { outcome: 'ok' };
    const again = await pm.request('POST', url(`/${id}/check`), { reason: 'Looking again' });
    assert.equal(again.body.check.outcome, 'ok');
    assert.equal(again.body.connection.state, 'key_rejected', 'a passing check does not return it to ready');
    const replaced = await pm.request('PUT', url(`/${id}/key`), { apiKey: KEY_B, reason: 'New key' });
    assert.equal(replaced.body.connection.state, 'ready');
    const row = (await rows(`SELECT rejected_at, rejected_status, rejection_notified_at FROM ai_connections WHERE id = $1`, [id]))[0];
    assert.deepEqual([row.rejected_at, row.rejected_status, row.rejection_notified_at], [null, null, null]);
    answer = { outcome: 'unreachable' };
    assert.equal((await pm.request('POST', url(`/${id}/check`), { reason: 'x' })).body.connection.state, 'ready');
    const events = await rows(`SELECT action, detail FROM ai_connection_events WHERE connection_id = $1 AND action = 'checked' ORDER BY at, id`, [id]);
    assert.equal(events.length, 5);
    assert.ok(!JSON.stringify(events).includes(KEY_A));
  });

  test('Check key on a key replaced during the check changes nothing and tells nobody (final review I4)', async () => {
    const id = (await add(pm)).body.connection.id;
    const keyEvents = async () => (await rows(`SELECT action FROM ai_connection_events WHERE connection_id = $1 AND action IN ('checked', 'key_rejected')`, [id])).length;
    // The old key is refused while, during the provider round trip, the key is replaced with one that cannot be checked yet.
    svc.keyChecker = async (provider, apiKey, modelId) => {
      calls.push([provider, apiKey, modelId]);
      if (apiKey === KEY_B) return { outcome: 'unreachable' };
      t.clock.advanceSeconds(1);
      assert.equal((await pm.request('PUT', url(`/${id}/key`), { apiKey: KEY_B, reason: 'Rotated' })).status, 200);
      return { outcome: 'refused', status: 401 };
    };
    const refused = await pm.request('POST', url(`/${id}/check`), { reason: 'Looking again' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /replaced while it was being checked/);
    let conn = (await rows(`SELECT state, rejected_at FROM ai_connections WHERE id = $1`, [id]))[0];
    assert.deepEqual([conn.state, conn.rejected_at], ['unchecked', null], 'the new key is not marked rejected');
    assert.equal(await keyEvents(), 0);
    assert.deepEqual(await rows(`SELECT id FROM notifications WHERE kind = 'ai_key_rejected'`), [], 'nobody is told the new key was refused');

    // The other way round: the old key passes while the new one is unverified; the new one is not made ready.
    svc.keyChecker = async (provider, apiKey, modelId) => {
      calls.push([provider, apiKey, modelId]);
      if (apiKey === KEY_A) return { outcome: 'unreachable' };
      t.clock.advanceSeconds(1);
      assert.equal((await pm.request('PUT', url(`/${id}/key`), { apiKey: KEY_A, reason: 'Rotated back' })).status, 200);
      return { outcome: 'ok' };
    };
    assert.equal((await pm.request('POST', url(`/${id}/check`), { reason: 'Looking again' })).status, 409);
    conn = (await rows(`SELECT state FROM ai_connections WHERE id = $1`, [id]))[0];
    assert.equal(conn.state, 'unchecked');
    assert.equal(await keyEvents(), 0);
  });

  test('a refused Check key on a disabled connection is kept, so enabling it gives key_rejected (final review I4)', async () => {
    const id = (await add(pm)).body.connection.id;
    assert.equal((await pm.request('POST', url(`/${id}/disable`), { reason: 'Pause' })).body.connection.state, 'disabled');
    answer = { outcome: 'refused', status: 401 };
    const refused = await pm.request('POST', url(`/${id}/check`), { reason: 'Before enabling' });
    assert.equal(refused.status, 200);
    assert.equal(refused.body.connection.state, 'disabled', 'a disabled connection stays disabled');
    assert.equal(refused.body.connection.rejectedStatus, 401);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM ai_connection_events WHERE connection_id = $1 AND action = 'key_rejected'`, [id]))[0].n, 1);
    t.clock.advanceSeconds(1);
    assert.equal((await pm.request('POST', url(`/${id}/enable`), { reason: 'Back on' })).body.connection.state, 'key_rejected');
  });

  test('enabling after a key replaced while disabled is ready only when the new key passed its check (final review I4)', async () => {
    const id = (await add(pm)).body.connection.id;
    assert.equal((await pm.request('POST', url(`/${id}/disable`), { reason: 'Rotating' })).status, 200);
    t.clock.advanceSeconds(1);
    answer = { outcome: 'unreachable' };
    assert.equal((await pm.request('PUT', url(`/${id}/key`), { apiKey: KEY_B, reason: 'New key' })).body.connection.state, 'disabled');
    t.clock.advanceSeconds(1);
    assert.equal((await pm.request('POST', url(`/${id}/enable`), { reason: 'Back on' })).body.connection.state, 'unchecked', 'the new key is unverified');

    t.clock.advanceSeconds(1);
    assert.equal((await pm.request('POST', url(`/${id}/disable`), { reason: 'Rotating again' })).status, 200);
    t.clock.advanceSeconds(1);
    answer = { outcome: 'ok' };
    assert.equal((await pm.request('PUT', url(`/${id}/key`), { apiKey: KEY_A, reason: 'Checked key' })).status, 200);
    t.clock.advanceSeconds(1);
    assert.equal((await pm.request('POST', url(`/${id}/enable`), { reason: 'Back on' })).body.connection.state, 'ready', 'the new key passed its check');

    // A connection disabled while ready, with no key change, returns ready.
    t.clock.advanceSeconds(1);
    assert.equal((await pm.request('POST', url(`/${id}/disable`), { reason: 'Pause' })).status, 200);
    t.clock.advanceSeconds(1);
    assert.equal((await pm.request('POST', url(`/${id}/enable`), { reason: 'Back on' })).body.connection.state, 'ready');
  });

  test('reordering swaps positions atomically; the list must name every connection once', async () => {
    const ids: string[] = [];
    for (const label of ['One', 'Two', 'Three']) ids.push((await add(pm, { label })).body.connection.id);
    const res = await pm.request('PUT', url('/order'), { ids: [ids[2], ids[1], ids[0]], reason: 'Cheaper model first' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.connections.map((c: any) => c.label), ['Three', 'Two', 'One']);
    assert.deepEqual((await rows(`SELECT label, position FROM ai_connections ORDER BY position`)).map((r) => [r.label, r.position]), [['Three', 1], ['Two', 2], ['One', 3]]);
    const ev = await rows(`SELECT detail FROM ai_connection_events WHERE action = 'reordered'`);
    assert.equal(ev.length, 2, 'only the two that moved');
    for (const bad of [[ids[0], ids[1]], [ids[0], ids[0], ids[1]], [...ids, ids[0]], [ids[0], ids[1], randomUuid()], ['x', 'y', 'z']]) {
      assert.equal((await pm.request('PUT', url('/order'), { ids: bad, reason: 'x' })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await pm.request('PUT', url('/order'), { ids, reason: '' })).status, 400);
    assert.deepEqual((await rows(`SELECT position FROM ai_connections ORDER BY position`)).map((r) => r.position), [1, 2, 3]);
  });

  test('the header meter is null, not a meter without figures, while no AI settings are saved', async () => {
    const withSettings = (await pm.request('GET', `/ai/spend?projectId=${projectId}`)).body.meter;
    assert.equal(withSettings.kind, 'project');
    assert.equal(withSettings.limitMyr, null, 'no project limits: no allowance, but with figures');
    assert.equal(typeof withSettings.remainingMyr, 'string');
    await t.pool.query(`DELETE FROM ai_spend_settings`);
    const r = await pm.request('GET', `/ai/spend?projectId=${projectId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.meter, null);
    assert.equal((await ann.request('GET', `/ai/spend?projectId=${projectId}`)).body.meter, null);
  });

  test('a Deputy can see connections and the approved models but not change them; a delegate with the switch off cannot; the Administrator always can', async () => {
    const id = (await add(pm)).body.connection.id;
    const seen = await deputy.request('GET', url());
    assert.equal(seen.status, 200);
    assert.equal(seen.body.editable, false);
    assert.equal(seen.body.mayDisable, false, 'a Deputy may not disable');
    assert.equal(seen.body.connections.length, 1);
    assert.deepEqual(Object.keys(seen.body.models[0]).sort(), ['displayName', 'id', 'modelId', 'provider', 'purposes', 'restrictedOk']);
    assert.equal(seen.body.models.length, 2);
    assert.equal((await add(deputy)).status, 403);
    assert.equal((await deputy.request('POST', url(`/${id}/disable`), { reason: 'x' })).status, 403);
    assert.equal((await deputy.request('PUT', url('/order'), { ids: [id], reason: 'x' })).status, 403);
    assert.equal((await deputy.request('PUT', url(`/${id}/key`), { apiKey: KEY_B, reason: 'x' })).status, 403);
    assert.equal((await deputy.request('POST', url(`/${id}/check`), { reason: 'x' })).status, 403);

    assert.equal((await ann.request('GET', url())).status, 403);
    assert.equal((await outsider.request('GET', url())).status, 404);
    assert.equal((await t.anonymous('GET', url())).status, 401);
    assert.equal((await t.anonymous('POST', url(), { modelRef: openaiModel, label: 'x', apiKey: KEY_A, reason: 'x' })).status, 401);

    await putOrg({ projectsMayManageConnections: false });
    assert.equal((await pm.request('GET', url())).body.editable, false);
    assert.equal((await pm.request('GET', url())).body.mayDisable, false, 'delegation off');
    const off = await add(pm, { label: 'Second' });
    assert.equal(off.status, 403);
    assert.equal(off.body.message, 'The Administrator has not allowed projects to manage their own AI connections.');
    assert.equal((await pm.request('POST', url(`/${id}/disable`), { reason: 'x' })).status, 403);
    const byAdmin = await add(admin, { label: 'By admin' });
    assert.equal(byAdmin.status, 201);
    assert.equal((await admin.request('GET', url())).body.editable, true);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM ai_connections`))[0].n, 2);
  });

  test('while Deferred or Closed changes are refused but disable is allowed; Draft is open', async () => {
    const id = (await add(pm)).body.connection.id;
    for (const status of ['deferred', 'closed']) {
      await t.pool.query(`UPDATE projects SET status = $2, closure_outcome = $3 WHERE id = $1`, [projectId, status, status === 'closed' ? 'abandoned' : null]);
      assert.equal((await add(pm, { label: 'Late' })).status, 403, status);
      assert.equal((await add(admin, { label: 'Late' })).status, 403, status);
      assert.equal((await pm.request('PUT', url(`/${id}/key`), { apiKey: KEY_B, reason: 'x' })).status, 403);
      assert.equal((await pm.request('POST', url(`/${id}/check`), { reason: 'x' })).status, 403);
      assert.equal((await pm.request('PUT', url('/order'), { ids: [id], reason: 'x' })).status, 403);
      assert.equal((await pm.request('GET', url())).status, 200);
      assert.equal((await pm.request('GET', url())).body.editable, false);
      assert.equal((await pm.request('GET', url())).body.mayDisable, true, `${status}: disable stays open`);
      const off = await pm.request('POST', url(`/${id}/disable`), { reason: `Protective stop while ${status}` });
      assert.equal(off.status, 200, status);
      assert.equal(off.body.connection.state, 'disabled');
      assert.equal((await pm.request('POST', url(`/${id}/enable`), { reason: 'x' })).status, 403, 'enabling is a change');
      await t.pool.query(`UPDATE projects SET status = 'active', closure_outcome = NULL WHERE id = $1`, [projectId]);
      const on = await pm.request('POST', url(`/${id}/enable`), { reason: 'Back in use' });
      assert.equal(on.body.connection.state, 'ready', 'returns to what it was');
    }
    await t.pool.query(`UPDATE projects SET status = 'draft' WHERE id = $1`, [projectId]);
    assert.equal((await add(pm, { label: 'In draft' })).status, 201);
  });

  test('disable and enable keep a rejected key rejected; disabling twice is refused', async () => {
    const id = (await add(pm)).body.connection.id;
    answer = { outcome: 'refused', status: 403 };
    await pm.request('POST', url(`/${id}/check`), { reason: 'x' });
    assert.equal((await pm.request('POST', url(`/${id}/disable`), { reason: 'x' })).body.connection.state, 'disabled');
    assert.equal((await pm.request('POST', url(`/${id}/disable`), { reason: 'x' })).status, 409);
    assert.equal((await pm.request('POST', url(`/${id}/enable`), { reason: 'x' })).body.connection.state, 'key_rejected');
    assert.equal((await pm.request('POST', url(`/${id}/enable`), { reason: 'x' })).status, 409);
    assert.equal((await pm.request('POST', url(`/${id}/disable`), {})).status, 400, 'a reason is required');
  });

  test('a withdrawn model lists as model_withdrawn', async () => {
    await add(pm);
    await admin.request('POST', `/ai/models/${openaiModel}/withdraw`, { reason: 'Retired' });
    const c = (await pm.request('GET', url())).body.connections[0];
    assert.equal(c.state, 'model_withdrawn');
    assert.equal(c.stateLabel, 'Model withdrawn');
    assert.equal(c.storedState, 'ready');
    assert.equal((await pm.request('GET', url())).body.models.length, 1, 'a withdrawn model cannot be picked');
  });

  test('with no protected key add is refused and the list says waiting for the protected key; another key id is unreadable', async () => {
    const id = (await add(pm)).body.connection.id;
    const internals = svc as unknown as { protectedKey: unknown };
    const real = internals.protectedKey;
    const other = loadProtectedKey(keyFile(dir, 'other.key'));
    internals.protectedKey = other;
    const unreadable = (await pm.request('GET', url())).body.connections[0];
    assert.equal(unreadable.state, 'key_unreadable');
    assert.equal(unreadable.stateLabel, 'Key unreadable — enter it again');
    assert.equal((await pm.request('POST', url(`/${id}/check`), { reason: 'x' })).status, 409);
    internals.protectedKey = null;
    const waiting = await pm.request('GET', url());
    assert.equal(waiting.body.connections[0].state, 'waiting_for_key');
    assert.equal(waiting.body.connections[0].stateLabel, 'Waiting for the protected key');
    assert.equal(waiting.body.protectedKeyLoaded, false);
    const refused = await add(pm, { label: 'No key' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, 'AI keys cannot be saved until the protected key is installed. See INSTALL.md.');
    assert.equal((await pm.request('PUT', url(`/${id}/key`), { apiKey: KEY_B, reason: 'x' })).status, 409);
    internals.protectedKey = real;
    assert.equal((await pm.request('GET', url())).body.connections[0].state, 'ready');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM ai_connections`))[0].n, 1);
  });

  test('the list never has a field holding a key, its ciphertext or its key id', async () => {
    await add(pm);
    const text = JSON.stringify((await pm.request('GET', url())).body);
    assert.ok(!text.includes(KEY_A));
    assert.ok(!/ciphertext|nonce|"tag"|apiKey|key_id|keyId/i.test(text));
    const k = (await rows(`SELECT ciphertext, key_id FROM ai_connection_keys`))[0];
    assert.ok(!text.includes(k.ciphertext.toString('base64')) && !text.includes(k.ciphertext.toString('hex')) && !text.includes(k.key_id));
  });
});

describe('project AI connections without a protected key file', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await startTestApp();
  });
  afterEach(async () => {
    await t?.close();
  });

  test('add is refused with the install message and nothing is stored', async () => {
    const admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    const adminClient = await t.signIn('admin@example.org');
    const projectId = await seedProject(t.pool, { status: 'active', members: [{ userId: admin, role: 'pm' }] });
    const model = (await adminClient.request('POST', '/ai/models', modelBody('openai', 'gpt-test-1'))).body.model.id;
    t.app.get(ConnectionsService).keyChecker = async () => ({ outcome: 'ok' });
    const res = await adminClient.request('POST', `/projects/${projectId}/ai/connections`, { modelRef: model, label: 'Main', apiKey: KEY_A, reason: 'Set up' });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, 'AI keys cannot be saved until the protected key is installed. See INSTALL.md.');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM ai_connections`)).rows[0].n, 0);
  });
});

function randomUuid(): string {
  return require('node:crypto').randomUUID();
}
