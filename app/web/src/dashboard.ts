/**
 * Dashboard shapes and wording on the web (dashboards spec sections 3 to 5). The types mirror what the server sends
 * (app/src/dashboards/measures.ts, personal.service.ts, project-dashboard.service.ts, timeline.ts): the web cannot import
 * server code. The web never works out a figure; it only words and orders what the server gave.
 */
import type { FinanceSummary } from './finance.ts';
import { plural } from './format.ts';
import { HOME_SECTIONS, type HomeSection } from './prefs.ts';
import type { LineStatus } from './resources.ts';

export type Completion =
  | { state: 'measurable'; done: number; total: number; cancelled: number; percent: number }
  | { state: 'not_measurable'; cancelled: number };

export type OnTime =
  | { state: 'measured'; due: number; done: number; late: number; percent: number; awaitingReview: number }
  | { state: 'nothing_due'; awaitingReview: number };

export type PlannedEnd = { state: 'none' } | { state: 'ahead'; days: number } | { state: 'ended'; daysAgo: number };

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface ProjectMeasures {
  projectId: string;
  completion: Completion;
  onTime: OnTime;
  overdue: number;
  blocked: number;
  dueSoon: number;
  stage: { stage: string; substage: string | null; days: number } | null;
  plannedEnd: PlannedEnd;
  questions: { open: number; answered: number };
  risks: { bySeverity: Record<Severity, number>; significant: number; overdueReviews: number };
  flags: { missingRole: boolean; noIndependentEscalation: boolean; deadlineReview: boolean; escalationsOpen: number };
  pendingInvitations: number;
  nextTaskDue: string | null;
  nextRiskReview: string | null;
}

export interface ProjectDashboard {
  measures: ProjectMeasures;
  invitations: { count: number; names?: string[] };
  decisions: { active: number; recent: { id: string; title: string; at: string }[] };
  questions: { oldestOpen: { id: string; text: string; at: string }[] };
  risks: { significant: { id: string; description: string; severity: string; reviewOn: string | null }[] };
  resources: { byStatus: Record<LineStatus, number>; neededByPassed: number; overlapping: number };
  /** Figures only for financial-detail readers; the tracking value alone for anyone else. */
  finance: FinanceSummary;
  /** Proposals waiting for review that this viewer may read (the Proposals tab's badge). */
  proposals: { waiting: number };
  computedAt: string;
  coverage: string;
}

export interface NeedsYouItem {
  kind: 'approval' | 'minutes' | 'question' | 'copies' | 'deadline_review' | 'resources' | 'overdue' | 'blocked' | 'due_soon' | 'risk_review';
  projectId: string;
  projectName: string;
  label: string;
  since: string | null;
  link: string;
  count?: number;
}

export interface MyTask {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  dueOn: string;
  status: string;
  overdueDays?: number;
}

export interface PersonalProject {
  id: string;
  name: string;
  onHold: boolean;
  archived?: boolean;
  header?: {
    status: string;
    stage: ProjectMeasures['stage'];
    completion: Completion;
    flags: { overdue: number; blocked: number; missingRole: boolean; noIndependentEscalation: boolean; deadlineReview: boolean };
  };
  expanded?: {
    roles: string[];
    grant: string | null;
    owningDepartment: string;
    onTime: OnTime;
    plannedEnd: PlannedEnd;
    openQuestions: number;
    significantRisks: number;
    nextTaskDue: string | null;
    link: string;
  };
}

export interface PersonalDashboard {
  needsYou: NeedsYouItem[];
  myTasks: { overdue: MyTask[]; dueSoon: MyTask[]; later: MyTask[]; awaitingReview: MyTask[]; completed?: MyTask[] };
  projects: PersonalProject[];
  computedAt: string;
}

export type TimelineLineKind = 'stage' | 'status' | 'archive' | 'tasks_due' | 'risk_review' | 'resource_needed_by' | 'planned_end';
export interface TimelineLine {
  day: string;
  kind: TimelineLineKind;
  label: string;
  detail?: unknown;
}
export interface ProjectTimeline {
  range: { from: string; to: string };
  today: string;
  months: { month: string; lines: TimelineLine[] }[];
  /** Every stage period overlapping the window, for the bars (D132). */
  stagePeriods: { stage: string; substage: string | null; startedOn: string; endedOn: string | null; stopped: 'deferred' | 'closed' | null }[];
  computedAt: string;
}

