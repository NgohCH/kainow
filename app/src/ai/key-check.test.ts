import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { loadProtectedKey } from '../quarantine/protected-key';
import { checkKey, keyReadable, type ModelLister } from './key-check';
import { sealApiKey } from './keys';

const KEY = `sk-test-${'x'.repeat(40)}`;
const reply = (status: number) => (async () => new Response(status === 200 ? '{"id":"m"}' : '{"error":"no"}', { status })) as unknown as typeof fetch;
const sdkThatThrows = (status: number): ModelLister =>
  ({ models: { retrieve: async () => { throw new Anthropic.APIError(status, undefined, 'x', new Headers()); } } }) as unknown as ModelLister;

test('OpenAI: 200 is ok, 401 and 403 refused, 404 no_model, 500 and 429 unreachable', async () => {
  assert.deepEqual(await checkKey('openai', KEY, 'gpt-test-1', 1000, reply(200)), { outcome: 'ok' });
  assert.deepEqual(await checkKey('openai', KEY, 'gpt-test-1', 1000, reply(401)), { outcome: 'refused', status: 401 });
  assert.deepEqual(await checkKey('openai', KEY, 'gpt-test-1', 1000, reply(403)), { outcome: 'refused', status: 403 });
  assert.deepEqual(await checkKey('openai', KEY, 'gpt-test-1', 1000, reply(404)), { outcome: 'no_model' });
  assert.deepEqual(await checkKey('openai', KEY, 'gpt-test-1', 1000, reply(503)), { outcome: 'unreachable' });
  assert.deepEqual(await checkKey('openai', KEY, 'gpt-test-1', 1000, reply(429)), { outcome: 'unreachable' });
});

test('OpenAI: GET /v1/models/{id} with a Bearer header; a timeout or a network error is unreachable', async () => {
  let seen: { url: string; method?: string; auth?: string } | undefined;
  const spy = (async (url: string, init: RequestInit) => {
    seen = { url, method: init.method, auth: (init.headers as Record<string, string>).Authorization };
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  await checkKey('openai', KEY, 'gpt/test 1', 1000, spy);
  assert.deepEqual(seen, { url: 'https://api.openai.com/v1/models/gpt%2Ftest%201', method: 'GET', auth: `Bearer ${KEY}` });
  const slow = ((_u: string, init: RequestInit) =>
    new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(init.signal?.reason)))) as unknown as typeof fetch;
  // AbortSignal.timeout's timer does not hold the event loop open, and the fake fetch has no socket that would;
  // without this the test runner (Node 22) sees an idle loop and cancels the test before the abort fires.
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    assert.deepEqual(await checkKey('openai', KEY, 'gpt-test-1', 20, slow), { outcome: 'unreachable' });
  } finally {
    clearInterval(keepAlive);
  }
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  assert.deepEqual(await checkKey('openai', KEY, 'gpt-test-1', 1000, down), { outcome: 'unreachable' });
});

test('Anthropic: models.retrieve decides; 401 refused, 404 no_model, 5xx and connection errors unreachable', async () => {
  const seen: unknown[] = [];
  const ok = { models: { retrieve: async (id: string, _p: unknown, o: unknown) => { seen.push([id, o]); return {}; } } } as unknown as ModelLister;
  assert.deepEqual(await checkKey('anthropic', KEY, 'claude-test-1', 1000, undefined, ok), { outcome: 'ok' });
  assert.deepEqual(seen, [['claude-test-1', { maxRetries: 0, timeout: 1000 }]]);
  assert.deepEqual(await checkKey('anthropic', KEY, 'c', 1000, undefined, sdkThatThrows(401)), { outcome: 'refused', status: 401 });
  assert.deepEqual(await checkKey('anthropic', KEY, 'c', 1000, undefined, sdkThatThrows(403)), { outcome: 'refused', status: 403 });
  assert.deepEqual(await checkKey('anthropic', KEY, 'c', 1000, undefined, sdkThatThrows(404)), { outcome: 'no_model' });
  assert.deepEqual(await checkKey('anthropic', KEY, 'c', 1000, undefined, sdkThatThrows(529)), { outcome: 'unreachable' });
  const timeout = { models: { retrieve: async () => { throw new Anthropic.APIConnectionTimeoutError(); } } } as unknown as ModelLister;
  assert.deepEqual(await checkKey('anthropic', KEY, 'c', 1000, undefined, timeout), { outcome: 'unreachable' });
});

test('keyReadable: true for the same binding, false for another connection, another key or garbage', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'kc-'));
  const mk = () => {
    const p = require('node:path').join(dir, `${Math.random()}.key`);
    require('node:fs').writeFileSync(p, randomBytes(32));
    return loadProtectedKey(p)!;
  };
  const a = mk();
  const b = mk();
  const bind = { connectionId: 'c1', projectId: 'p1', provider: 'openai' as const };
  const sealed = sealApiKey(a, KEY, bind);
  assert.equal(keyReadable(a, sealed, bind), true);
  assert.equal(keyReadable(a, sealed, { ...bind, connectionId: 'c2' }), false);
  assert.equal(keyReadable(a, sealed, { ...bind, provider: 'anthropic' }), false);
  assert.equal(keyReadable(b, sealed, bind), false);
  assert.equal(keyReadable(a, { ...sealed, tag: Buffer.alloc(16) }, bind), false);
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});
