/**
 * The nine accepted project transitions (V1.0 Project Lifecycle Rules, section 3). Any other status
 * change is refused. Draft → Active is always the Project Manager's fast track.
 */
import { SEPARATION_REASON, type ProjectRole } from './membership';
import type { ProjectStatus } from './matrix';

export const STAGES: readonly string[] = ['Initiation', 'Planning', 'Execution', 'Review & Acceptance', 'Closure'];

export type ClosureOutcome = 'delivered' | 'partially_delivered' | 'abandoned';

export interface TransitionRequest {
  from: ProjectStatus;
  to: ProjectStatus;
  roles: ProjectRole[];
  isAdmin: boolean;
  reason: string | null;
  outcome: ClosureOutcome | null;
  stage: string | null;
  /** Required roles not yet accepted (Scheduled or Active), in plain words; empty when all are. */
  missingAccepted: string[];
  /** Required roles not Active today, in plain words; empty when all are. */
  missingActive: string[];
  separationOk: boolean;
  /** The Project Manager, while an Owner or Sponsor has let them close the project (spec §6.1). */
  delegatedPm?: boolean;
}

interface Rule {
  who: ReadonlyArray<ProjectRole | 'administrator'>;
  whoText: string;
  verb: string;
  reason: boolean;
  outcome: boolean;
  stage: boolean;
  gate: 'accepted' | 'active' | null;
}

const PM_OS = ['pm', 'owner', 'sponsor'] as const;
const OS = ['owner', 'sponsor'] as const;
const PM_OS_TEXT = 'the Project Manager, the Owner or a Sponsor';
const OS_TEXT = 'the Owner or a Sponsor';

export const TRANSITIONS: Readonly<Record<string, Rule>> = {
  'draft>planned': { who: PM_OS, whoText: PM_OS_TEXT, verb: 'move the project to Planned', reason: false, outcome: false, stage: false, gate: 'accepted' },
  'draft>active': { who: ['pm'], whoText: 'the Project Manager', verb: 'fast-track the project to Active', reason: true, outcome: false, stage: false, gate: 'active' },
  'planned>active': { who: PM_OS, whoText: PM_OS_TEXT, verb: 'make the project Active', reason: false, outcome: false, stage: false, gate: 'active' },
  'active>deferred': { who: PM_OS, whoText: PM_OS_TEXT, verb: 'defer the project', reason: true, outcome: false, stage: false, gate: null },
  'deferred>active': {
    who: ['administrator', ...PM_OS],
    whoText: 'an Enterprise Administrator, the Project Manager, the Owner or a Sponsor',
    verb: 'resume the project',
    reason: true,
    outcome: false,
    stage: true,
    gate: 'active',
  },
  'active>closed': { who: OS, whoText: OS_TEXT, verb: 'close the project', reason: true, outcome: true, stage: false, gate: null },
  'deferred>closed': { who: OS, whoText: OS_TEXT, verb: 'close the project', reason: true, outcome: true, stage: false, gate: null },
  'planned>closed': { who: OS, whoText: OS_TEXT, verb: 'close the project', reason: true, outcome: true, stage: false, gate: null },
  'closed>active': { who: OS, whoText: OS_TEXT, verb: 'reopen the project', reason: true, outcome: false, stage: true, gate: 'active' },
};

const refuse = (reason: string) => ({ allowed: false as const, reason });

export function checkTransition(r: TransitionRequest): { allowed: true } | { allowed: false; reason: string } {
  const rule = TRANSITIONS[`${r.from}>${r.to}`];
  if (!rule) return refuse('That status change is not allowed.');
  const delegated = r.to === 'closed' && !!r.delegatedPm && r.roles.includes('pm');
  const actor = (r.isAdmin && rule.who.includes('administrator')) || r.roles.some((role) => rule.who.includes(role)) || delegated;
  if (!actor) return refuse(`Only ${rule.whoText} can ${rule.verb}.`);
  if (rule.reason && (r.reason === null || r.reason.trim() === '')) return refuse('A reason is required.');
  if (rule.outcome && r.outcome === null) return refuse('Choose a closure outcome.');
  if (r.from === 'planned' && r.to === 'closed' && r.outcome !== 'abandoned') return refuse('A project closed from Planned can only be Abandoned.');
  if (rule.stage && (r.stage === null || !STAGES.includes(r.stage))) return refuse('Choose the stage to continue in.');
  if (rule.gate === 'accepted' && r.missingAccepted.length > 0) {
    return refuse(`The required roles are not all accepted yet. Still needed: ${r.missingAccepted.join(', ')}.`);
  }
  if (rule.gate === 'active' && r.missingActive.length > 0) {
    return refuse(`The required roles are not all active yet. Still needed: ${r.missingActive.join(', ')}.`);
  }
  if (rule.gate === 'active' && !r.separationOk) return refuse(SEPARATION_REASON);
  return { allowed: true };
}
