// Plain-language lines for in-app notifications and notice emails (spec §6). Pure: no database, no clock.
// A notice names the record and its date and links to it; notes, rationale, mitigation and evidence never appear.
import type { RouteKind } from './recipients';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_LISTED = 10;

/** 'YYYY-MM-DD' as 'Ddd D Mmm', e.g. 'Mon 17 Nov'. */
export function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The whole content of the minimal Administrator fallback (spec §5). */
export const ADMIN_FALLBACK = (projectName: string): string => `A task in ${projectName} needs reassignment.`;

export interface SummaryFacts {
  title?: string;
  dueOn?: string;
  parentDueOn?: string;
  description?: string;
  reviewOn?: string;
}

/** The in-app summary of one fired trigger (the resumption summary has its own function). */
export function triggerSummary(kind: Exclude<RouteKind, 'resumption'>, f: SummaryFacts): string {
  const title = f.title ?? '';
  const due = f.dueOn ? shortDate(f.dueOn) : '';
  switch (kind) {
    case 'reminder':
      return `Reminder: '${title}' is due on ${due}`;
    case 'overdue':
      return `Overdue: '${title}' was due on ${due}`;
    case 'past_due_set':
      return `Due date set in the past: '${title}' was due on ${due}`;
    case 'parent_deadline':
      return `Subtask '${title}' is unfinished past its parent's deadline (${f.parentDueOn ? shortDate(f.parentDueOn) : ''})`;
    case 'assignee_unavailable':
      return `Task '${title}' needs a new assignee`;
    case 'risk_review_due':
      return `Risk review due: '${f.description ?? ''}' on ${f.reviewOn ? shortDate(f.reviewOn) : ''}`;
    case 'risk_review_missed':
      return `Risk review missed: '${f.description ?? ''}' was due for review on ${f.reviewOn ? shortDate(f.reviewOn) : ''}`;
  }
}

export interface ResumptionFacts {
  reviewRequired: string[];
  overdue: { title: string; dueOn: string }[];
  risksPassed: { description: string; reviewOn: string }[];
}

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown}, and ${items.length - MAX_LISTED} more` : shown;
}

/** One summary of what to check after a Deferred or Closed project returns to Active. */
export function resumptionSummary(projectName: string, f: ResumptionFacts): string {
  const parts: string[] = [];
  if (f.reviewRequired.length > 0) parts.push(`Deadline review required: ${listed(f.reviewRequired.map((t) => `'${t}'`))}.`);
  if (f.overdue.length > 0) parts.push(`Overdue: ${listed(f.overdue.map((t) => `'${t.title}' (due ${shortDate(t.dueOn)})`))}.`);
  if (f.risksPassed.length > 0) {
    parts.push(`Risk review date passed: ${listed(f.risksPassed.map((r) => `'${r.description}' (${shortDate(r.reviewOn)})`))}.`);
  }
  return `${projectName}: work to check after resuming. ${parts.length > 0 ? parts.join(' ') : 'Nothing is outstanding.'}`;
}

/** The in-app link: the record in the project's work view, or the work view itself for a project-level notice. */
export function linkFor(projectId: string, recordKind: string, recordId: string): string {
  return recordKind === 'project' ? `#/projects/${projectId}/work` : `#/projects/${projectId}/work/${recordId}`;
}

/** One line of a notice email: the summary and the full link (none for the minimal fallback). */
export function emailLine(summary: string, appUrl: string, link: string | null): string {
  if (!link) return summary;
  return `${summary} — ${appUrl.replace(/\/+$/, '')}/${link}`;
}
