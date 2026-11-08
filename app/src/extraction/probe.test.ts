import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAiModelClient } from './model';
import { runProbe } from './probe';

const okBody = {
  usage: { prompt_tokens: 120, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [{ kind: 'action', text: 't', owner: null, due: null, source_quote: 'Sam will send the budget.' }] }) } }],
};
const fetchOf = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test('a working call reports the item count and the token usage', async () => {
  const client = new OpenAiModelClient('key', 'http://x', fetchOf(okBody));
  const r = await runProbe(client, 'gpt-6.1-sol');
  assert.equal(r.ok, true);
  assert.match(r.report, /1 item/);
  assert.match(r.report, /120 input/);
  assert.match(r.report, /15 output/);
});

test('a refused call reports the status and says what it means, without the key', async () => {
  const client = new OpenAiModelClient('sk-secretsecretsecretsecret', 'http://x', fetchOf({ error: 'nope' }, 401));
  const r = await runProbe(client, 'gpt-6.1-sol');
  assert.equal(r.ok, false);
  assert.match(r.report, /401/);
  assert.ok(!r.report.includes('secretsecret'));
});

test('a usage-less answer is reported as the adapter problem it is', async () => {
  const client = new OpenAiModelClient('key', 'http://x', fetchOf({ choices: okBody.choices }));
  const r = await runProbe(client, 'gpt-6.1-sol');
  assert.equal(r.ok, false);
  assert.match(r.report, /usage/);
});

test('an unexpected error is not swallowed', async () => {
  const client = { extract: async () => { throw new TypeError('boom'); } };
  await assert.rejects(runProbe(client, 'm'), TypeError);
});
