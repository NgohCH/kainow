/**
 * Administrator analytics on the web (dashboards spec 7). The shapes mirror what the server sends (app/src/analytics/*.ts);
 * the web cannot import server code. The web never works out a figure: it words, orders and lays out what the server gave.
 */
import { type Completion, type OnTime, type PlannedEnd, dayLabel, onTimeLabel } from './dashboard.ts';
import type { Currency } from './finance.ts';
import type { ProjectStatus } from './projects.ts';

// ---- Filters (spec 7.1; app/src/analytics/filters.ts) ---------------------------------------------------------------

export const PERIODS = ['this_month', 'last_month', 'last_4w', 'last_12w', 'last_26w', 'last_52w'] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<Period, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  last_4w: 'Last 4 weeks',
  last_12w: 'Last 12 weeks',
  last_26w: 'Last 26 weeks',
  last_52w: 'Last 52 weeks',
};

export const STATUSES: readonly ProjectStatus[] = ['draft', 'planned', 'active', 'deferred', 'closed'];
export const OWNERSHIPS = ['both', 'owned', 'contributed'] as const;
export type Ownership = (typeof OWNERSHIPS)[number];
export const OWNERSHIP_LABELS: Record<Ownership, string> = { both: 'Owned or contributed', owned: 'Owned', contributed: 'Contributed' };

/** The same shape as a saved view's `filters`. */
export interface Filters {
  period: Period;
  department: string | null;
  status: ProjectStatus[];
  ownership: Ownership;
  includeArchived: boolean;
}

