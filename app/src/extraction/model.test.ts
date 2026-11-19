import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCredentials } from './credentials';
import { ModelBadResponse, ModelCallError, OpenAiModelClient, parseAnswer } from './model';

const USAGE = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 };
const REQ = { modelId: 'gpt-6.1-sol', system: 's', user: 'u', maxOutputTokens: 100, timeoutMs: 1000 };
const ITEM = { kind: 'decision', text: 'd', owner: null, due: null, source_quote: 'q' };

const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const ok = (content: unknown, extra: object = {}) => ({
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
  ...extra,
});

test('common secrets are found by kind and count, and never repeated', () => {
  const text = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'AKIAABCDEFGHIJKLMNOP',
    'sk-abcdefghijklmnopqrstuvwxyz123456',
    'ghp_' + 'a'.repeat(36),
    'xoxb-1234567890-abcdefghij',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
    'password: S3cret!pass',
    'postgres://admin:hunter22@db.example.org/app',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  ].join('\n');
  const kinds = findCredentials(text).map((f) => f.pattern);
  for (const expected of ['private key', 'AWS access key', 'API secret key (sk-)', 'GitHub token', 'Slack token', 'bearer token', 'password or key assignment', 'password inside a web address', 'JSON web token']) {
    assert.ok(kinds.includes(expected), `should find ${expected}`);
  }
  assert.ok(!JSON.stringify(findCredentials(text)).includes('hunter22'));
});

test('ordinary meeting talk is not flagged', () => {
  const text = 'We discussed the password policy and the secret santa. Token: pending. See https://example.org/page. Reset the password: done. The API key rotation is due Friday.';
  assert.deepEqual(findCredentials(text), []);
});

test('the answer is checked item by item and nothing is repaired', () => {
  assert.equal(parseAnswer(JSON.stringify({ items: [ITEM] }), USAGE).items.length, 1);
  const bad: unknown[] = [
    'not json',
    JSON.stringify({}),
    JSON.stringify({ items: 'x' }),
    JSON.stringify({ items: [{ ...ITEM, kind: 'other' }] }),
    JSON.stringify({ items: [{ ...ITEM, text: ' ' }] }),
    JSON.stringify({ items: [{ ...ITEM, source_quote: '' }] }),
    JSON.stringify({ items: [{ ...ITEM, owner: 5 }] }),
    JSON.stringify({ items: [{ ...ITEM, due: undefined }] }),
    JSON.stringify({ items: [null] }),
  ];
  for (const content of bad) {
    assert.throws(() => parseAnswer(content, USAGE), (e: unknown) => e instanceof ModelBadResponse && e.usage === USAGE, String(content));
  }
});

test('a good OpenAI answer gives items and the reported usage including cached tokens', async () => {
  const client = new OpenAiModelClient('key', 'https://example.test/v1', reply(ok({ items: [ITEM] })));
  const r = await client.extract(REQ);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.usage, { inputTokens: 100, cachedInputTokens: 30, outputTokens: 20 });
});

test('the request carries the pinned model, the output limit and the key only in the header', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const spy = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify(ok({ items: [] })));
  }) as unknown as typeof fetch;
  await new OpenAiModelClient('sk-test', 'https://example.test/v1', spy).extract(REQ);
  const body = JSON.parse(String(seen?.init.body));
  assert.equal(seen?.url, 'https://example.test/v1/chat/completions');
  assert.equal(body.model, 'gpt-6.1-sol');
  assert.equal(body.max_completion_tokens, 100);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.ok(!String(seen?.init.body).includes('sk-test'));
  assert.equal((seen?.init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
});

test('HTTP errors say whether anything could have been charged', async () => {
  const cases: Array<[number, 'rejected' | 'unknown', boolean]> = [
    [400, 'rejected', false],
    [401, 'rejected', false],
    [429, 'rejected', true],
    [500, 'unknown', true],
    [503, 'unknown', true],
  ];
  for (const [status, outcome, retryable] of cases) {
    const client = new OpenAiModelClient('k', 'https://example.test/v1', reply({ error: { message: 'secret echo of the note' } }, status));
    await assert.rejects(client.extract(REQ), (e: unknown) => {
      assert.ok(e instanceof ModelCallError);
      assert.equal(e.outcome, outcome, String(status));
      assert.equal(e.retryable, retryable, String(status));
      assert.ok(!e.message.includes('echo'), 'provider error text is not copied into our messages');
      return true;
    });
  }
});

test('a lost connection or a timeout is an unknown outcome', async () => {
  const boom = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  await assert.rejects(new OpenAiModelClient('k', 'https://example.test/v1', boom).extract(REQ), (e: unknown) => e instanceof ModelCallError && e.outcome === 'unknown' && e.retryable);
});

