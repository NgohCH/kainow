import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RETRIES, WAIT_FOR_KEY_MS, nextAttemptAt, retryDelayMs } from './retry';

const MINUTE = 60_000;

test('retryDelayMs schedule is 1, 5, 30 and 120 minutes after the first failure', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => retryDelayMs(n)), [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE]);
  assert.equal(MAX_RETRIES, 4);
  // Measured from the first failure, not from the last attempt: the gaps between attempts are 1, 4, 25 and 90 minutes.
  const first = new Date('2026-11-20T01:00:00Z');
  let now = first;
  const gaps: number[] = [];
  for (let n = 1; n <= MAX_RETRIES; n++) {
    const at = nextAttemptAt(first, n, now);
    gaps.push((at.getTime() - now.getTime()) / MINUTE);
    now = at;
  }
  assert.deepEqual(gaps, [1, 4, 25, 90]);
  assert.equal(nextAttemptAt(first, 4, first).toISOString(), '2026-11-20T03:00:00.000Z');
  assert.equal(WAIT_FOR_KEY_MS, 5 * MINUTE);
});

test('Retry-After later than the schedule wins', () => {
  assert.equal(retryDelayMs(1, 3 * MINUTE), 3 * MINUTE);
  assert.equal(retryDelayMs(1, 30_000), MINUTE);
  assert.equal(retryDelayMs(3, 2 * 60 * MINUTE), 2 * 60 * MINUTE);
  // Retry-After counts from now; the schedule from the first failure.
  const first = new Date('2026-11-20T01:00:00Z');
  const now = new Date('2026-11-20T01:00:50Z');
  assert.equal(nextAttemptAt(first, 1, now, 30_000).toISOString(), '2026-11-20T01:01:20.000Z');
  assert.equal(nextAttemptAt(first, 1, now, 5_000).toISOString(), '2026-11-20T01:01:00.000Z');
  // A late attempt (the worker was down) runs now, never in the past.
  const late = new Date('2026-11-20T05:00:00Z');
  assert.equal(nextAttemptAt(first, 2, late).toISOString(), late.toISOString());
});

test('retryDelayMs refuses attempts outside the schedule', () => {
  assert.throws(() => retryDelayMs(0));
  assert.throws(() => retryDelayMs(5));
});
