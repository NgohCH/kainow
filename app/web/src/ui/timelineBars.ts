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

export interface BarsLayout {
  months: { label: string; atPct: number }[];
  todayPct: number | null;
  bars: TimelineBar[];
  markers: TimelineMarker[];
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
  if (Array.isArray(list)) return list.length;
  const n = /^(\d+) /.exec(line.label);
  return n ? Number(n[1]) : 1;
}

function markerText(kind: MarkerKind, count: number, day: string): string {
  const on = dayLabel(day);
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

  const totals = MARKER_KINDS.map((k) => windowTotal(k.kind, markers)).filter((s): s is string => s !== null);
  const summary = [bars.length > 0 ? bars.map((b) => b.text).join(' ') : 'No stages recorded in this window.', ...totals].join(' ');

  return { months, todayPct: inWindow(today) ? at(today) : null, bars, markers, summary };
}
