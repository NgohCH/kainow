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

// Every drawn marker's space, in pixels at the narrowest track (600 px): symbol centred on its date, count after it.
const clear = (l: ReturnType<typeof barsLayout>) => {
  for (const r of l.markerRows) {
    for (const a of r.items) {
      for (const b of r.items) {
        if (a === b || a.lane !== b.lane || a.atPct > b.atPct) continue;
        const aEnd = Math.max(a.endPct * 6, a.atPct * 6 + (a.count > 1 ? 10 + 7.5 * String(a.count).length : 8));
        const bStart = Math.min(b.startPct * 6, b.atPct * 6 - 8);
        assert.ok(aEnd <= bStart, `${a.text} covers ${b.text}`);
      }
    }
  }
};
const drawn = (l: ReturnType<typeof barsLayout>) => l.markerRows.reduce((n, r) => n + r.items.reduce((m, i) => m + i.count, 0), 0);
const dayAfter = (n: number) => new Date(Date.parse('2026-12-01T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

test('close markers go on separate lanes, so none covers another; far ones share a lane', () => {
  const l = barsLayout({ ...WINDOW, periods: [], lines: [tasksDue(dayAfter(0), 3), tasksDue(dayAfter(2), 12), tasksDue(dayAfter(4), 1), tasksDue(dayAfter(60), 2)], hiddenKinds: [] });
  assert.equal(l.markerRows[0].lanes, 3);
  assert.deepEqual(l.markerRows[0].items.map((i) => [i.lane, i.count]), [[0, 3], [1, 12], [2, 1], [0, 2]]);
  clear(l);
});

test('a stretch needing more than three lanes becomes one total that names its dates and count; per-day markers stay in the data', () => {
  const l = barsLayout({ ...WINDOW, periods: [], lines: [0, 1, 2, 3, 4].map((n) => tasksDue(dayAfter(n), n + 1)), hiddenKinds: [] });
  assert.deepEqual(l.markerRows[0].items.map((i) => [i.count, i.text]), [[15, '15 tasks due from 1 Dec 2026 to 5 Dec 2026']]);
  assert.equal(l.markers.length, 5);
});

test('no count is lost and nothing overlaps, however the dates fall', () => {
  for (let step = 1; step <= 12; step++) {
    for (const n of [1, 9, 120]) {
      const lines: TimelineLine[] = [];
      for (let d = 0, i = 0; d < 150; d += 1 + ((i * step) % 7), i++) lines.push(tasksDue(dayAfter(d), 1 + ((n * i) % (n + 1))));
      const l = barsLayout({ ...WINDOW, periods: [], lines, hiddenKinds: [] });
      assert.equal(drawn(l), l.markers.reduce((s, m) => s + m.count, 0));
      assert.ok(l.markerRows[0].lanes <= 3);
      clear(l);
    }
  }
});

test('a repeated stage keeps one bar per period, and a same-day period is a 0-day bar', () => {
  const l = barsLayout({
    ...WINDOW,
    periods: [
      { stage: 'Build', substage: null, startedOn: '2026-09-01', endedOn: '2026-10-01' },
      { stage: 'Testing', substage: null, startedOn: '2026-10-01', endedOn: '2026-10-01' },
      { stage: 'Build', substage: null, startedOn: '2026-10-01', endedOn: null },
    ],
    lines: [],
    hiddenKinds: [],
  });
  assert.deepEqual(l.bars.map((b) => [b.stage, b.days, b.current]), [['Build', 30, false], ['Testing', 0, false], ['Build', 54, true]]);
  assert.equal(l.bars[1].startPct, l.bars[1].endPct);
});

test('a window wholly in the future draws no bar for the open stage', () => {
  const l = barsLayout({ from: '2027-01-01', to: '2027-06-01', today: '2026-11-24', periods: GENERAL_PERIODS, lines: [], hiddenKinds: [] });
  assert.deepEqual(l.bars, []);
  assert.equal(l.todayPct, null);
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

test('a stopped period ends on its day, is not current, and says why', () => {
  const l = barsLayout({
    ...WINDOW,
    periods: [
      { stage: 'Planning', substage: null, startedOn: '2026-09-01', endedOn: '2026-09-11', stopped: 'deferred' },
      { stage: 'Planning', substage: null, startedOn: '2026-10-01', endedOn: '2026-10-02', stopped: 'closed' },
    ],
    lines: [],
    hiddenKinds: [],
  });
  assert.deepEqual(l.bars.map((b) => [b.current, b.stopped, b.days]), [[false, 'deferred', 10], [false, 'closed', 1]]);
  near(l.bars[0].endPct, pct(WINDOW.from, '2026-09-11', WINDOW.to));
  assert.equal(l.bars[0].text, 'Planning: 1 Sep 2026 to 11 Sep 2026, 10 days, stopped when deferred.');
  assert.equal(l.bars[1].text, 'Planning: 1 Oct 2026 to 2 Oct 2026, 1 day, stopped when closed.');
  assert.match(l.summary, /stopped when closed\.$/);
});
