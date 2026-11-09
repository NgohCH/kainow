/**
 * Task lifecycle rules (V1.0 Task and Subtask Lifecycle §3, §5, §6). Pure functions: who may change a
 * task, from which status, and the indicators worked out on read. Days are 'YYYY-MM-DD' in UTC+8.
 */
import type { ProjectStatus } from '../projects/matrix';
import type { ProjectRole } from '../projects/membership';

export type TaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type TaskAction = 'start' | 'block' | 'unblock' | 'complete' | 'reopen';
export const TASK_ACTIONS: readonly TaskAction[] = ['start', 'block', 'unblock', 'complete', 'reopen'];

export const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const RULES: Readonly<Record<TaskAction, { from: readonly TaskStatus[]; to: TaskStatus; managersOnly: boolean }>> = {
  start: { from: ['not_started'], to: 'in_progress', managersOnly: false },
  block: { from: ['not_started', 'in_progress'], to: 'blocked', managersOnly: false },
  unblock: { from: ['blocked'], to: 'in_progress', managersOnly: false },
  complete: { from: ['not_started', 'in_progress', 'blocked'], to: 'completed', managersOnly: false },
  reopen: { from: ['completed'], to: 'in_progress', managersOnly: true },
};

const isManager = (roles: ProjectRole[]) => roles.includes('pm') || roles.includes('deputy_pm');
const refuse = (reason: string) => ({ allowed: false as const, reason });

/** Whether this person may make this change now, and the status it leads to. Every change needs a note except starting. */
export function taskTransition(input: {
  action: TaskAction;
  status: TaskStatus;
  actor: { isAssignee: boolean; roles: ProjectRole[] };
  projectStatus: ProjectStatus;
  assigneeActive: boolean;
  note: string | null;
}): { allowed: true; to: TaskStatus } | { allowed: false; reason: string } {
  const rule = RULES[input.action];
  const manager = isManager(input.actor.roles);
  if (input.projectStatus !== 'active') return refuse('Tasks change only while the project is Active.');
  if (rule.managersOnly && !manager) return refuse('Only the Project Manager or a Deputy can reopen a task.');
  if (!rule.managersOnly && !manager && !input.actor.isAssignee) return refuse('Only the assignee, the Project Manager or a Deputy can do this.');
  if (!rule.from.includes(input.status)) return refuse(`That change is not possible from ${STATUS_LABEL[input.status]}.`);
  // Starting needs the assignee Active, whoever starts it; completing needs it only when the assignee does it themself.
  if (!input.assigneeActive && (input.action === 'start' || (input.action === 'complete' && !manager))) {
    return refuse('The assignee must be an Active member to start this task.');
  }
  if (input.action !== 'start' && (input.note === null || input.note.trim() === '')) return refuse('A note is required.');
  return { allowed: true, to: rule.to };
}

/** A parent completes when every subtask is finished, or with a Project Manager's or Deputy's recorded override. */
export function parentMayComplete(
  children: TaskStatus[],
  overrideReason: string | null,
  actorRoles: ProjectRole[],
): { allowed: true; override: boolean } | { allowed: false; reason: string } {
  if (children.every((s) => s === 'completed' || s === 'cancelled')) return { allowed: true, override: false };
  if (overrideReason !== null && overrideReason.trim() !== '' && isManager(actorRoles)) return { allowed: true, override: true };
  return refuse('Finish the subtasks first, or record an override.');
}

/** The completed ancestors (parent first) that reopen with a reopened subtask, stopping at the first that is not completed. */
export function ancestorsToReopen(chain: Array<{ id: string; status: TaskStatus }>): string[] {
  const out: string[] = [];
  for (const a of chain) {
    if (a.status !== 'completed') break;
    out.push(a.id);
  }
  return out;
}

export function taskIndicators(input: {
  status: TaskStatus;
  dueOn: string;
  parentDueOn: string | null;
  assigneeActive: boolean;
  invitationStatus: 'invited' | 'declined' | 'expired' | 'revoked' | 'accepted' | 'replaced' | null;
  today: string;
  /** Marked when the project was deferred or closed: the task shows this instead of Overdue until it has a new authorised date. */
  deadlineReviewRequired?: boolean;
}): { overdue: boolean; awaitingMembership: boolean; invitation: string | null; dueAfterParent: boolean; deadlineReviewRequired: boolean } {
  const finished = input.status === 'completed' || input.status === 'cancelled';
  return {
    overdue: !finished && !input.deadlineReviewRequired && input.today > input.dueOn,
    deadlineReviewRequired: !finished && !!input.deadlineReviewRequired,
    awaitingMembership: !input.assigneeActive,
    invitation: input.assigneeActive ? null : input.invitationStatus,
    dueAfterParent: input.parentDueOn !== null && input.dueOn > input.parentDueOn,
  };
}
