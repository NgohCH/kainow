import { UUID } from '../common/uuid7';
import type { ProjectStatus } from '../projects/matrix';

/** Analytics filters (dashboards spec 7.1). Days are 'YYYY-MM-DD' in UTC+8; weeks start Monday 00:00 UTC+8. */

export const PERIODS = ['this_month', 'last_month', 'last_4w', 'last_12w', 'last_26w', 'last_52w'] as const;
export type Period = (typeof PERIODS)[number];

export const STATUSES: readonly ProjectStatus[] = ['draft', 'planned', 'active', 'deferred', 'closed'];
export const DEFAULT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'deferred'];
const OWNERSHIPS = ['owned', 'contributed', 'both'] as const;

export type AnalyticsFilters = {
  period: Period;
  /** First and last day of the period, inclusive. */
  from: string;
  to: string;
  departmentId: string | null;
  statuses: ProjectStatus[];
  ownership: 'owned' | 'contributed' | 'both';
  includeArchived: boolean;
};

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => day(ms(d) + n * DAY_MS);
/** The Monday on or before a day. */
const mondayOf = (d: string) => addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));

/** The Mondays of every week that overlaps from..to, first to last. */
export function weekStarts(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) out.push(w);
  return out;
}

/** `Last N weeks` is the current week (so far) and the N-1 whole weeks before it. */
function bounds(period: Period, today: string): { from: string; to: string } {
  if (period === 'this_month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (period === 'last_month') {
    const first = `${today.slice(0, 8)}01`;
    const to = addDays(first, -1);
    return { from: `${to.slice(0, 8)}01`, to };
  }
  const weeks = Number(period.slice(5, -1));
  return { from: addDays(mondayOf(today), -(weeks - 1) * 7), to: today };
}

const one = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === 'string' ? v : null);

/** Parses the query string; a bad value gives `{ error }` (the caller answers 400 with that text). */
export function parseAnalyticsFilters(query: Record<string, unknown>, today: string): AnalyticsFilters | { error: string } {
  const period = one(query.period);
  if (period === null || (period !== undefined && period !== '' && !(PERIODS as readonly string[]).includes(period)))
    return { error: 'Choose a period from the list.' };
  const p = (period || 'last_12w') as Period;

  const dept = one(query.department);
  if (dept === null || (dept !== undefined && dept !== '' && !UUID.test(dept))) return { error: 'Choose a department from the list.' };

  const status = one(query.status);
  let statuses: ProjectStatus[] = [...DEFAULT_STATUSES];
  if (status === null) return { error: 'Choose project statuses from the list.' };
  if (status !== undefined && status.trim() !== '') {
    const list = status.split(',').map((s) => s.trim());
    if (!list.every((s) => (STATUSES as readonly string[]).includes(s))) return { error: 'Choose project statuses from the list.' };
    statuses = [...new Set(list)] as ProjectStatus[];
  }

  const own = one(query.ownership);
  if (own === null || (own !== undefined && own !== '' && !(OWNERSHIPS as readonly string[]).includes(own)))
    return { error: 'Choose owned, contributed or both.' };

  const arch = one(query.includeArchived);
  if (arch === null || (arch !== undefined && arch !== '' && !['1', '0', 'true', 'false'].includes(arch)))
    return { error: 'Include archived must be on or off.' };

  return {
    period: p,
    ...bounds(p, today),
    departmentId: dept ? dept : null,
    statuses,
    ownership: (own || 'both') as AnalyticsFilters['ownership'],
    includeArchived: arch === '1' || arch === 'true',
  };
}
