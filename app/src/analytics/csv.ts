import { COVERAGE_NOTE, MEASURES_VERSION, type PlannedEnd } from '../dashboards/measures';
import type { ProjectStatus } from '../projects/matrix';
import type { AnalyticsFilters } from './filters';
import { PROBLEM_KEYS, type ProblemsPanel, type ProgressPanel } from './panels.service';
import type { SystemPanel } from './system.service';
import { TREND_KEYS, TRENDS_NOTE, type TrendKey, type TrendsPanel } from './trends.service';

/**
 * CSV for the analytics export (dashboards spec 7.6): RFC 4180 cells with CRLF line ends, preceded by `#` lines that
 * state what the file holds. A text cell starting with `=`, `+`, `-` or `@` gets a `'` in front, so a spreadsheet never
 * reads it as a formula. Numbers are written as they are (they come from counts, never from typed text).
 */

const FORMULA_START = /^[=+\-@]/;
/** UTF-8 byte order mark, so spreadsheet programs read Malay characters correctly. */
export const BOM = '\uFEFF';
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  if (typeof v === 'number') return String(v);
  const guarded = FORMULA_START.test(v) ? `'${v}` : v;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** `# Key: value` lines (a value's line breaks become spaces, so it cannot leave its line), the header row, then the rows. */
export function toCsv(meta: Record<string, string>, columns: string[], rows: unknown[][], opts: { bom?: boolean } = {}): string {
  const cell = (v: unknown) => csvCell(v === null || v === undefined ? null : typeof v === 'number' ? v : String(v));
  const lines = [
    ...Object.entries(meta).map(([k, v]) => `# ${k}: ${v.replace(/[\r\n]+/g, ' ')}`),
    columns.map(cell).join(','),
    ...rows.map((r) => r.map(cell).join(',')),
  ];
  return `${opts.bom ? BOM : ''}${lines.join('\r\n')}\r\n`;
}

// ---- The analytics tables as CSV ------------------------------------------------------------------------------------

/** The panels that can be exported, and their names in the file. */
export const EXPORT_PANELS = { progress: 'Project progress', problems: 'Project problems', system: 'System problems', trends: 'Trends' } as const;
export type ExportPanel = keyof typeof EXPORT_PANELS;

const PERIOD_LABEL: Record<AnalyticsFilters['period'], string> = {
  this_month: 'This month',
  last_month: 'Last month',
  last_4w: 'Last 4 weeks',
  last_12w: 'Last 12 weeks',
  last_26w: 'Last 26 weeks',
  last_52w: 'Last 52 weeks',
};
const STATUS_LABEL: Record<ProjectStatus, string> = { draft: 'Draft', planned: 'Planned', active: 'Active', deferred: 'Deferred', closed: 'Closed' };
const OWNERSHIP_LABEL: Record<AnalyticsFilters['ownership'], string> = { owned: 'owned', contributed: 'contributed', both: 'owned and contributed' };

export const PROBLEM_LABELS: Record<(typeof PROBLEM_KEYS)[number], string> = {
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

/** 'YYYY-MM-DD HH:mm (UTC+8)'. */
export const utc8Minute = (iso: string): string => `${new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} (UTC+8)`;

/** The `#` lines: panel, filters, period, measure definitions version, computedAt (UTC+8) and coverage. */
export function exportMeta(panel: ExportPanel, f: AnalyticsFilters, departmentName: string | null, computedAt: string): Record<string, string> {
  const parts: string[] = [];
  if (panel === 'system') parts.push('department, status, ownership and include archived do not apply (organisation-wide)');
  else {
    parts.push(`department: ${departmentName ?? 'all'}`);
    if (panel !== 'trends') parts.push(`status: ${f.statuses.map((s) => STATUS_LABEL[s]).join(', ')}`);
    parts.push(`ownership: ${f.departmentId ? OWNERSHIP_LABEL[f.ownership] : OWNERSHIP_LABEL.both}`);
    parts.push(panel === 'trends' ? 'status and include archived do not apply to trends' : `include archived: ${f.includeArchived ? 'yes' : 'no'}`);
  }
  return {
    Panel: EXPORT_PANELS[panel],
    Filters: parts.join('; '),
    Period: `${PERIOD_LABEL[f.period]}, ${f.from} to ${f.to}`,
    'Measure definitions version': MEASURES_VERSION,
    'Computed at': utc8Minute(computedAt),
    Coverage: panel === 'trends' ? `${COVERAGE_NOTE} ${TRENDS_NOTE}` : COVERAGE_NOTE,
  };
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const plannedEndText = (p: PlannedEnd): string => (p.state === 'none' ? 'No planned end date' : p.state === 'ahead' ? `In ${days(p.days)}` : `Ended ${days(p.daysAgo)} ago`);

type Table = { columns: string[]; rows: unknown[][] };
export type PanelData =
  | { panel: 'progress'; data: ProgressPanel }
  | { panel: 'problems'; data: ProblemsPanel }
  | { panel: 'system'; data: SystemPanel }
  | { panel: 'trends'; data: TrendsPanel };

/** One table per panel, from the same data the panel shows (summary rows first, then project rows). */
export function panelTable(p: PanelData): Table {
  if (p.panel === 'progress') {
    const columns = [
      'Level', 'Name', 'Owning department', 'Status', 'Stage', 'Days in stage', 'Completed tasks', 'Eligible tasks', 'Cancelled tasks', 'Task completion %',
      'Due so far', 'Done', 'Late', 'On-time completion %', 'Awaiting deadline review', 'Planned end', 'Overdue', 'Blocked',
    ];
    const rows: unknown[][] = p.data.departments.map((r) => [
      'Department', r.name, '', '', '', '', r.tasksDone, r.tasksTotal, '', r.completionPercent ?? 'Progress not yet measurable',
      r.onTimeDue, r.onTimeDone, r.onTimeLate, r.onTimePercent ?? 'Nothing due yet', '', '', r.overdue, r.blocked,
    ]);
    for (const r of p.data.projects) {
      const c = r.completion;
      const o = r.onTime;
      const measured = o.state === 'measured' ? o : null;
      rows.push([
        'Project', r.name, r.owningDepartment, STATUS_LABEL[r.status],
        r.stage ? (r.stage.substage ? `${r.stage.stage}: ${r.stage.substage}` : r.stage.stage) : '', r.stage?.days ?? '',
        c.state === 'measurable' ? c.done : '', c.state === 'measurable' ? c.total : '', c.cancelled, c.state === 'measurable' ? c.percent : 'Progress not yet measurable',
        measured?.due ?? '', measured?.done ?? '', measured?.late ?? '', measured?.percent ?? 'Nothing due yet',
        o.awaitingReview, plannedEndText(r.plannedEnd), r.overdue, r.blocked,
      ]);
    }
    return { columns, rows };
  }
  if (p.panel === 'problems') {
    const counts = (c: Record<(typeof PROBLEM_KEYS)[number], number>) => PROBLEM_KEYS.map((k) => c[k]);
    return {
      columns: ['Level', 'Name', 'Owning department', 'Projects', ...PROBLEM_KEYS.map((k) => PROBLEM_LABELS[k])],
      rows: [
        ['Organisation', 'All projects shown', '', p.data.projects.length, ...counts(p.data.organisation)],
        ...p.data.departments.map((r) => ['Department', r.name, '', r.projects, ...counts(r)]),
        ...p.data.projects.map((r) => ['Project', r.name, r.owningDepartment, '', ...counts(r)]),
      ],
    };
  }
  if (p.panel === 'system') {
    const d = p.data;
    return {
      columns: ['Area', 'Measure', 'Count'],
      rows: [
        ['Emails', 'Emails failed in the period', d.emails.failed],
        ['Emails', 'Emails uncertain in the period', d.emails.uncertain],
        ['Emails', 'Emails waiting to retry', d.emails.retryWaiting],
        ...Object.entries(d.ai.blockedByReason).map(([reason, n]) => ['AI', `Active projects whose analysis would be Blocked: ${reason}`, n]),
        ['AI', 'Connections in Key rejected', d.ai.keyRejected],
        ...Object.entries(d.jobs.failedByQueue).map(([queue, n]) => ['Jobs', `Jobs failed in the period: ${queue}`, n]),
        ['Jobs', 'Jobs waiting longer than 15 minutes', d.jobs.waitingOver15m],
        ['Security', 'Credential cases awaiting review', d.security.casesAwaitingReview],
        ['Security', 'Protected key installed', d.security.protectedKeyInstalled ? 'Yes' : 'No'],
      ],
    };
  }
  const d = p.data;
  return {
    columns: ['Week starting', ...TREND_KEYS.map((k) => TREND_LABELS[k])],
    rows: d.weeks.map((w, i) => [w, ...TREND_KEYS.map((k) => d.series[k][i])]),
  };
}
