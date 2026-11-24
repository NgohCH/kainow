/**
 * Timeline bars (D132, spec 15): where each stage period and each marked date falls in the Timeline's date window.
 * Built only from recorded dates: stage periods, task due dates, risk review dates, needed-by dates and the planned end.
 * Positions are percentages of the window (0 at `from`, 100 at `to`).
 */
import { dayLabel, type TimelineLine } from '../dashboard.ts';
import type { TimelineKind } from '../prefs.ts';

export interface StagePeriod { stage: string; substage: string | null; startedOn: string; endedOn: string | null }

export interface TimelineBar {
  stage: string;
  substage: string | null;
  startPct: number;
  endPct: number;
  current: boolean;
  /** The period's real start when it began before the window (the bar starts at the window's edge); otherwise null. */
  clippedStart: string | null;
  days: number;
  text: string;
}

export type MarkerKind = 'tasks_due' | 'risk_review' | 'resource_needed_by' | 'planned_end';
export interface TimelineMarker { kind: MarkerKind; day: string; atPct: number; count: number; text: string }

/** What is drawn in a marker row: one day's marker, or a run of days too close together to draw apart, as one total. */
export interface DrawnMarker { atPct: number; startPct: number; endPct: number; lane: number; count: number; text: string }
export interface MarkerRow { kind: MarkerKind; lanes: number; items: DrawnMarker[] }

export interface BarsLayout {
  months: { label: string; atPct: number }[];
  todayPct: number | null;
  bars: TimelineBar[];
  markers: TimelineMarker[];
  markerRows: MarkerRow[];
  summary: string;
}

/** The marker rows, in display order, with the symbol and the words each marker is shown with. */
export const MARKER_KINDS: readonly { kind: MarkerKind; symbol: string; label: string }[] = [
  { kind: 'tasks_due', symbol: '▲', label: 'Task due dates' },
  { kind: 'risk_review', symbol: '◇', label: 'Risk reviews' },
  { kind: 'resource_needed_by', symbol: '▼', label: 'Resources needed by' },
  { kind: 'planned_end', symbol: '⚑', label: 'Planned end' },
];

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
const daysBetween = (a: string, b: string) => Math.round(dayNumber(b) - dayNumber(a));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many things one timeline line stands for: a due-day line lists its tasks, a risk-review line its risks. */
function lineCount(line: TimelineLine): number {
  const d = line.detail as { tasks?: unknown[]; risks?: unknown[] } | undefined;
  const list = line.kind === 'tasks_due' ? d?.tasks : line.kind === 'risk_review' ? d?.risks : undefined;
  return list ? list.length : 1;
}

function markerText(kind: MarkerKind, count: number, first: string, last = first): string {
  const on = dayLabel(first);
  if (first !== last) {
    const range = `from ${on} to ${dayLabel(last)}`;
    if (kind === 'tasks_due') return `${plural(count, 'task', 'tasks')} due ${range}`;
    if (kind === 'risk_review') return `${plural(count, 'risk review', 'risk reviews')} due ${range}`;
    return `${plural(count, 'resource', 'resources')} needed ${range}`;
  }
  if (kind === 'tasks_due') return `${plural(count, 'task', 'tasks')} due on ${on}`;
  if (kind === 'risk_review') return `${plural(count, 'risk review', 'risk reviews')} due on ${on}`;
  if (kind === 'resource_needed_by') return `${plural(count, 'resource', 'resources')} needed by ${on}`;
  return `Planned end ${on}`;
}

function windowTotal(kind: MarkerKind, markers: TimelineMarker[]): string | null {
  const these = markers.filter((m) => m.kind === kind);
  if (these.length === 0) return null;
  const n = these.reduce((s, m) => s + m.count, 0);
  if (kind === 'tasks_due') return `${plural(n, 'task', 'tasks')} due in the window.`;
  if (kind === 'risk_review') return `${plural(n, 'risk review', 'risk reviews')} due in the window.`;
  if (kind === 'resource_needed_by') return `${plural(n, 'resource', 'resources')} needed in the window.`;
  return `Planned end ${dayLabel(these[0].day)}.`;
}

const MAX_LANES = 3;
/** The narrowest the track is drawn, in rem: .tl-plot's 52rem minimum less its 10rem labels and 4.5rem end space (styles.css). */
const TRACK_REM = 37.5;
const inPct = (rem: number) => (rem * 100) / TRACK_REM;

type Group = { days: TimelineMarker[]; atPct: number; startPct: number; endPct: number; from: number; to: number; count: number };

/** Days drawn as one marker, with the space it takes: the symbol centred on its date, the count after it, a line across a run. */
function group(days: TimelineMarker[]): Group {
  const startPct = days[0].atPct;
  const endPct = days[days.length - 1].atPct;
  const atPct = (startPct + endPct) / 2;
  const count = days.reduce((n, m) => n + m.count, 0);
  const right = count > 1 ? 0.75 + 0.5 * String(count).length : 0.6;
  return { days, atPct, startPct, endPct, count, from: Math.min(startPct, atPct - inPct(0.6)), to: Math.max(endPct, atPct + inPct(right)) };
}

