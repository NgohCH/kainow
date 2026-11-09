/**
 * Display helpers for authorised records (sub-project 2a). The server decides every change and returns
 * `mayAct`; these only label states and help a reviewer turn written names and dues into choices.
 */

export type TaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type TaskAction = 'start' | 'block' | 'unblock' | 'complete' | 'reopen';
export type QuestionStatus = 'open' | 'answered' | 'resolved' | 'withdrawn';
export type QuestionAction = 'answer' | 'resolve' | 'reopen' | 'withdraw';
export type RiskStatus = 'open' | 'mitigating' | 'resolved' | 'accepted';
export type RiskAction = 'mitigate' | 'update' | 'accept' | 'resolve' | 'reopen';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const QUESTION_STATUS_LABEL: Record<QuestionStatus, string> = { open: 'Open', answered: 'Answered', resolved: 'Resolved', withdrawn: 'Withdrawn' };
export const RISK_STATUS_LABEL: Record<RiskStatus, string> = { open: 'Open', mitigating: 'Mitigating', resolved: 'Resolved', accepted: 'Accepted' };
export const DECISION_STATUS_LABEL: Record<string, string> = { active: 'Active', superseded: 'Superseded', withdrawn: 'Withdrawn' };
/** A proposal's review state, as the review screen words it. */
export const REVIEW_STATUS_LABEL = { pending: 'Not reviewed', approved: 'Approved', rejected: 'Rejected' } as const;
export const SEVERITY_LABEL: Record<Severity, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

export const TASK_ACTION_LABEL: Record<TaskAction, string> = { start: 'Start', block: 'Block', unblock: 'Unblock', complete: 'Complete', reopen: 'Reopen' };
/** What each task change asks for (start asks for nothing). */
export const TASK_ACTION_PROMPT: Record<TaskAction, string | null> = {
  start: null,
  block: 'Why is it blocked?',
  unblock: 'How was it resolved?',
  complete: 'Completion note',
  reopen: 'Why reopen it?',
};

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'puan', 'encik', 'en', 'pn', 'madam', 'sir', 'dato', 'datin', 'tan', 'sri']);

/** The written name without titles, lower case: "Ms Su Ling" → "su ling". */
function cleanName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.()]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !TITLES.has(w))
    .join(' ');
}

/**
 * The one project person a written name most likely means: someone whose display name or email contains the
 * name's first word. Null when nobody or more than one person matches, so the reviewer chooses.
 */
export function likelyAssignee(name: string | null, people: Array<{ userId: string; displayName: string; email: string }>): string | null {
  if (!name) return null;
  const first = cleanName(name).split(' ')[0];
  if (!first) return null;
  const matches = people.filter((p) => p.displayName.toLowerCase().split(/\s+/).includes(first) || p.email.toLowerCase().split('@')[0].includes(first));
  const unique = [...new Set(matches.map((p) => p.userId))];
  return unique.length === 1 ? unique[0] : null;
}

/** "A and B; C for coordination" → ["A", "B", "C for coordination"]; notes in brackets are dropped. */
export function splitNames(owner: string | null): string[] {
  if (!owner) return [];
  return owner
    .replace(/\([^)]*\)/g, ' ')
    .split(/,|;|&|\band\b/i)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
}

/** The due date to pre-fill: the day, or the last day of a range; an event or a missing date needs the reviewer. */
export function defaultDueOn(due: { state: string; earliest: string | null; latest: string | null }): string | null {
  if (due.state === 'exact' || due.state === 'range') return due.latest ?? due.earliest;
  return null;
}

export type TaskHistoryEntry = { kind: string; from: string | null; to: string; note: string | null; overrideReason: string | null; actor: string; at: string };

const HISTORY_VERB: Record<string, string> = {
  authorised: 'Authorised',
  started: 'Started',
  blocked: 'Blocked',
  unblocked: 'Unblocked',
  completed: 'Completed',
  reopened: 'Reopened',
};

/** One line of a task's history: what happened, who did it, when (Malaysia time) and why. */
export function historyLine(h: TaskHistoryEntry): string {
  const day = new Date(h.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
  const why = h.note ? `: ${h.note}` : '';
  const override = h.overrideReason ? ` (override: ${h.overrideReason})` : '';
  return `${HISTORY_VERB[h.kind] ?? h.kind} by ${h.actor}, ${day}${why}${override}`;
}
