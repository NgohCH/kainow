import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FILTERS,
  PERIOD_LABELS,
  type ProgressRow,
  chartBars,
  chartTableEquivalent,
  defaultViewConfig,
  definitionParts,
  drillValueText,
  filtersToQuery,
  moveItem,
  onTimeSeries,
  queryToFilters,
  sortRows,
  trendSeries,
} from './analytics.ts';

const DEPT = '0190a3c1-2b3c-7d4e-8f90-a1b2c3d4e5f6';

test('filters round-trip', () => {
  // The defaults: Last 12 weeks, Planned/Active/Deferred, no department, both, archived off.
  assert.deepEqual(DEFAULT_FILTERS, { period: 'last_12w', department: null, status: ['planned', 'active', 'deferred'], ownership: 'both', includeArchived: false });
  assert.deepEqual(queryToFilters(filtersToQuery(DEFAULT_FILTERS)), DEFAULT_FILTERS);
  assert.deepEqual(queryToFilters(''), DEFAULT_FILTERS);

  const f = { period: 'last_month' as const, department: DEPT, status: ['active' as const, 'closed' as const], ownership: 'owned' as const, includeArchived: true };
  const q = filtersToQuery(f);
  // Exactly the parameter names and values the server parses (app/src/analytics/filters.ts).
  const params = new URLSearchParams(q);
  assert.equal(params.get('period'), 'last_month');
  assert.equal(params.get('department'), DEPT);
  assert.equal(params.get('status'), 'active,closed');
  assert.equal(params.get('ownership'), 'owned');
  assert.equal(params.get('includeArchived'), '1');
  assert.deepEqual(queryToFilters(q), f);
  assert.equal(filtersToQuery(queryToFilters(q)), q);

  // Without a department the ownership filter does not apply, so it is not sent and reads back as both.
  const noDept = filtersToQuery({ ...f, department: null });
  assert.equal(new URLSearchParams(noDept).get('ownership'), null);
  assert.equal(queryToFilters(noDept).ownership, 'both');

  // Unknown values fall back to the defaults; statuses come back in the server's order without repeats.
  assert.deepEqual(queryToFilters('period=forever&department=nope&status=closed,active,active&ownership=x&includeArchived=maybe'), {
    ...DEFAULT_FILTERS,
    status: ['active', 'closed'],
  });
  assert.deepEqual(queryToFilters('status=bogus'), DEFAULT_FILTERS);
  assert.equal(queryToFilters(`department=${DEPT.toUpperCase()}`).department, DEPT);

  assert.deepEqual(Object.values(PERIOD_LABELS), ['This month', 'Last month', 'Last 4 weeks', 'Last 12 weeks', 'Last 26 weeks', 'Last 52 weeks']);
});

const row = (name: string, onTime: ProgressRow['onTime'], extra: Partial<ProgressRow> = {}): ProgressRow => ({
  id: `id-${name}`,
  name,
  departmentId: DEPT,
  owningDepartment: 'Dept A',
  status: 'active',
  stage: null,
  completion: { state: 'not_measurable', cancelled: 0 },
  onTime,
  plannedEnd: { state: 'none' },
  overdue: 0,
  blocked: 0,
  ...extra,
});
const measured = (percent: number) => ({ state: 'measured' as const, due: 10, done: percent / 10, late: 0, percent, awaitingReview: 0 });
const nothing = { state: 'nothing_due' as const, awaitingReview: 0 };

