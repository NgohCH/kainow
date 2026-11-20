import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditSampler, WindowLimiter, clientAddress } from './request-limit';

function clockAt(ms: number) {
  let now = ms;
  return { now: () => new Date(now), advance: (s: number) => (now += s * 1000) };
}

test('the limiter refuses an address over its limit and everyone over the overall limit, then resets each minute', () => {
  const c = clockAt(Date.UTC(2026, 10, 20, 0, 0, 0));
  const l = new WindowLimiter({ perAddress: 2, overall: 3 }, c.now);
  assert.deepEqual([l.take('a'), l.take('a'), l.take('a')], [null, null, 'address']);
  assert.deepEqual([l.take('b'), l.take('c')], [null, 'overall']);
  c.advance(60);
  assert.equal(l.take('a'), null);
});

test('the audit sampler writes N per minute and reports how many it skipped', () => {
  const c = clockAt(Date.UTC(2026, 10, 20, 0, 0, 0));
  const s = new AuditSampler(2, c.now);
  assert.deepEqual([s.next(), s.next(), s.next(), s.next()], [{}, {}, null, null]);
  c.advance(60);
  assert.deepEqual([s.next(), s.next()], [{ suppressed: 2 }, {}]);
});

test('the client address uses X-Forwarded-For only behind trusted proxies, counted from the right', () => {
  assert.equal(clientAddress('10.0.0.1', '1.2.3.4', 0), '10.0.0.1');
  assert.equal(clientAddress('10.0.0.1', 'spoofed, 1.2.3.4', 1), '1.2.3.4');
  assert.equal(clientAddress('10.0.0.1', 'spoofed, 1.2.3.4, 10.0.0.9', 2), '1.2.3.4');
  assert.equal(clientAddress('10.0.0.1', '1.2.3.4', 3), '1.2.3.4', 'a short chain gives its leftmost entry');
  assert.equal(clientAddress('10.0.0.1', undefined, 1), '10.0.0.1');
  assert.equal(clientAddress(undefined, undefined, 0), 'unknown');
});
