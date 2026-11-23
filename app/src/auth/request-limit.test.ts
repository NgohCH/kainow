import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditSampler, WindowLimiter, clientAddress, limitKey } from './request-limit';

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

// Second review (M1c): one IPv6 subscriber holds a /64, so its addresses share one limit; IPv4 stays per address.
test('IPv6 addresses are limited per /64, IPv4 and mapped IPv4 per address', () => {
  assert.equal(limitKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(limitKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(limitKey('[2001:db8:1:2::9]'), '2001:db8:1:2::/64');
  assert.equal(limitKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(limitKey('::1'), '0:0:0:0::/64');
  assert.equal(limitKey('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(limitKey('192.0.2.7'), '192.0.2.7');
  assert.equal(limitKey('unknown'), 'unknown');
  assert.notEqual(limitKey('2001:db8:1:2::1'), limitKey('2001:db8:1:3::1'));

  const c = clockAt(Date.UTC(2026, 10, 20, 0, 0, 0));
  const l = new WindowLimiter({ perAddress: 2, overall: 100 }, c.now);
  assert.deepEqual([l.take('2001:db8:1:2::1'), l.take('2001:db8:1:2::2'), l.take('2001:db8:1:2::3')], [null, null, 'address'], 'rotating inside a /64 does not help');
  assert.equal(l.take('2001:db8:1:3::1'), null, 'the next /64 has its own limit');
});

test('once the address table is full, new addresses share an overflow bucket instead of being refused outright', () => {
  const c = clockAt(Date.UTC(2026, 10, 20, 0, 0, 0));
  const l = new WindowLimiter({ perAddress: 1, overall: 100_000 }, c.now);
  for (let i = 0; i < 10_000; i += 1) assert.equal(l.take(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`), null);
  const extra = Array.from({ length: 11 }, (_, i) => l.take(`172.16.0.${i}`));
  assert.deepEqual(extra, [...Array(10).fill(null), 'address'], 'ten requests through the shared bucket, then refused');
});
