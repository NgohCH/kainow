import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TimelineLine, groupByMonth, timelineRange } from './timeline';

test('range defaults; from after to is 400; span over two years is 400', () => {
  assert.deepEqual(timelineRange({}, '2026-11-19'), { from: '2026-08-19', to: '2027-05-19' });
  assert.deepEqual(timelineRange({}, '2026-05-31'), { from: '2026-02-28', to: '2026-11-30' });
  assert.deepEqual(timelineRange({ from: '2026-01-01' }, '2026-11-19'), { from: '2026-01-01', to: '2027-05-19' });
  assert.deepEqual(timelineRange({ from: '2026-11-19', to: '2026-11-19' }, '2026-11-19'), { from: '2026-11-19', to: '2026-11-19' });
  assert.ok('error' in timelineRange({ from: '2026-12-01', to: '2026-11-01' }, '2026-11-19'));
  assert.ok('error' in timelineRange({ from: '2026-02-30' }, '2026-11-19'));
  assert.ok('error' in timelineRange({ to: 'tomorrow' }, '2026-11-19'));
  // 731 days apart is allowed; 732 is not
  assert.ok(!('error' in timelineRange({ from: '2024-01-01', to: '2026-01-01' }, '2026-11-19')));
  assert.ok('error' in timelineRange({ from: '2024-01-01', to: '2026-01-02' }, '2026-11-19'));
});

test('groupByMonth is oldest first, lines keep their order', () => {
  const l = (day: string, label: string): TimelineLine => ({ day, kind: 'status', label });
  const groups = groupByMonth([l('2026-12-02', 'c'), l('2026-11-30', 'b'), l('2026-11-01', 'a'), l('2026-11-30', 'b2')]);
  assert.deepEqual(
    groups.map((g) => [g.month, g.lines.map((x) => x.label)]),
    [
      ['2026-11', ['a', 'b', 'b2']],
      ['2026-12', ['c']],
    ],
  );
  assert.deepEqual(groupByMonth([]), []);
});