export const DEFAULT_FILTERS: Filters = { period: 'last_12w', department: null, status: ['planned', 'active', 'deferred'], ownership: 'both', includeArchived: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The query string (without `?`) the server's `parseAnalyticsFilters` reads: `period`, `status` (comma list), and
 * `department` with `ownership` (ownership only applies with a department, so it is sent only then), `includeArchived=1`.
 */
export function filtersToQuery(f: Filters): string {
  const q = new URLSearchParams();
  q.set('period', f.period);
  q.set('status', STATUSES.filter((s) => f.status.includes(s)).join(','));
  if (f.department) {
    q.set('department', f.department);
    q.set('ownership', f.ownership);
  }
  if (f.includeArchived) q.set('includeArchived', '1');
  return q.toString();
}

/** Reads a query string back into filters; a value the server would refuse falls back to its default. */
export function queryToFilters(query: string): Filters {
  const q = new URLSearchParams(query.replace(/^\?/, ''));
  const period = q.get('period');
  const department = q.get('department');
  const listed = (q.get('status') ?? '').split(',').map((s) => s.trim());
  const status = listed.every((s) => (STATUSES as readonly string[]).includes(s)) ? STATUSES.filter((s) => listed.includes(s)) : [];
  const ownership = q.get('ownership');
  const dept = department && UUID.test(department) ? department.toLowerCase() : null;
  const arch = q.get('includeArchived');
  return {
    period: (PERIODS as readonly string[]).includes(period ?? '') ? (period as Period) : DEFAULT_FILTERS.period,
    department: dept,
    status: status.length > 0 ? status : [...DEFAULT_FILTERS.status],
    ownership: dept && (OWNERSHIPS as readonly string[]).includes(ownership ?? '') ? (ownership as Ownership) : 'both',
    includeArchived: arch === '1' || arch === 'true',
  };
}

// ---- Panel shapes (app/src/analytics/panels.service.ts, system.service.ts, trends.service.ts) -----------------------

export interface ProjectRef {
  id: string;
  name: string;
}

export interface ProgressRow {
  id: string;
  name: string;
  departmentId: string;
  owningDepartment: string;
  status: ProjectStatus;
  stage: { stage: string; substage: string | null; days: number } | null;
  completion: Completion;
  onTime: OnTime;
  plannedEnd: PlannedEnd;
  overdue: number;
  blocked: number;
}

export interface Roll {
  id: string;
  name: string;
  projects: number;
  tasksDone: number;
  tasksTotal: number;
  completionPercent: number | null;
  onTimeDue: number;
  onTimeDone: number;
  onTimeLate: number;
  onTimePercent: number | null;
  overdue: number;
  blocked: number;
  alsoContributesTo: Array<ProjectRef & { owningDepartment: string }>;
}

export interface ProgressPanel {
  departments: Roll[];
  projects: ProgressRow[];
  nothingDue: ProjectRef[];
  computedAt: string;
}

export const PROBLEM_KEYS = [
  'overdueTasks',
  'blockedTasks',
  'openHighCriticalRisks',
  'overdueRiskReviews',
  'vacantRequiredRoles',
  'openEscalations',
  'noIndependentEscalation',
  'deadlineReviewsPending',
  'invitationsExpired',
] as const;
export type ProblemKey = (typeof PROBLEM_KEYS)[number];
export type ProblemCounts = Record<ProblemKey, number>;

/** The same words as the CSV export (app/src/analytics/csv.ts). */
export const PROBLEM_LABELS: Record<ProblemKey, string> = {
  overdueTasks: 'Overdue tasks',
  blockedTasks: 'Blocked tasks',
  openHighCriticalRisks: 'Open High and Critical risks',
  overdueRiskReviews: 'Overdue risk reviews',
  vacantRequiredRoles: 'Vacant required roles',
  openEscalations: 'Open escalations',
  noIndependentEscalation: 'No independent escalation recipient',
  deadlineReviewsPending: 'Deadline reviews pending',
  invitationsExpired: 'Invitations expired in the period',
};

export interface ProblemsPanel {
  organisation: ProblemCounts;
  departments: Array<ProjectRef & ProblemCounts & { projects: number }>;
  projects: Array<ProjectRef & ProblemCounts & { departmentId: string; owningDepartment: string }>;
  computedAt: string;
}

export interface SystemPanel {
  emails: { failed: number; uncertain: number; retryWaiting: number };
  ai: { blockedByReason: Record<string, number>; keyRejected: number };
  jobs: { failedByQueue: Record<string, number>; waitingOver15m: number };
  security: { casesAwaitingReview: number; protectedKeyInstalled: boolean };
  links: { emails: string; ai: string; jobs: string | null; security: string };
  computedAt: string;
}

export const TREND_KEYS = [
  'tasks_authorised', 'tasks_completed', 'tasks_became_overdue', 'proposals_authorised', 'proposals_rejected', 'projects_active', 'projects_deferred', 'projects_closed',
] as const;
export type TrendKey = (typeof TREND_KEYS)[number];
export const TREND_LABELS: Record<TrendKey, string> = {
  tasks_authorised: 'Tasks authorised',
  tasks_completed: 'Tasks completed',
  tasks_became_overdue: 'Tasks became overdue',
  proposals_authorised: 'Proposals authorised',
  proposals_rejected: 'Proposals rejected',
  projects_active: 'Projects moved into Active',
  projects_deferred: 'Projects moved into Deferred',
  projects_closed: 'Projects moved into Closed',
};

export interface TrendsPanel {
  weeks: string[];
  series: Record<TrendKey, number[]>;
  note: string;
  computedAt: string;
}

/** The Resources and finance panel (app/src/analytics/resources-panel.ts): counts, item references and summary figures only. */
export interface ResourceLineRow {
  needed: number;
  arranged: number;
  inUse: number;
  finishedInPeriod: number;
  neededByPassed: number;
  overlapping: number;
}
export interface ResourcesProject extends ResourceLineRow {
  id: string;
  name: string;
  departmentId: string;
  owningDepartment: string;
}
export interface ResourcesDepartment extends ResourceLineRow {
  id: string;
  name: string;
  projects: number;
}
export interface SharedItem {
  itemId: string;
  reference: string;
  name: string;
  projects: number;
  earliestOverlap: string;
}
export interface FinanceProject {
  id: string;
  name: string;
  departmentId: string;
  owningDepartment: string;
  /** Null when Not provided. */
  budget: string | null;
  spent: string;
  percentUsed: number | null;
  overBudget: boolean;
  level: 0 | 1 | 2;
  notInTotals: { currency: Currency; amount: string }[];
}
export interface FinanceGroup {
  currency: Currency;
  projectsTracking: number;
  budgetNotProvided: number;
  totalBudget: string;
  totalSpent: string;
  atFirst: number;
  atSecond: number;
  projects: FinanceProject[];
}
export interface ResourcesPanel {
  lines: { organisation: ResourceLineRow; departments: ResourcesDepartment[]; projects: ResourcesProject[] };
  sharedItems: SharedItem[];
  finance: FinanceGroup[];
  /** In-scope projects whose financial tracking is Not required: counted apart, never as zero. */
  notRequired: number;
  computedAt: string;
}
export type ResourcesTable = 'lines' | 'sharedItems' | 'finance';

export const COVERAGE_NOTE = 'Counts all authorised records in the project except deleted ones and any under credential review.';

// ---- Sorting ----------------------------------------------------------------------------------------------------------

export type SortDir = 'asc' | 'desc';

/** The value a column sorts by; null (no figure: "Nothing due yet", not measurable, no planned end, missing) sorts last. */
function sortValue(row: Record<string, unknown>, column: string): number | string | null {
  const v = row[column];
  if (column === 'onTime') return (v as OnTime | undefined)?.state === 'measured' ? (v as Extract<OnTime, { state: 'measured' }>).percent : null;
  if (column === 'completion') return (v as Completion | undefined)?.state === 'measurable' ? (v as Extract<Completion, { state: 'measurable' }>).percent : null;
  if (column === 'plannedEnd') {
    const p = v as PlannedEnd | undefined;
    return !p || p.state === 'none' ? null : p.state === 'ended' ? -p.daysAgo : p.days;
  }
  if (column === 'status') return typeof v === 'string' ? STATUSES.indexOf(v as ProjectStatus) : null;
  if (column === 'stage') return v ? `${(v as { stage: string }).stage}` : null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return null;
}

/** A sorted copy. Rows without a figure in the column (for On-time, "Nothing due yet") are last in both directions; ties go by name. */
export function sortRows<T extends { id: string; name: string }>(rows: readonly T[], column: string, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return [...rows].sort((a, b) => {
    const x = sortValue(a as unknown as Record<string, unknown>, column);
    const y = sortValue(b as unknown as Record<string, unknown>, column);
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return c !== 0 ? sign * c : byName(a, b);
  });
}

// ---- Charts and their tables -----------------------------------------------------------------------------------------

/** One point of a chart: its label, its figure (null when there is none to draw) and the figure in words. */
export interface ChartPoint {
  label: string;
  value: number | null;
  text: string;
}

/** The On-time completion chart: one point per project, "Nothing due yet" as a missing value (never a zero bar). */
export function onTimeSeries(rows: readonly ProgressRow[]): ChartPoint[] {
  return rows.map((r) => ({ label: r.name, value: r.onTime.state === 'measured' ? r.onTime.percent : null, text: onTimeLabel(r.onTime) }));
}

/** A trend measure: one point per week. */
export function trendSeries(weeks: readonly string[], values: readonly number[]): ChartPoint[] {
  return weeks.map((w, i) => ({ label: `Week of ${dayLabel(w)}`, value: values[i] ?? null, text: String(values[i] ?? '') }));
}

/** The rows of the table behind a chart: every point, in order, with the same figure. */
export function chartTableEquivalent(series: readonly ChartPoint[]): ChartPoint[] {
  return series.map((p) => ({ label: p.label, value: p.value, text: p.text }));
}

/** The bars drawn for a chart (scaled to its largest value, or to 100 for percentages) and the points listed under it. */
export function chartBars(series: readonly ChartPoint[], scale: 'percent' | 'count' = 'count') {
  const max = scale === 'percent' ? 100 : Math.max(0, ...series.map((p) => p.value ?? 0));
  const bars = chartTableEquivalent(series).map((p) => ({ ...p, max }));
  return { items: bars, drawn: bars.filter((b) => b.value !== null), missing: bars.filter((b) => b.value === null) };
}

// ---- Drill-down (app/src/analytics/drill.service.ts) ----------------------------------------------------------------

export type DrillLevel = 'org' | 'department' | 'project';
export type DrillMeasure = ProblemKey | 'completion' | 'onTime' | 'overdue' | 'blocked';
export type DrillValue = number | Record<string, number>;

export interface DrillResult {
  level: DrillLevel;
  id: string | null;
  measure: DrillMeasure;
  counts: { total: DrillValue; breakdown?: Array<{ id: string; name: string; value: DrillValue }> };
  records?: Array<{ id: string; title: string; assignee: string | null; dueOn: string | null; link: string }>;
  limited?: string;
  computedAt: string;
}

export const DRILL_LABELS: Record<DrillMeasure, string> = {
  ...PROBLEM_LABELS,
  completion: 'Task completion',
  onTime: 'On-time completion',
  overdue: 'Overdue tasks',
  blocked: 'Blocked tasks',
};

/** A drill-down figure in words: a count, or the parts of task completion or on-time completion. */
export function drillValueText(measure: DrillMeasure, v: DrillValue): string {
  if (typeof v === 'number') return String(v);
  const n = (k: string) => v[k] ?? 0;
  if (measure === 'completion') {
    const base = n('total') === 0 ? 'Progress not yet measurable' : `${n('done')} of ${n('total')} tasks done`;
    return n('cancelled') > 0 ? `${base}, ${n('cancelled')} cancelled` : base;
  }
  const parts = [n('due') === 0 ? 'Nothing due yet' : `${n('done')} of ${n('due')} tasks due so far are done, ${n('late')} late`];
  if (n('awaitingReview') > 0) parts.push(`Awaiting deadline review: ${n('awaitingReview')}`);
  return parts.join(', ');
}

// ---- Saved views and layout (app/src/analytics/views.service.ts) ----------------------------------------------------

export const VIEW_PANELS = ['progress', 'problems', 'system', 'trends', 'resources', 'aiUsage'] as const;
export type ViewPanel = (typeof VIEW_PANELS)[number];
export const PANEL_LABELS: Record<ViewPanel, string> = {
  progress: 'Project progress',
  problems: 'Project problems',
  system: 'System problems',
  trends: 'Trends',
  resources: 'Resources and finance',
  aiUsage: 'AI usage',
};

export const VIEW_COLUMNS = {
  progress: ['name', 'owningDepartment', 'status', 'stage', 'completion', 'onTime', 'plannedEnd', 'overdue', 'blocked'],
  problems: ['name', 'owningDepartment', ...PROBLEM_KEYS],
} as const;
export type ColumnPanel = keyof typeof VIEW_COLUMNS;
export const COLUMN_LABELS: Record<string, string> = {
  name: 'Project',
  owningDepartment: 'Owning department',
  status: 'Status',
  stage: 'Stage',
  completion: 'Task completion',
  onTime: 'On-time completion',
  plannedEnd: 'Planned end',
  overdue: 'Overdue',
  blocked: 'Blocked',
  ...PROBLEM_LABELS,
};

export type ChartMode = 'chart' | 'table';
export const VIEW_CHARTS = ['progress.onTime', ...TREND_KEYS.map((k) => `trends.${k}`), 'resources.finance.MYR', 'resources.finance.SGD', 'resources.finance.USD'];

export interface ViewConfig {
  filters: Filters;
  panels: { order: ViewPanel[]; hidden: ViewPanel[] };
  columns: Record<ColumnPanel, { order: string[]; hidden: string[] }>;
  charts: Record<string, ChartMode>;
}

export interface SavedView {
  id: string;
  name: string;
  config: ViewConfig;
}

/** The defaults "Reset" returns to: default filters, every panel and column shown in spec order, every chart as a chart. */
export function defaultViewConfig(): ViewConfig {
  return {
    filters: { ...DEFAULT_FILTERS, status: [...DEFAULT_FILTERS.status] },
    panels: { order: [...VIEW_PANELS], hidden: [] },
    columns: {
      progress: { order: [...VIEW_COLUMNS.progress], hidden: [] },
      problems: { order: [...VIEW_COLUMNS.problems], hidden: [] },
    },
    charts: Object.fromEntries(VIEW_CHARTS.map((k) => [k, 'chart' as ChartMode])),
  };
}

/** The list with `item` moved one place up (-1) or down (+1); unchanged at either end. */
export function moveItem<T>(list: readonly T[], item: T, delta: -1 | 1): T[] {
  const i = list.indexOf(item);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ---- Definitions page -----------------------------------------------------------------------------------------------

/** Definition text split at backticks: the quoted spans are code (shown as <code>, never as HTML). */
export function definitionParts(text: string): Array<{ code: boolean; text: string }> {
  return text
    .split('`')
    .map((t, i) => ({ code: i % 2 === 1, text: t }))
    .filter((p) => p.text !== '');
}
