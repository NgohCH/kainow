import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { realClientFactory } from './client-factory';
import { checkKey } from './key-check';

/**
 * P19 / C38 (final review I2): the provider clients take nothing from the environment. A base URL, a log level or an auth
 * token set there must not redirect a project's key, log a request body, or replace the key. No request leaves the process:
 * the global fetch is replaced by a recorder for each test.
 */

const KEY = `sk-test-${'x'.repeat(40)}`;
const BODY = 'USER-SECRET-BODY';
const REQ = { modelId: 'model-test-1', system: 'SYS', user: BODY, maxOutputTokens: 100, timeoutMs: 1000 };
const SCHEMA = { name: 'n', strict: true, schema: { type: 'object', properties: {} } };

const ENV = {
  ANTHROPIC_BASE_URL: 'https://elsewhere.example.org',
  ANTHROPIC_LOG: 'debug',
  ANTHROPIC_AUTH_TOKEN: 'env-token-not-the-key',
  ANTHROPIC_API_KEY: 'env-key-not-the-key',
  OPENAI_BASE_URL: 'https://elsewhere.example.org/v1',
  OPENAI_API_KEY: 'env-key-not-the-key',
  OPENAI_LOG: 'debug',
};

type Seen = { url: string; headers: Headers };
let seen: Seen[];
let logged: string[];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const realConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));

/** Answers like the provider would: a model for a lookup, a JSON message or completion for a call. */
function answer(url: string): Response {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const text = JSON.stringify({ meeting_date: null, items: [] });
  if (url.includes('/v1/models/')) return json({ id: 'model-test-1', type: 'model' });
  if (url.includes('/chat/completions')) {
    return json({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }
  return json({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
}

beforeEach(() => {
  seen = [];
  logged = [];
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    return answer(url);
  }) as typeof fetch;
  for (const m of consoleMethods) console[m] = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const m of consoleMethods) console[m] = realConsole[m];
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The SDK sends the key as a Bearer header; an environment token or key would show here instead. */
const authOf = (h: Headers) => [h.get('authorization'), h.get('x-api-key')];

test('Anthropic calls go to api.anthropic.com with the project key and log nothing, whatever the environment says', async () => {
  await realClientFactory.forAttempt({ provider: 'anthropic', apiKey: KEY, timeoutMs: 1000 }).callJson(REQ, SCHEMA);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.startsWith('https://api.anthropic.com/'), seen[0].url);
  assert.deepEqual(authOf(seen[0].headers), [`Bearer ${KEY}`, null], 'the project key, not an environment token or key');
  assert.deepEqual(logged, [], 'nothing is logged, so no request body reaches the log');
});

test('the Anthropic Check key goes to api.anthropic.com with the project key and logs nothing', async () => {
  assert.deepEqual(await checkKey('anthropic', KEY, 'model-test-1', 1000), { outcome: 'ok' });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.startsWith('https://api.anthropic.com/v1/models/model-test-1'), seen[0].url);
  assert.deepEqual(authOf(seen[0].headers), [`Bearer ${KEY}`, null]);
  assert.deepEqual(logged, []);
});

test('OpenAI calls and the Check key go to api.openai.com with the project key, whatever the environment says', async () => {
  await realClientFactory.forAttempt({ provider: 'openai', apiKey: KEY, timeoutMs: 1000 }).callJson(REQ, SCHEMA);
  assert.deepEqual(await checkKey('openai', KEY, 'model-test-1', 1000), { outcome: 'ok' });
  assert.deepEqual(
    seen.map((s) => [s.url, s.headers.get('authorization')]),
    [
      ['https://api.openai.com/v1/chat/completions', `Bearer ${KEY}`],
      ['https://api.openai.com/v1/models/model-test-1', `Bearer ${KEY}`],
    ],
  );
  assert.deepEqual(logged, []);
});

test('no Anthropic client is built anywhere but provider-clients.ts', () => {
  const root = resolve(__dirname, '..', '..', 'src');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && /new Anthropic\s*\(/.test(readFileSync(p, 'utf8'))) found.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  assert.deepEqual(found, ['ai/provider-clients.ts']);
});
