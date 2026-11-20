import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spansOverlap } from './overlap';
import { ITEM_KINDS, LINE_STATUSES, ONE_OFF_KINDS, UNITS } from './vocabulary';

const s = (start: string | null, end: string | null) => ({ start, end });

test('inclusive day edges and open ends', () => {
  assert.equal(spansOverlap(s('2026-12-01', '2026-12-01'), s('2026-12-01', '2026-12-01')), true);
  assert.equal(spansOverlap(s('2026-12-01', '2026-12-03'), s('2026-12-04', '2026-12-06')), false);
  assert.equal(spansOverlap(s('2026-12-04', '2026-12-06'), s('2026-12-01', '2026-12-03')), false);
  assert.equal(spansOverlap(s('2026-12-01', '2026-12-03'), s('2026-12-03', '2026-12-06')), true);
  assert.equal(spansOverlap(s('2026-01-01', null), s('2030-05-05', null)), true);
  assert.equal(spansOverlap(s('2026-12-10', null), s('2026-12-01', '2026-12-20')), true);
  assert.equal(spansOverlap(s('2026-12-01', '2026-12-20'), s('2026-12-10', null)), true);
  assert.equal(spansOverlap(s('2026-12-10', null), s('2026-12-01', '2026-12-09')), false);
});

test('a span without a start never overlaps', () => {
  assert.equal(spansOverlap(s(null, null), s('2026-12-01', null)), false);
  assert.equal(spansOverlap(s('2026-12-01', null), s(null, '2026-12-05')), false);
});

test('vocabulary matches the spec', () => {
  assert.deepEqual(Object.keys(UNITS), ['hours', 'days', 'person_hours', 'person_days', 'items', 'seats', 'square_metres']);
  assert.deepEqual(Object.values(UNITS), ['Hours', 'Days', 'Person-hours', 'Person-days', 'Items', 'Seats', 'Square metres']);
  assert.deepEqual(Object.keys(LINE_STATUSES), ['needed', 'arranged', 'in_use', 'finished', 'cancelled']);
  assert.deepEqual(Object.values(LINE_STATUSES), ['Needed', 'Arranged', 'In use', 'Finished', 'Cancelled']);
  assert.deepEqual([...ONE_OFF_KINDS], ['equipment', 'facility', 'other']);
  assert.deepEqual([...ITEM_KINDS], ['equipment', 'facility']);
});
