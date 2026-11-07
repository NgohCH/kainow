import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7, uuidv7Timestamp } from './uuid7';

test('has the UUID layout with version 7 and the RFC variant', () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('embeds the timestamp it was given', () => {
  const ms = Date.UTC(2026, 10, 7, 4, 0, 0);
  assert.equal(uuidv7Timestamp(uuidv7(ms)), ms);
});

test('sorts by creation time across different milliseconds', () => {
  const base = Date.UTC(2026, 10, 7);
  const ids = [5, 1, 3, 2, 4].map((offset) => uuidv7(base + offset * 1000));
  const sorted = [...ids].sort();
  assert.deepEqual(sorted.map(uuidv7Timestamp), [1, 2, 3, 4, 5].map((o) => base + o * 1000));
});

test('does not repeat within one millisecond', () => {
  const ms = Date.now();
  const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(ms)));
  assert.equal(ids.size, 1000);
});

test('rejects timestamps outside 48 bits', () => {
  assert.throws(() => uuidv7(-1), RangeError);
  assert.throws(() => uuidv7(2 ** 48), RangeError);
  assert.throws(() => uuidv7(1.5), RangeError);
});