test('a success answer with no usage is unknown, so the estimate stays counted', async () => {
  const body = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [] }) } }] };
  await assert.rejects(new OpenAiModelClient('k', 'https://example.test/v1', reply(body)).extract(REQ), (e: unknown) => e instanceof ModelCallError && e.outcome === 'unknown');
});

test('an answer cut off at the limit or refused is a bad response that is still charged', async () => {
  const cut = { ...ok({ items: [] }), choices: [{ finish_reason: 'length', message: { content: '{"items":[' } }] };
  await assert.rejects(new OpenAiModelClient('k', 'https://example.test/v1', reply(cut)).extract(REQ), (e: unknown) => e instanceof ModelBadResponse && e.usage.outputTokens === 20);
  const refused = { ...ok({}), choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] };
  await assert.rejects(new OpenAiModelClient('k', 'https://example.test/v1', reply(refused)).extract(REQ), (e: unknown) => e instanceof ModelBadResponse);
});

test('parseAnswer returns the meeting date and the new item fields', () => {
  const q = { ...ITEM, kind: 'question', due_event: 'approval by the Dean', alternatives: ['Go ahead', 'Wait'] };
  const a = parseAnswer(JSON.stringify({ meeting_date: '2026-11-04', items: [q] }), USAGE);
  assert.equal(a.meetingDate, '2026-11-04');
  assert.equal(a.items[0].due_event, 'approval by the Dean');
  assert.deepEqual(a.items[0].alternatives, ['Go ahead', 'Wait']);
});

test('a meeting date that is not a real day is stored as null, not refused', () => {
  for (const meeting_date of ['2026-02-30', '4 Nov 2026', null]) {
    assert.equal(parseAnswer(JSON.stringify({ meeting_date, items: [ITEM] }), USAGE).meetingDate, null, String(meeting_date));
  }
  assert.equal(parseAnswer(JSON.stringify({ items: [ITEM] }), USAGE).meetingDate, null, 'absent');
});

test('alternatives are trimmed, blanks dropped, capped at 4, and empty for kinds other than question', () => {
  const alternatives = [' A ', '', 'B', '  ', 'C', 'D', 'E'];
  const [q, d] = parseAnswer(JSON.stringify({ items: [{ ...ITEM, kind: 'question', alternatives }, { ...ITEM, alternatives: ['X', 'Y'] }] }), USAGE).items;
  assert.deepEqual(q.alternatives, ['A', 'B', 'C', 'D']);
  assert.deepEqual(d.alternatives, []);
  const plain = parseAnswer(JSON.stringify({ items: [ITEM] }), USAGE).items[0];
  assert.equal(plain.due_event, null);
  assert.deepEqual(plain.alternatives, []);
});

test('a malformed due_event or alternatives is a bad response', () => {
  for (const extra of [{ due_event: 5 }, { alternatives: 'x' }, { alternatives: [1, 2] }]) {
    const content = JSON.stringify({ items: [{ ...ITEM, ...extra }] });
    assert.throws(() => parseAnswer(content, USAGE), (e: unknown) => e instanceof ModelBadResponse && e.usage === USAGE, content);
  }
});

test('a good OpenAI answer passes the meeting date through', async () => {
  const client = new OpenAiModelClient('key', 'https://example.test/v1', reply(ok({ meeting_date: '2026-11-04', items: [ITEM] })));
  assert.equal((await client.extract(REQ)).meetingDate, '2026-11-04');
});

test('draftMinutes sends the minutes schema and returns the parsed sections with the reported usage', async () => {
  const sections = { summary: 's', discussion_points: [], decisions: ['d'], action_items: [{ text: 't', owner: null, due: null }], open_questions: [], risks: [] };
  let sent: any;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify(ok(sections)), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await new OpenAiModelClient('key', 'https://example.test/v1', fetchImpl).draftMinutes(REQ);
  assert.equal(sent.response_format.json_schema.name, 'meeting_minutes');
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.deepEqual([out.decisions, out.actionItems, out.usage.cachedInputTokens], [['d'], [{ text: 't', owner: null, due: null }], 30]);
  const bad = new OpenAiModelClient('key', 'https://example.test/v1', reply(ok({ summary: 's' })));
  await assert.rejects(bad.draftMinutes(REQ), (e: unknown) => e instanceof ModelBadResponse && e.usage.inputTokens === 100);
});

test('OpenAI: 401 and 403 set keyRejected, other statuses do not', async () => {
  for (const [status, rejected] of [[401, true], [403, true], [500, false], [429, false], [400, false]] as const) {
    const fetchImpl = (async () => new Response('{}', { status })) as typeof fetch;
    await assert.rejects(
      new OpenAiModelClient('sk-test-xxxxxxxxxxxxxxxxxxxx', 'http://x', fetchImpl).callJson(REQ, {}),
      (e: unknown) => e instanceof ModelCallError && e.keyRejected === rejected && e.status === status,
    );
  }
});
