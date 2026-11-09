/**
 * Change requests (sub-project 2b): types and the plain-words helpers the request panel uses. The server decides
 * who may approve, revise or withdraw (`mayApprove`, `mayRevise`, `mayWithdraw`, `why`); nothing here re-derives that.
 */

export type ChangeKind =
  | 'authorise_proposal'
  | 'amend_task'
  | 'cancel_task'
  | 'supersede_decision'
  | 'withdraw_decision'
  | 'deadline_review'
  | 'reconcile_completion'
  | 'risk_handover';

export interface RequestView {
  id: string;
  kind: ChangeKind;
  target: { kind: string; id: string };
  version: number;
  status: 'pending' | 'authorised' | 'rejected' | 'withdrawn' | string;
  requiredApprovals: number;
  approvals: Array<{ name: string; at: string }>;
  terms: Record<string, unknown>;
  currentTerms?: Record<string, unknown>;
  reason: string | null;
  outcomeReason: string | null;
  submittedBy: string;
  submittedAt: string;
  offer?: { fromProject: { id: string; name: string }; risk: { id: string; description: string; severity: string } };
  mayApprove: boolean;
  mayRevise: boolean;
  mayWithdraw: boolean;
  why: string | null;
  batchId: string | null;
}

const LABELS: Record<ChangeKind, string> = {
  authorise_proposal: 'Authorise a proposal',
  amend_task: 'Change a task',
  cancel_task: 'Cancel a task',
  supersede_decision: 'Replace a decision',
  withdraw_decision: 'Withdraw a decision',
  deadline_review: 'Review a deadline',
  reconcile_completion: 'Confirm work finished during a pause',
  risk_handover: 'Take over a risk',
};

export const kindLabel = (kind: ChangeKind): string => LABELS[kind] ?? kind;

/** "Approvals 1 of 2: Ann" (no names yet: "Approvals 0 of 2"). */
export function approvalsLine(view: { requiredApprovals: number; approvals: Array<{ name: string }> }): string {
  const have = view.approvals.length;
  const names = view.approvals.map((a) => a.name).join(', ');
  return `Approvals ${have} of ${view.requiredApprovals}${names ? `: ${names}` : ''}`;
}

export interface TermsRow {
  label: string;
  from: string;
  to: string;
}

/** What the viewer already knows of the target, to put beside the proposal. Every part is optional. */
export interface CurrentView {
  title?: string;
  assigneeId?: string;
  dueOn?: string;
  statement?: string;
  /** User id → display name. */
  names?: Record<string, string>;
  /** Unfinished subtask id → title. */
  subtaskTitles?: Record<string, string>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const count = (n: number) => (n === 0 ? 'None' : `${n} ${n === 1 ? 'item' : 'items'}`);

/** Side-by-side rows for a request's terms. Rows with nothing to show are left out. */
export function termsRows(kind: ChangeKind, terms: Record<string, unknown>, current: CurrentView = {}): TermsRow[] {
  const rows: TermsRow[] = [];
  const nameOf = (id: string) => current.names?.[id] ?? 'Another person';
  const add = (label: string, from: string, to: string) => {
    if (to !== '') rows.push({ label, from, to });
  };
  const person = (t: Record<string, unknown>) => (str(t.inviteEmail) ? `${str(t.inviteEmail)} (invited)` : str(t.assigneeId) ? nameOf(str(t.assigneeId)) : '');
  switch (kind) {
    case 'amend_task': {
      const sub = obj(terms.addSubtask);
      if (terms.addSubtask !== undefined) {
        add('New subtask', '', str(sub.title));
        add('Assignee', '', person(sub));
        add('Due date', '', str(sub.dueOn));
        break;
      }
      add('Wording', current.title ?? '', str(terms.title));
      add('Assignee', current.assigneeId ? nameOf(current.assigneeId) : '', person(terms));
      add('Due date', current.dueOn ?? '', str(terms.dueOn));
      break;
    }
    case 'cancel_task': {
      add('Reason', '', str(terms.reason));
      for (const [id, choice] of Object.entries(obj(terms.subtasks))) {
        rows.push({ label: `Subtask: ${current.subtaskTitles?.[id] ?? 'Unfinished subtask'}`, from: 'Unfinished', to: choice === 'cancel' ? 'Cancel' : 'Keep' });
      }
      break;
    }
    case 'supersede_decision':
      add('Decision', current.statement ?? '', str(terms.statement));
      add('Rationale', '', str(terms.rationale));
      add('Reason', '', str(terms.reason));
      rows.push({ label: 'Work to review', from: '', to: count(Array.isArray(terms.affected) ? terms.affected.length : 0) });
      break;
    case 'withdraw_decision':
      add('Reason', '', str(terms.reason));
      rows.push({ label: 'Work to review', from: '', to: count(Array.isArray(terms.affected) ? terms.affected.length : 0) });
      break;
    case 'deadline_review':
      add('Due date', current.dueOn ?? '', str(terms.dueOn));
      break;
    case 'reconcile_completion':
      add('Finished on', '', str(terms.completedOn));
      add('How it was finished', '', str(terms.explanation));
      add('Evidence', '', str(terms.evidence));
      break;
    case 'risk_handover':
      if (str(terms.responsibleId)) add('Responsible person', '', nameOf(str(terms.responsibleId)));
      add('Review date', '', str(terms.reviewOn));
      break;
    case 'authorise_proposal':
      add('Assignee', '', person(terms));
      add('Due date', '', str(terms.dueOn));
      add('Severity', '', str(terms.severity));
      add('Rationale', '', str(terms.rationale));
      break;
  }
  return rows;
}

/** "Waiting for 1 more approval": what a request still needs. */
export function waitingLine(view: { requiredApprovals: number; approvals: unknown[] }): string {
  const n = Math.max(view.requiredApprovals - view.approvals.length, 1);
  return `Waiting for ${n} more ${n === 1 ? 'approval' : 'approvals'}`;
}

/** The day in Malaysia (UTC+8) as YYYY-MM-DD. */
export const todayUtc8 = (now: number = Date.now()): string => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);

/** A due date before today (UTC+8) is allowed, but the form warns that the task will be overdue at once. */
export const isPastDay = (day: string, now: number = Date.now()): boolean => day !== '' && day < todayUtc8(now);

export interface Readiness {
  ready: boolean;
  missing: Array<{ kind: string; id: string; why: string }>;
  deliveredAllowed?: boolean;
}

/** One line on whether Close may go ahead. */
export function closureSummary(readiness: Pick<Readiness, 'ready' | 'missing'>): string {
  const n = readiness.missing.length;
  if (readiness.ready && n === 0) return 'Ready to close.';
  return n === 1 ? '1 item still needs a disposition.' : `${n} items still need a disposition.`;
}