export const TIMELINE_KIND_LABELS: Record<TimelineLineKind, string> = {
  stage: 'Stages',
  status: 'Status changes',
  archive: 'Archive and unarchive',
  tasks_due: 'Task due dates',
  risk_review: 'Risk reviews',
  resource_needed_by: 'Resources needed by',
  planned_end: 'Planned end',
};

/** "62% task completion (31 of 50 tasks)", or "Progress not yet measurable" when no task counts. */
export function completionLabel(c: Completion): string {
  if (c.state === 'not_measurable') return 'Progress not yet measurable';
  return `${c.percent}% task completion (${c.done} of ${plural(c.total, 'task')})`;
}

/** "4 cancelled", shown apart from the completion line; null when none are cancelled. */
export function cancelledLabel(c: Completion): string | null {
  return c.cancelled > 0 ? `${c.cancelled} cancelled` : null;
}

/** "32 of 40 tasks due so far are done (80%)", or "Nothing due yet". */
export function onTimeLabel(o: OnTime): string {
  if (o.state === 'nothing_due') return 'Nothing due yet';
  return `${o.done} of ${o.due} tasks due so far are done (${o.percent}%)`;
}

/** "Awaiting deadline review: n", beside the on-time figure when n is above 0. */
export function awaitingLabel(o: OnTime): string | null {
  return o.awaitingReview > 0 ? `Awaiting deadline review: ${o.awaitingReview}` : null;
}

export function lateLabel(o: OnTime): string | null {
  return o.state === 'measured' ? `${o.late} late` : null;
}

export function plannedEndLabel(p: PlannedEnd): string {
  if (p.state === 'none') return 'No planned end date';
  if (p.state === 'ended') return `Ended ${plural(p.daysAgo, 'day')} ago`;
  return p.days === 0 ? 'Ends today' : `Ends in ${plural(p.days, 'day')}`;
}

/** "Updated 10:42 UTC+8" for an instant. */
export function updatedLabel(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `Updated ${d.toISOString().slice(11, 16)} UTC+8`;
}

export function overdueDaysLabel(n: number): string {
  return `overdue ${plural(n, 'day')}`;
}

/** The query for `GET /dashboard/me`: the saved toggles once preferences are loaded, otherwise the defaults. */
export function homeQuery(home: { includeArchived: boolean; showCompleted: boolean }, ready: boolean): string {
  const on = (v: boolean) => (ready && v ? 1 : 0);
  return `includeArchived=${on(home.includeArchived)}&showCompleted=${on(home.showCompleted)}`;
}

/** The sections to draw, in saved order. "Needs you" is first and is never hidden. */
export function visibleHomeSections(order: readonly HomeSection[], hidden: readonly HomeSection[]): HomeSection[] {
  const rest = HOME_SECTIONS.filter((s) => s !== 'needsYou');
  const ordered = [...order.filter((s) => s !== 'needsYou' && rest.includes(s)), ...rest.filter((s) => !order.includes(s))];
  return ['needsYou', ...ordered.filter((s) => !hidden.includes(s))];
}

/** Expanded flags with every shown project set to `open`; choices for projects not shown are kept. */
export function expandAllPatch(saved: Record<string, boolean>, shownIds: readonly string[], open: boolean): Record<string, boolean> {
  const out = { ...saved };
  for (const id of shownIds) out[id] = open;
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-11" as "November 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "20 Nov 2026" for a day written YYYY-MM-DD (days are already UTC+8). */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${SHORT_MONTHS[m - 1]} ${y}`;
}

export type TimelineItem = { today: false; line: TimelineLine } | { today: true };

/** Month groups with a "Today" marker placed by date: after lines on or before today, before later ones. */
export function withTodayMarker(months: { month: string; lines: TimelineLine[] }[], today: string): { month: string; items: TimelineItem[] }[] {
  const out: { month: string; items: TimelineItem[] }[] = months.map((m) => ({ month: m.month, items: m.lines.map((line) => ({ today: false as const, line })) }));
  const month = today.slice(0, 7);
  let group = out.find((g) => g.month === month);
  if (!group) {
    group = { month, items: [] };
    out.push(group);
    out.sort((a, b) => (a.month < b.month ? -1 : 1));
  }
  const at = group.items.findIndex((i) => !i.today && i.line.day > today);
  group.items.splice(at < 0 ? group.items.length : at, 0, { today: true });
  return out;
}

/** A bar's width in percent of its maximum; null (nothing drawn) when the value is missing. */
export function barWidth(value: number | null, max: number): number | null {
  if (value === null || Number.isNaN(value)) return null;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (value * 100) / max));
}
