/** The project timeline (spec 5.2): only recorded dates, never inferred ones. Pure helpers; the loader is in timeline.service.ts. */

/** Every kind of timeline line, in display order. */
export const TIMELINE_KINDS = ['stage', 'status', 'archive', 'tasks_due', 'risk_review', 'planned_end'] as const;

export type TimelineLine = {
  day: string;
  kind: (typeof TIMELINE_KINDS)[number];
  label: string;
  detail?: unknown;
};

/** The longest span a request may cover, in days (two years, one of them a leap year). */
export const MAX_SPAN_DAYS = 731;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const dayNumber = (s: string): number => Math.round(new Date(`${s}T00:00:00Z`).getTime() / DAY_MS);

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export const daysBetween = (a: string, b: string): number => dayNumber(b) - dayNumber(a);

/** `day` moved by whole calendar months; a day that does not exist in the target month becomes its last day. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/** The window asked for: default three months back to six months ahead of `today`. */
export function timelineRange(query: { from?: string; to?: string }, today: string): { from: string; to: string } | { error: string } {
  const from = query.from ?? addMonths(today, -3);
  const to = query.to ?? addMonths(today, 6);
  if (!isDay(from) || !isDay(to)) return { error: 'Dates must be written YYYY-MM-DD.' };
  if (from > to) return { error: 'The start date is after the end date.' };
  if (daysBetween(from, to) > MAX_SPAN_DAYS) return { error: 'The range cannot be longer than two years.' };
  return { from, to };
}

/** Lines grouped by month (YYYY-MM), oldest month first; lines within a month are ordered by day, then as given. */
export function groupByMonth(lines: TimelineLine[]): { month: string; lines: TimelineLine[] }[] {
  const sorted = lines.map((l, i) => ({ l, i })).sort((a, b) => (a.l.day < b.l.day ? -1 : a.l.day > b.l.day ? 1 : a.i - b.i));
  const out: { month: string; lines: TimelineLine[] }[] = [];
  for (const { l } of sorted) {
    const month = l.day.slice(0, 7);
    const last = out[out.length - 1];
    if (last && last.month === month) last.lines.push(l);
    else out.push({ month, lines: [l] });
  }
  return out;
}
