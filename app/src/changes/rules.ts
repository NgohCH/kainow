import type { ProjectStatus } from '../projects/matrix';

export type ChangeKind =
  | 'authorise_proposal'
  | 'amend_task'
  | 'cancel_task'
  | 'supersede_decision'
  | 'withdraw_decision'
  | 'deadline_review'
  | 'reconcile_completion'
  | 'risk_handover';

export function effectiveCount(
  org: { required: number; projectsMayOverride: boolean },
  project: { requiredApprovals: number | null },
): number {
  if (org.projectsMayOverride && project.requiredApprovals !== null) return project.requiredApprovals;
  return org.required;
}

export function approvalOutcome(input: { required: number; approverIds: string[]; eligibleIds: string[] }): {
  state: 'pending' | 'authorised';
  have: number;
  need: number;
  enough: boolean;
} {
  const eligible = new Set(input.eligibleIds);
  const have = new Set(input.approverIds.filter((id) => eligible.has(id))).size;
  return {
    state: have >= input.required ? 'authorised' : 'pending',
    have,
    need: input.required,
    enough: eligible.size >= input.required,
  };
}

export function kindAllowedIn(
  kind: ChangeKind,
  projectStatus: ProjectStatus,
  phase: 'submit' | 'approve',
  opts: { closureBatch?: boolean } = {},
): boolean {
  switch (kind) {
    case 'authorise_proposal':
      return projectStatus === 'planned' || projectStatus === 'active';
    case 'amend_task':
    case 'supersede_decision':
    case 'withdraw_decision':
      return projectStatus === 'active';
    case 'cancel_task':
      return projectStatus === 'active' || (!!opts.closureBatch && projectStatus === 'deferred');
    case 'deadline_review':
    case 'reconcile_completion':
      return projectStatus === 'deferred' || projectStatus === 'closed' || projectStatus === 'active';
    case 'risk_handover':
      return phase === 'submit'
        ? projectStatus === 'active' || projectStatus === 'deferred'
        : projectStatus === 'active';
  }
}

type Item = { kind: string; id: string; why: string };

export function closureReadiness(input: {
  tasks: Array<{ id: string; status: string }>;
  questions: Array<{ id: string; status: string }>;
  risks: Array<{ id: string; status: string; reviewOn: string | null }>;
  dispositions: Array<{ recordKind: string; recordId: string; disposition: string; affectsDelivery: boolean }>;
  pendingRequests: Array<{ kind: string; targetId: string; status: string }>;
}): { ready: boolean; missing: Item[]; deliveredAllowed: boolean } {
  const missing: Item[] = [];
  const find = (kind: string, id: string) =>
    input.dispositions.find((d) => d.recordKind === kind && d.recordId === id);

  const check = (kind: string, id: string, status: string) => {
    const d = find(kind, id);
    if (!d) {
      missing.push({ kind, id, why: 'No disposition yet' });
      return;
    }
    if (d.disposition === 'cancel' && kind === 'task' && status !== 'cancelled') {
      missing.push({ kind, id, why: 'Cancellation waiting for authorisation' });
    } else if (d.disposition === 'handover') {
      const done = input.pendingRequests.some(
        (r) => r.kind === 'risk_handover' && r.targetId === id && r.status === 'authorised',
      );
      if (!done) missing.push({ kind, id, why: 'Hand-over waiting for acceptance' });
    }
  };

  for (const t of input.tasks) {
    if (t.status === 'completed' || t.status === 'cancelled') continue;
    check('task', t.id, t.status);
  }
  for (const q of input.questions) {
    if (q.status === 'resolved' || q.status === 'withdrawn') continue;
    check('question', q.id, q.status);
  }
  for (const r of input.risks) {
    if (r.status === 'resolved') continue;
    if (r.status === 'accepted' && r.reviewOn === null) continue;
    check('risk', r.id, r.status);
  }

  const deliveredAllowed = !input.dispositions.some(
    (d) => d.disposition === 'keep' || (d.disposition === 'unresolved' && d.affectsDelivery),
  );
  return { ready: missing.length === 0, missing, deliveredAllowed };
}

export function checkReplacementDate(input: { previous: string; proposed: string; today: string }): string | null {
  if (input.proposed === input.previous) return 'Choose a date different from the previous due date.';
  if (input.proposed < input.today) return 'Choose a date that is not in the past.';
  return null;
}

export function checkReconciliation(input: {
  completedOn: string;
  today: string;
  pausedOn: string;
  explanation: string;
}): string | null {
  if (input.completedOn > input.today) return 'The completion date cannot be in the future.';
  if (input.completedOn < input.pausedOn) return 'The completion date cannot be before the pause began.';
  if (input.explanation.trim() === '') return 'Explain how the work was completed.';
  return null;
}
