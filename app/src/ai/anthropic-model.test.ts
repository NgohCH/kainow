import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { ModelBadResponse, ModelCallError } from '../extraction/model';
import { AnthropicModelClient } from './anthropic-model';
import { realClientFactory } from './client-factory';

const KEY = `sk-ant-test-${'x'.repeat(40)}`;
const REQ = { modelId: 'claude-test', system: 'SYS', user: 'USER-SECRET-BODY', maxOutputTokens: 777, timeoutMs: 45000 };
const SCHEMA = { type: 'object', properties: {} };
const answer = JSON.stringify({ meeting_date: null, items: [] });

type Call = { params: any; options: any };
function fake(result: () => unknown, calls: Call[] = []): Pick<Anthropic, 'messages'> {
  return {
    messages: {
      create: async (params: any, options: any) => {
        calls.push({ params, options });
        return result();
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
}
const msg = (over: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text: answer }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 50 },
  ...over,
});
const failing = (err: Error) =>
  fake(() => {
    throw err;
  });
const apiError = (status: number) =>
  Anthropic.APIError.generate(status, { error: { message: `echo ${REQ.user} ${KEY}` } }, `echo ${REQ.user} ${KEY}`, new Headers());

async function fails(sdk: Pick<Anthropic, 'messages'>): Promise<ModelCallError> {
  try {
    await new AnthropicModelClient(KEY, 1000, sdk).callJson(REQ, SCHEMA);
  } catch (e) {
    assert.ok(e instanceof ModelCallError, String(e));
    assert.ok(!e.message.includes(KEY) && !e.message.includes('USER-SECRET'));
    return e;
  }
  assert.fail('expected a ModelCallError');
}

test('sends system, one user message, max_tokens and output_config.format json_schema', async () => {
  const calls: Call[] = [];
  await new AnthropicModelClient(KEY, 1000, fake(() => msg(), calls)).callJson(REQ, SCHEMA);
  assert.deepEqual(calls[0].params, {
    model: 'claude-test',
    system: 'SYS',
    messages: [{ role: 'user', content: 'USER-SECRET-BODY' }],
    max_tokens: 777,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  });
});

test('maxRetries 0 and timeout from the attempt', async () => {
  const calls: Call[] = [];
  await new AnthropicModelClient(KEY, 1000, fake(() => msg(), calls)).callJson(REQ, SCHEMA);
  assert.deepEqual(calls[0].options, { maxRetries: 0, timeout: 45000 });
});

test('a schema in the OpenAI name/strict wrapper is unwrapped to the bare schema', async () => {
  const calls: Call[] = [];
  await new AnthropicModelClient(KEY, 1000, fake(() => msg(), calls)).callJson(REQ, { name: 'n', strict: true, schema: SCHEMA });
  assert.deepEqual(calls[0].params.output_config.format.schema, SCHEMA);
});

test('usage mapping includes cache reads and writes in the input', async () => {
  const r = await new AnthropicModelClient(KEY, 1000, fake(() => msg())).callJson(REQ, SCHEMA);
  assert.deepEqual(r.usage, { inputTokens: 125, cachedInputTokens: 20, cacheWriteTokens: 5, outputTokens: 50 });
  assert.equal(r.content, answer);
});

test('extract parses through the shared parser', async () => {
  const e = await new AnthropicModelClient(KEY, 1000, fake(() => msg())).extract(REQ);
  assert.deepEqual(e.items, []);
  assert.equal(e.usage.inputTokens, 125);
});

test('stop_reason max_tokens is a bad response with usage', async () => {
  await assert.rejects(
    new AnthropicModelClient(KEY, 1000, fake(() => msg({ stop_reason: 'max_tokens' }))).callJson(REQ, SCHEMA),
    (e: unknown) => e instanceof ModelBadResponse && e.usage.outputTokens === 50 && /cut off/.test(e.message),
  );
});

test('stop_reason refusal is a bad response', async () => {
  await assert.rejects(
    new AnthropicModelClient(KEY, 1000, fake(() => msg({ stop_reason: 'refusal' }))).callJson(REQ, SCHEMA),
    (e: unknown) => e instanceof ModelBadResponse && /declined/.test(e.message),
  );
});

test('APIConnectionTimeoutError is unknown and retryable', async () => {
  const e = await fails(failing(new Anthropic.APIConnectionTimeoutError()));
  assert.equal(e.outcome, 'unknown');
  assert.equal(e.retryable, true);
  assert.equal(e.keyRejected, false);
});

test('APIConnectionError is unknown and retryable', async () => {
  const e = await fails(failing(new Anthropic.APIConnectionError({ message: 'down' })));
  assert.deepEqual([e.outcome, e.retryable], ['unknown', true]);
});

test('529 and 500 are unknown and retryable', async () => {
  for (const s of [529, 500]) {
    const e = await fails(failing(apiError(s)));
    assert.deepEqual([e.outcome, e.retryable, e.status], ['unknown', true, s]);
  }
});

test('429 is rejected and retryable', async () => {
  const e = await fails(failing(apiError(429)));
  assert.deepEqual([e.outcome, e.retryable, e.keyRejected, e.status], ['rejected', true, false, 429]);
});

test('401 and 403 are rejected, not retryable, keyRejected', async () => {
  for (const s of [401, 403]) {
    const e = await fails(failing(apiError(s)));
    assert.deepEqual([e.outcome, e.retryable, e.keyRejected, e.status], ['rejected', false, true, s]);
  }
});

test('400 is rejected and not retryable', async () => {
  const e = await fails(failing(apiError(400)));
  assert.deepEqual([e.outcome, e.retryable, e.keyRejected], ['rejected', false, false]);
});

test('a 200 without usage is unknown and retryable', async () => {
  const e = await fails(fake(() => msg({ usage: undefined })));
  assert.deepEqual([e.outcome, e.retryable], ['unknown', true]);
});

test('no error message contains the request body or the key', async () => {
  for (const s of [400, 401, 403, 429, 500, 529]) {
    const e = await fails(failing(apiError(s)));
    assert.ok(!e.message.includes('USER-SECRET') && !e.message.includes('sk-ant'), e.message);
  }
});

test('the real factory builds the right client per provider', () => {
  const a = realClientFactory.forAttempt({ provider: 'anthropic', apiKey: KEY, timeoutMs: 1000 });
  assert.equal(a.constructor.name, 'AnthropicModelClient');
  const o = realClientFactory.forAttempt({ provider: 'openai', apiKey: `sk-test-${'x'.repeat(40)}`, timeoutMs: 1000 });
  assert.equal(o.constructor.name, 'OpenAiModelClient');
});
