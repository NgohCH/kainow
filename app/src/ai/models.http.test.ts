import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';

const BODY = {
  provider: 'openai',
  modelId: 'gpt-test-1',
  displayName: 'GPT Test One',
  inputUsdPerMillion: '2.00',
  cachedInputUsdPerMillion: '0.10',
  cacheWriteUsdPerMillion: '0',
  outputUsdPerMillion: '10.00',
  dataTerms: 'Not used for training; retained 30 days.',
  purposes: ['extraction', 'summary_draft'],
  restrictedOk: false,
  reason: 'Reviewed the provider terms',
};

describe('approved model catalogue over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org', 'member');
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t.close();
  });

  const events = async (id: string) => (await t.pool.query(`SELECT * FROM ai_model_events WHERE model_ref = $1 ORDER BY at, id`, [id])).rows;

  test('a non-Administrator gets 403 on POST, and 401 when signed out', async () => {
    const member = await t.signIn('member@example.org');
    assert.equal((await member.request('POST', '/ai/models', BODY)).status, 403);
    assert.equal((await member.request('GET', '/ai/models')).status, 403);
    assert.equal((await t.anonymous('POST', '/ai/models', BODY)).status, 401);
  });

  test('approving records an event with the reason and the new values; the list shows it', async () => {
    const res = await admin.request('POST', '/ai/models', BODY);
    assert.equal(res.status, 201);
    assert.equal(res.body.model.state, 'approved');
    assert.equal(res.body.model.prices.inputUsdPerMillion, '2.000000');
    const ev = await events(res.body.model.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].action, 'approved');
    assert.equal(ev[0].reason, 'Reviewed the provider terms');
    assert.equal(ev[0].detail.previous, null);
    assert.equal(ev[0].detail.new.modelId, 'gpt-test-1');
    assert.deepEqual(ev[0].detail.new.purposes, ['extraction', 'summary_draft']);
    const list = await admin.request('GET', '/ai/models');
    assert.equal(list.status, 200);
    assert.equal(list.body.models.some((m: any) => m.id === res.body.model.id), true);
  });

  test('approving the same provider and model twice gives 409; re-approving a withdrawn one reuses its id', async () => {
    const first = await admin.request('POST', '/ai/models', BODY);
    assert.equal((await admin.request('POST', '/ai/models', BODY)).status, 409);
    const id = first.body.model.id;
    t.clock.advanceSeconds(5);
    assert.equal((await admin.request('POST', `/ai/models/${id}/withdraw`, { reason: 'Contract ended' })).status, 200);
    t.clock.advanceSeconds(5);
    const again = await admin.request('POST', '/ai/models', { ...BODY, displayName: 'Renamed', inputUsdPerMillion: '3' });
    assert.equal(again.status, 201);
    assert.equal(again.body.model.id, id);
    assert.equal(again.body.model.state, 'approved');
    assert.equal(again.body.model.displayName, 'Renamed');
    assert.deepEqual((await events(id)).map((e) => e.action), ['approved', 'withdrawn', 'reapproved']);
  });

  test('purposes outside the six, duplicates and bad values are refused with 400', async () => {
    assert.equal((await admin.request('POST', '/ai/models', { ...BODY, purposes: ['extraction', 'poetry'] })).status, 400);
    assert.equal((await admin.request('POST', '/ai/models', { ...BODY, purposes: ['extraction', 'extraction'] })).status, 400);
    assert.equal((await admin.request('POST', '/ai/models', { ...BODY, provider: 'other' })).status, 400);
    assert.equal((await admin.request('POST', '/ai/models', { ...BODY, inputUsdPerMillion: '-1' })).status, 400);
    assert.equal((await admin.request('POST', '/ai/models', { ...BODY, reason: '   ' })).status, 400);
    assert.equal((await admin.request('POST', '/ai/models', { ...BODY, restrictedOk: 'yes' })).status, 400);
  });

  test('data terms or a reason holding a key are refused with the credential wording', async () => {
    const terms = await admin.request('POST', '/ai/models', { ...BODY, dataTerms: 'Use key AKIAABCDEFGHIJKLMNOP for access' });
    assert.equal(terms.status, 400);
    assert.match(JSON.stringify(terms.body), /looks like it contains/);
    const reason = await admin.request('POST', '/ai/models', { ...BODY, reason: 'AKIAABCDEFGHIJKLMNOP' });
    assert.equal(reason.status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM ai_models`)).rows[0].n, 0);
  });

  test('withdraw sets the state, needs a reason, and a second withdraw is 409', async () => {
    const id = (await admin.request('POST', '/ai/models', BODY)).body.model.id;
    assert.equal((await admin.request('POST', `/ai/models/${id}/withdraw`, {})).status, 400);
    assert.equal((await admin.request('POST', `/ai/models/${id}/withdraw`, { reason: ' ' })).status, 400);
    const ok = await admin.request('POST', `/ai/models/${id}/withdraw`, { reason: 'Contract ended' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.model.state, 'withdrawn');
    assert.equal((await t.pool.query(`SELECT state FROM ai_models WHERE id = $1`, [id])).rows[0].state, 'withdrawn');
    assert.equal((await admin.request('POST', `/ai/models/${id}/withdraw`, { reason: 'Again' })).status, 409);
    assert.equal((await admin.request('POST', `/ai/models/${uuidv7()}/withdraw`, { reason: 'x' })).status, 404);
  });

  test('change updates the other fields, logs previous and new values, and cannot change the identity', async () => {
    const id = (await admin.request('POST', '/ai/models', BODY)).body.model.id;
    assert.equal((await admin.request('PUT', `/ai/models/${id}`, { ...BODY, modelId: 'other-model', reason: 'rename' })).status, 400);
    assert.equal((await admin.request('PUT', `/ai/models/${id}`, { ...BODY, provider: 'anthropic', reason: 'switch' })).status, 400);
    t.clock.advanceSeconds(5);
    const ok = await admin.request('PUT', `/ai/models/${id}`, { ...BODY, outputUsdPerMillion: '12.5', restrictedOk: true, reason: 'Price rise' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.model.prices.outputUsdPerMillion, '12.500000');
    assert.equal(ok.body.model.restrictedOk, true);
    const ev = (await events(id)).at(-1);
    assert.equal(ev.action, 'changed');
    assert.equal(ev.reason, 'Price rise');
    assert.equal(ev.detail.previous.prices.outputUsdPerMillion, '10.000000');
    assert.equal(ev.detail.new.prices.outputUsdPerMillion, '12.500000');
    assert.equal((await admin.request('PUT', `/ai/models/${uuidv7()}`, { ...BODY, reason: 'x' })).status, 404);
  });

  test('a price change leaves an existing spend entry snapshot unchanged', async () => {
    const id = (await admin.request('POST', '/ai/models', BODY)).body.model.id;
    const entry = uuidv7();
    await t.pool.query(
      `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, model_id,
         input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro, myr_per_usd_micro,
         estimate_micro_myr, amount_micro_myr, ruled)
       VALUES ($1, $2, 1, now(), now(), 'confirmed', 'extraction', 'gpt-test-1', 2000000, 100000, 10000000, 4100000, 5, 5, false)`,
      [entry, uuidv7()],
    );
    const res = await admin.request('PUT', `/ai/models/${id}`, { ...BODY, inputUsdPerMillion: '99', outputUsdPerMillion: '99', reason: 'Price rise' });
    assert.equal(res.status, 200);
    const row = (await t.pool.query(`SELECT input_usd_per_million_micro::text AS i, output_usd_per_million_micro::text AS o FROM ai_spend_entries WHERE id = $1`, [entry])).rows[0];
    assert.deepEqual(row, { i: '2000000', o: '10000000' });
  });
});
