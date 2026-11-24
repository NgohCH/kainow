import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimelineLine } from '../dashboard.ts';
import { barsLayout } from './timelineBars.ts';

const WINDOW = { from: '2026-08-24', to: '2027-05-24', today: '2026-11-24' };
const GENERAL_PERIODS = [
  { stage: 'Initiation', substage: null, startedOn: '2026-07-01', endedOn: '2026-08-15' },
  { stage: 'Planning', substage: null, startedOn: '2026-08-15', endedOn: '2026-10-21' },
  { stage: 'Execution', substage: 'In Progress', startedOn: '2026-10-21', endedOn: null },
];
const tasksDue = (day: string, n: number): TimelineLine => ({
  day,
  kind: 'tasks_due',
  label: `${n} ${n === 1 ? 'task' : 'tasks'} due`,
  detail: { done: 0, tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: 'not_started' })) },
});
const pct = (from: string, day: string, to: string) => {
  const d = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
  return (d(from, day) * 100) / d(from, to);
};
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('a General project in Execution: a current bar from its start to today, earlier stages closed, months in order', () => {
  const l = barsLayout({ ...WINDOW, periods: GENERAL_PERIODS, lines: [], hiddenKinds: [] });
  // Initiation ended before the window opened, so it is not drawn.
  assert.deepEqual(l.bars.map((b) => [b.stage, b.current]), [['Planning', false], ['Execution', true]]);
  const execution = l.bars[1];
  near(execution.startPct, pct(WINDOW.from, '2026-10-21', WINDOW.to));
  near(execution.endPct, pct(WINDOW.from, WINDOW.today, WINDOW.to));
  assert.equal(execution.days, 34);
  assert.equal(execution.clippedStart, null);
  assert.equal(execution.text, 'Execution (In Progress): 21 Oct 2026 to today, 34 days, current.');
  near(l.todayPct!, pct(WINDOW.from, WINDOW.today, WINDOW.to));
  const planning = l.bars[0];
  assert.equal(planning.current, false);
  near(planning.endPct, pct(WINDOW.from, '2026-10-21', WINDOW.to));
  assert.equal(planning.text, 'Planning: 15 Aug 2026 to 21 Oct 2026, 67 days.');
  assert.deepEqual(l.months.map((m) => m.label), ['Sep 2026', 'Oct', 'Nov', 'Dec', 'Jan 2027', 'Feb', 'Mar', 'Apr', 'May']);
  for (let i = 1; i < l.months.length; i++) assert.ok(l.months[i].atPct > l.months[i - 1].atPct);
  near(l.months[0].atPct, pct(WINDOW.from, '2026-09-01', WINDOW.to));
  assert.match(l.summary, /^Planning: .* Execution \(In Progress\): 21 Oct 2026 to today, 34 days, current\.$/);
});

test('a period that began before the window starts at its edge and says where it continues from', () => {
  const l = barsLayout({ ...WINDOW, periods: [{ stage: 'Build', substage: null, startedOn: '2026-06-02', endedOn: null }], lines: [], hiddenKinds: [] });
  assert.equal(l.bars.length, 1);
  assert.equal(l.bars[0].startPct, 0);
  assert.equal(l.bars[0].clippedStart, '2026-06-02');
  assert.equal(l.bars[0].current, true);
  assert.equal(l.bars[0].days, 175);
});

test('three tasks due on one day give one marker with a count of 3', () => {
  const l = barsLayout({ ...WINDOW, periods: GENERAL_PERIODS, lines: [tasksDue('2026-12-02', 3)], hiddenKinds: [] });
  assert.deepEqual(l.markers.map((m) => [m.kind, m.day, m.count, m.text]), [['tasks_due', '2026-12-02', 3, '3 tasks due on 2 Dec 2026']]);
  near(l.markers[0].atPct, pct(WINDOW.from, '2026-12-02', WINDOW.to));
  assert.match(l.summary, /3 tasks due in the window\.$/);
});

test('needed-by lines on one day are grouped; risk reviews and the planned end get their own markers', () => {
  const lines: TimelineLine[] = [
    { day: '2026-12-10', kind: 'resource_needed_by', label: 'Needed by: R1 Projector' },
    { day: '2026-12-10', kind: 'resource_needed_by', label: 'Needed by: Hall hire' },
    { day: '2027-01-05', kind: 'risk_review', label: '1 risk review due', detail: { risks: [{ id: 'r', description: 'x', severity: 'low' }] } },
    { day: '2027-03-31', kind: 'planned_end', label: 'Planned end' },
    { day: '2026-11-02', kind: 'status', label: 'Active' },
  ];
  const l = barsLayout({ ...WINDOW, periods: [], lines, hiddenKinds: [] });
  assert.deepEqual(l.markers.map((m) => [m.kind, m.count, m.text]), [
    ['resource_needed_by', 2, '2 resources needed by 10 Dec 2026'],
    ['risk_review', 1, '1 risk review due on 5 Jan 2027'],
    ['planned_end', 1, 'Planned end 31 Mar 2027'],
  ]);
});

test('a hidden kind gives no marker', () => {
  const lines = [tasksDue('2026-12-02', 3), { day: '2027-03-31', kind: 'planned_end' as const, label: 'Planned end' }];
  const l = barsLayout({ ...WINDOW, periods: GENERAL_PERIODS, lines, hiddenKinds: ['tasks_due'] });
  assert.deepEqual(l.markers.map((m) => m.kind), ['planned_end']);
  assert.doesNotMatch(l.summary, /tasks due/);
});

test('an empty project gives no bars and says so', () => {
  const l = barsLayout({ ...WINDOW, periods: [], lines: [], hiddenKinds: [] });
  assert.deepEqual(l.bars, []);
  assert.deepEqual(l.markers, []);
  assert.equal(l.summary, 'No stages recorded in this window.');
});

test('percentages stay within 0 to 100, whatever the dates', () => {
  const periods = [
    { stage: 'Long ago', substage: null, startedOn: '2020-01-01', endedOn: '2030-01-01' },
    { stage: 'Open', substage: null, startedOn: '2026-01-01', endedOn: null },
  ];
  // Today after the window's end: the open bar stops at the edge.
  const l = barsLayout({ from: '2026-08-24', to: '2026-10-24', today: '2026-11-24', periods, lines: [tasksDue('2026-10-24', 1)], hiddenKinds: [] });
  assert.equal(l.todayPct, null);
  for (const b of l.bars) {
    assert.ok(b.startPct >= 0 && b.startPct <= 100 && b.endPct >= b.startPct && b.endPct <= 100, JSON.stringify(b));
  }
  for (const x of [...l.months.map((m) => m.atPct), ...l.markers.map((m) => m.atPct)]) assert.ok(x >= 0 && x <= 100);
  assert.equal(l.markers[0].atPct, 100);
});
