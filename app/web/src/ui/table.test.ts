import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortRows } from './table.ts';

type R = { n: string; v: number };
const rows: R[] = [{ n: 'b', v: 2 }, { n: 'a', v: 2 }, { n: 'c', v: 1 }];

test('sorts ascending and descending by the column value', () => {
  assert.deepEqual(sortRows(rows, { sortValue: (r) => r.v }, 'asc').map((r) => r.n), ['c', 'b', 'a']);
  assert.deepEqual(sortRows(rows, { sortValue: (r) => r.v }, 'desc').map((r) => r.n), ['b', 'a', 'c']);
  assert.deepEqual(sortRows(rows, { sortValue: (r) => r.n }, 'asc').map((r) => r.n), ['a', 'b', 'c']);
});
test('ties keep their order in both directions, and the input is not changed', () => {
  const col = { sortValue: (r: R) => r.v };
  assert.deepEqual(sortRows(rows, col, 'asc').filter((r) => r.v === 2).map((r) => r.n), ['b', 'a']);
  assert.deepEqual(sortRows(rows, col, 'desc').filter((r) => r.v === 2).map((r) => r.n), ['b', 'a']);
  assert.deepEqual(rows.map((r) => r.n), ['b', 'a', 'c']);
});
test('numbers in text sort as numbers; a column without sortValue keeps the order; an empty list stays empty', () => {
  assert.deepEqual(sortRows(['x10', 'x9'], { sortValue: (s) => s }, 'asc'), ['x9', 'x10']);
  assert.deepEqual(sortRows(rows, {}, 'desc').map((r) => r.n), ['b', 'a', 'c']);
  assert.deepEqual(sortRows([], { sortValue: () => 0 }, 'asc'), []);
});
