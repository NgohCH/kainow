import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { idleSlotWaitMs, loadTestClientFactory, startFakeAi } from './fake-ai';

describe('load-test fake AI', () => {
  test('the load-test adapter exists only with KAINOW_LOAD_TEST=1 and a loopback address', () => {
    assert.equal(loadTestClientFactory({}), null);
    assert.equal(loadTestClientFactory({ KAINOW_LOAD_TEST_AI_URL: 'http://127.0.0.1:3311/v1' }), null);
    assert.equal(loadTestClientFactory({ KAINOW_LOAD_TEST: 'true', KAINOW_LOAD_TEST_AI_URL: 'http://127.0.0.1:3311/v1' }), null);
    assert.throws(() => loadTestClientFactory({ KAINOW_LOAD_TEST: '1' }), /KAINOW_LOAD_TEST_AI_URL/);
    assert.throws(() => loadTestClientFactory({ KAINOW_LOAD_TEST: '1', KAINOW_LOAD_TEST_AI_URL: 'https://api.example.org/v1' }), /loopback/);
    assert.throws(() => loadTestClientFactory({ KAINOW_LOAD_TEST: '1', KAINOW_LOAD_TEST_AI_URL: 'http://10.0.0.5:3311/v1' }), /loopback/);
    assert.ok(loadTestClientFactory({ KAINOW_LOAD_TEST: '1', KAINOW_LOAD_TEST_AI_URL: 'http://127.0.0.1:3311/v1' }));
  });

  test('an extraction through the adapter reaches the fake and parses', async () => {
    const fake = await startFakeAi({ port: 0, minMs: 5, maxMs: 10 });
    try {
      const factory = loadTestClientFactory({ KAINOW_LOAD_TEST: '1', KAINOW_LOAD_TEST_AI_URL: fake.url })!;
      const client = factory.forAttempt({ provider: 'anthropic', apiKey: 'sk-test-x', timeoutMs: 5000 }) as unknown as {
        extract(r: object): Promise<{ items: { kind: string }[]; usage: object }>;
      };
      const marker = 'LT-0190a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';
      const r = await client.extract({ modelId: 'm', system: 's', user: `notes ${marker}`, maxOutputTokens: 100, timeoutMs: 5000 });
      assert.deepEqual(r.items.map((i) => i.kind), ['decision', 'action', 'risk', 'question']);
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].marker, marker);
      assert.equal(fake.maxInFlight(), 1);
    } finally {
      await fake.close();
    }
  });

  test('idle-slot wait counts only the time a place was free', () => {
    // Two places; the request waits 0..10. Calls hold both places 0..6, then one place 6..10: idle 6..10 = 4.
    const calls = [
      { startedAt: 0, endedAt: 6 },
      { startedAt: 0, endedAt: 12 },
      { startedAt: 10, endedAt: 15 },
    ];
    assert.equal(idleSlotWaitMs(0, 10, calls, 2), 4);
    assert.equal(idleSlotWaitMs(0, 6, calls, 2), 0);
    assert.equal(idleSlotWaitMs(5, 5, calls, 2), 0);
  });
});
