/** Wording and ordering for Home, My tasks, Reviews and Projects (spec 7.1 to 7.4). Pure; the screens only draw it. */
import type { Completion, MyTask, NeedsYouItem, PersonalDashboard, PersonalProject } from '../dashboard.ts';
import type { ProjectStatus } from '../projects.ts';
import { groupAttention } from './attention.ts';

/** What to say when a part of Home has nothing in it; null when it has something. */
export function homeEmptyCopy(d: PersonalDashboard): { needsYou: string | null; projects: string | null } {
  return {
    needsYou: d.needsYou.length === 0 ? 'Nothing needs you.' : null,
    projects: 
      d.projects.length === 0
        ? 'You are not in any project yet. A Project Manager adds you when a project needs you.'
        : homeProjects(d.projects).current.length === 0
          ? 'None of your projects is current.'
          : null,
  };
}

/** Deferred and Closed projects are history; the others are current (D138). */
const isHistory = (status: string | undefined) => status === 'deferred' || status === 'closed';

/**
 * The Projects page's tables (spec 9): current, Deferred and Closed. Archived projects are in the group of their state,
 * only when included. With a state chosen, a group that cannot hold it is null: its table is not shown.
 */
export function groupProjects<P extends { status: ProjectStatus; archived: boolean }>(
  list: readonly P[],
  state: ProjectStatus | null,
  archived: boolean,
): { current: P[] | null; deferred: P[] | null; closed: P[] | null } {
  const shown = list.filter((p) => archived || !p.archived);
  const only = (s: 'deferred' | 'closed') => (state === null || state === s ? shown.filter((p) => p.status === s) : null);
  return {
    current: isHistory(state ?? undefined) ? null : shown.filter((p) => !isHistory(p.status) && (state === null || p.status === state)),
    deferred: only('deferred'),
    closed: only('closed'),
  };
}

/** Home's projects: the current ones, with those where the person's membership is on hold (no state is told), and the rest. */
export function homeProjects(list: readonly PersonalProject[]): { current: PersonalProject[]; history: PersonalProject[] } {
  return { current: list.filter((p) => !isHistory(p.header?.status)), history: list.filter((p) => isHistory(p.header?.status)) };
}

/** Home's link to History; with archived projects among them, the page opens with those included. */
export function historyLink(history: readonly PersonalProject[]): { href: string; text: string } | null {
  if (history.length === 0) return null;
  const archived = history.filter((p) => p.archived).length;
  return {
    href: `#/projects/history${archived > 0 ? '/archived' : ''}`,
    text: `${history.length} in History${archived > 0 ? ` (${archived} archived)` : ''}`,
  };
}

/** The address of the Projects page at its History, or null for another address. */
export function parseHistoryHash(hash: string): { archived: boolean } | null {
  const m = /^#\/projects\/history(\/archived)?$/.exec(hash);
  return m ? { archived: m[1] !== undefined } : null;
}

/** The Review and decisions items of Needs you: Reviews lists them and the menu badge counts them. */
export function reviewItems(needsYou: NeedsYouItem[]): NeedsYouItem[] {
  return groupAttention(needsYou).find((g) => g.group === 'review')?.items ?? [];
}

/** "Good morning, Mei", by the hour in UTC+8. */
export function greetingFor(name: string, now: Date): string {
  const h = new Date(now.getTime() + 8 * 3_600_000).getUTCHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = name.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Tuesday 24 November 2026" in UTC+8. */
export function todayLabel(now: Date): string {
  const t = new Date(now.getTime() + 8 * 3_600_000);
  return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/** "62% (31 of 50 tasks)" or "Not yet measurable". */
export function progressText(c: Completion): string {
  if (c.state === 'not_measurable') return 'Not yet measurable';
  return `${c.percent}% (${c.done} of ${c.total} ${c.total === 1 ? 'task' : 'tasks'})`;
}

/** The reasons a project needs attention, in words. */
export function attentionFlags(f: NonNullable<PersonalProject['header']>['flags'] | undefined): string[] {
  if (!f) return [];
  return [
    f.overdue > 0 ? `${f.overdue} overdue` : '',
    f.blocked > 0 ? `${f.blocked} blocked` : '',
    f.missingRole ? 'Missing a required role' : '',
    f.noIndependentEscalation ? 'No independent escalation recipient' : '',
    f.deadlineReview ? 'Deadline review required' : '',
  ].filter(Boolean);
}

export type TaskRow = MyTask & { group: 'overdue' | 'dueSoon' | 'later' | 'awaitingReview' | 'completed' };

/** Every task in one list: overdue first, then by due day. */
export function taskRows(t: PersonalDashboard['myTasks']): TaskRow[] {
  const tag = (list: MyTask[] | undefined, group: TaskRow['group']): TaskRow[] => (list ?? []).map((x) => ({ ...x, group }));
  const all = [...tag(t.overdue, 'overdue'), ...tag(t.dueSoon, 'dueSoon'), ...tag(t.later, 'later'), ...tag(t.awaitingReview, 'awaitingReview'), ...tag(t.completed, 'completed')];
  const rank = (r: TaskRow) => (r.group === 'overdue' ? 0 : 1);
  return all.sort((a, b) => rank(a) - rank(b) || a.dueOn.localeCompare(b.dueOn));
}

/** "In progress" for "in_progress". */
export function statusWord(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