/** Markers that would cover each other go on up to three lanes; a stretch that needs more becomes one total. */
function markerRow(kind: MarkerKind, markers: TimelineMarker[]): MarkerRow {
  let groups = markers.map((m) => group([m]));
  for (;;) {
    // Stretches of markers that touch, each marker on the first free lane.
    const stretches: { groups: Group[]; lanes: number[]; laneEnds: number[]; to: number }[] = [];
    for (const g of [...groups].sort((a, b) => a.from - b.from)) {
      let s = stretches[stretches.length - 1];
      if (!s || g.from >= s.to) stretches.push((s = { groups: [], lanes: [], laneEnds: [], to: 0 }));
      const free = s.laneEnds.findIndex((end) => end <= g.from);
      const lane = free < 0 ? s.laneEnds.length : free;
      s.laneEnds[lane] = g.to;
      s.lanes.push(lane);
      s.groups.push(g);
      s.to = Math.max(s.to, g.to);
    }
    if (stretches.every((s) => s.laneEnds.length <= MAX_LANES)) {
      const items = stretches.flatMap((s) =>
        s.groups.map((g, i): DrawnMarker => ({
          atPct: g.atPct,
          startPct: g.startPct,
          endPct: g.endPct,
          lane: s.lanes[i],
          count: g.count,
          text: markerText(kind, g.count, g.days[0].day, g.days[g.days.length - 1].day),
        })),
      );
      return { kind, lanes: Math.max(...stretches.map((s) => s.laneEnds.length)), items };
    }
    // A total can be wider than the days it stands for, so check again: there are fewer groups each time.
    groups = stretches.flatMap((s) =>
      s.laneEnds.length <= MAX_LANES ? s.groups : [group(s.groups.flatMap((g) => g.days).sort((a, b) => (a.day < b.day ? -1 : 1)))],
    );
  }
}

export function barsLayout(input: {
  from: string;
  to: string;
  today: string;
  periods: readonly StagePeriod[];
  lines: readonly TimelineLine[];
  hiddenKinds: readonly TimelineKind[];
}): BarsLayout {
  const { from, to, today } = input;
  const span = Math.max(1, daysBetween(from, to));
  const at = (day: string) => Math.min(100, Math.max(0, (daysBetween(from, day) * 100) / span));
  const inWindow = (day: string) => day >= from && day <= to;

  const months: BarsLayout['months'] = [];
  let [y, m] = from.split('-').map(Number);
  if (!from.endsWith('-01')) [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  for (let first = `${y}-${String(m).padStart(2, '0')}-01`; first <= to; ) {
    months.push({ label: months.length === 0 || m === 1 ? `${SHORT_MONTHS[m - 1]} ${y}` : SHORT_MONTHS[m - 1], atPct: at(first) });
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    first = `${y}-${String(m).padStart(2, '0')}-01`;
  }

  const bars: TimelineBar[] = input.periods
    .filter((p) => p.startedOn <= to && (p.endedOn ?? today) >= from)
    .map((p) => {
      const current = p.endedOn === null;
      const end = p.endedOn ?? today;
      const days = Math.max(0, daysBetween(p.startedOn, end));
      const name = p.substage ? `${p.stage} (${p.substage})` : p.stage;
      const text = current
        ? `${name}: ${dayLabel(p.startedOn)} to today, ${plural(days, 'day', 'days')}, current.`
        : `${name}: ${dayLabel(p.startedOn)} to ${dayLabel(end)}, ${plural(days, 'day', 'days')}.`;
      return {
        stage: p.stage,
        substage: p.substage,
        startPct: at(p.startedOn),
        endPct: at(end),
        current,
        clippedStart: p.startedOn < from ? p.startedOn : null,
        days,
        text,
      };
    });

  const grouped = new Map<string, TimelineMarker>();
  for (const line of input.lines) {
    const kind = line.kind as MarkerKind;
    if (!MARKER_KINDS.some((k) => k.kind === kind) || input.hiddenKinds.includes(kind) || !inWindow(line.day)) continue;
    const key = `${kind} ${line.day}`;
    const seen = grouped.get(key);
    const count = (seen?.count ?? 0) + lineCount(line);
    grouped.set(key, { kind, day: line.day, atPct: at(line.day), count, text: markerText(kind, count, line.day) });
  }
  const order = (k: MarkerKind) => MARKER_KINDS.findIndex((x) => x.kind === k);
  const markers = [...grouped.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : order(a.kind) - order(b.kind)));

  const markerRows = MARKER_KINDS.map((k) => ({ kind: k.kind, of: markers.filter((m) => m.kind === k.kind) }))
    .filter((r) => r.of.length > 0)
    .map((r) => markerRow(r.kind, r.of));

  const totals = MARKER_KINDS.map((k) => windowTotal(k.kind, markers)).filter((s): s is string => s !== null);
  const summary = [bars.length > 0 ? bars.map((b) => b.text).join(' ') : 'No stages recorded in this window.', ...totals].join(' ');

  return { months, todayPct: inWindow(today) ? at(today) : null, bars, markers, markerRows, summary };
}