test('nothing-due sorts last', () => {
  const rows = [row('Alpha', nothing), row('Bravo', measured(80)), row('Charlie', measured(20)), row('Delta', nothing), row('Echo', measured(50))];
  assert.deepEqual(sortRows(rows, 'onTime', 'asc').map((r) => r.name), ['Charlie', 'Echo', 'Bravo', 'Alpha', 'Delta']);
  assert.deepEqual(sortRows(rows, 'onTime', 'desc').map((r) => r.name), ['Bravo', 'Echo', 'Charlie', 'Alpha', 'Delta']);
  // The input is not changed.
  assert.deepEqual(rows.map((r) => r.name), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);

  // Not measurable and no planned end likewise go last in both directions.
  const c = [
    row('A', nothing, { completion: { state: 'measurable', done: 1, total: 2, cancelled: 0, percent: 50 }, plannedEnd: { state: 'ahead', days: 3 } }),
    row('B', nothing, { completion: { state: 'not_measurable', cancelled: 2 }, plannedEnd: { state: 'none' } }),
    row('C', nothing, { completion: { state: 'measurable', done: 9, total: 10, cancelled: 0, percent: 90 }, plannedEnd: { state: 'ended', daysAgo: 4 } }),
  ];
  assert.deepEqual(sortRows(c, 'completion', 'desc').map((r) => r.name), ['C', 'A', 'B']);
  assert.deepEqual(sortRows(c, 'completion', 'asc').map((r) => r.name), ['A', 'C', 'B']);
  assert.deepEqual(sortRows(c, 'plannedEnd', 'asc').map((r) => r.name), ['C', 'A', 'B']);
  assert.deepEqual(sortRows(c, 'plannedEnd', 'desc').map((r) => r.name), ['A', 'C', 'B']);

  // Counts and names sort plainly; ties fall back to the name.
  const n = [row('Z', nothing, { overdue: 2 }), row('Y', nothing, { overdue: 5 }), row('X', nothing, { overdue: 2 })];
  assert.deepEqual(sortRows(n, 'overdue', 'desc').map((r) => r.name), ['Y', 'X', 'Z']);
  assert.deepEqual(sortRows(n, 'name', 'asc').map((r) => r.name), ['X', 'Y', 'Z']);
  // A missing count (a column a row does not have) goes last.
  const p = [{ id: '1', name: 'P', overdueTasks: 3 }, { id: '2', name: 'Q' }, { id: '3', name: 'R', overdueTasks: 1 }];
  assert.deepEqual(sortRows(p, 'overdueTasks', 'asc').map((r) => r.name), ['R', 'P', 'Q']);
  assert.deepEqual(sortRows(p, 'overdueTasks', 'desc').map((r) => r.name), ['P', 'R', 'Q']);
});

test('chart and table carry the same numbers', () => {
  const rows = [row('Alpha', measured(80)), row('Bravo', nothing), row('Charlie', { ...measured(0), done: 0 })];
  const series = onTimeSeries(rows);
  const table = chartTableEquivalent(series);
  const { drawn, missing } = chartBars(series, 'percent');
  assert.ok(drawn.every((b) => b.max === 100));
  // Every row of the table is either a drawn bar with the same value, or listed under the chart with its words.
  assert.deepEqual(table.map((r) => r.label), ['Alpha', 'Bravo', 'Charlie']);
  assert.deepEqual(drawn.map((b) => [b.label, b.value]), table.filter((r) => r.value !== null).map((r) => [r.label, r.value]));
  assert.deepEqual(missing.map((b) => b.label), ['Bravo']);
  assert.equal(table[1].value, null);
  assert.equal(table[1].text, 'Nothing due yet');
  // A real zero is drawn (as a zero bar), a missing value never is.
  assert.equal(drawn.find((b) => b.label === 'Charlie')?.value, 0);
  assert.equal(table[0].text, '8 of 10 tasks due so far are done (80%)');

  const weeks = ['2026-11-02', '2026-11-09', '2026-11-16'];
  const t = trendSeries(weeks, [3, 0, 7]);
  const tt = chartTableEquivalent(t);
  assert.deepEqual(tt.map((r) => r.value), [3, 0, 7]);
  assert.deepEqual(chartBars(t).drawn.map((b) => b.value), [3, 0, 7]);
  assert.deepEqual(tt.map((r) => r.label), ['Week of 2 Nov 2026', 'Week of 9 Nov 2026', 'Week of 16 Nov 2026']);
  assert.ok(chartBars(t).drawn.every((b) => b.max === 7));
});

test('drill values, definition code spans and layout moves', () => {
  assert.equal(drillValueText('overdueTasks', 4), '4');
  assert.equal(drillValueText('completion', { done: 31, total: 50, cancelled: 4 }), '31 of 50 tasks done, 4 cancelled');
  assert.equal(drillValueText('completion', { done: 0, total: 0, cancelled: 0 }), 'Progress not yet measurable');
  assert.equal(drillValueText('onTime', { due: 40, done: 32, late: 3, awaitingReview: 2 }), '32 of 40 tasks due so far are done, 3 late, Awaiting deadline review: 2');
  assert.equal(drillValueText('onTime', { due: 0, done: 0, late: 0, awaitingReview: 0 }), 'Nothing due yet');

  assert.deepEqual(definitionParts('Rows in `tasks` with `due_on` set.'), [
    { code: false, text: 'Rows in ' },
    { code: true, text: 'tasks' },
    { code: false, text: ' with ' },
    { code: true, text: 'due_on' },
    { code: false, text: ' set.' },
  ]);
  assert.deepEqual(definitionParts('No code here.'), [{ code: false, text: 'No code here.' }]);

  assert.deepEqual(moveItem(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  const d = defaultViewConfig();
  assert.deepEqual(d.panels.order, ['progress', 'problems', 'system', 'trends', 'resources', 'aiUsage', 'operations']);
  assert.deepEqual(d.filters, DEFAULT_FILTERS);
  assert.equal(d.charts['progress.onTime'], 'chart');
});
