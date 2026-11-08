/**
 * The project permission matrix (V1.0 Permission Matrix, as agreed for sub-project 1). A role not listed
 * for an action has no authority for it. Holding the administrator role grants nothing here except where
 * ROLE_MANAGERS names the administrator; project lifecycle authority is in lifecycle.ts.
 */
import type { ProjectRole } from './membership';

export type ProjectStatus = 'draft' | 'planned' | 'active' | 'deferred' | 'closed';
export const PROJECT_STATUSES: readonly ProjectStatus[] = ['draft', 'planned', 'active', 'deferred', 'closed'];

export type ProjectAction =
  | 'project.view'
  | 'note.view'
  | 'project.edit'
  | 'project.stage'
  | 'note.import'
  | 'extraction.run'
  | 'proposal.edit'
  | 'meeting_date.set'
  | 'proposal.review'
  | 'project.archive';

interface MatrixRow {
  roles: ReadonlyArray<ProjectRole | 'participant'>;
  states: ReadonlyArray<ProjectStatus>;
  refusal: string;
}

const ALL: readonly ProjectStatus[] = PROJECT_STATUSES;
const OPEN: readonly ProjectStatus[] = ['draft', 'planned', 'active'];
const NOT_PARTICIPANT = 'You are not a participant in this project.';
const IMPORT = 'Only the Project Manager, a Deputy, the Owner or a Sponsor can add notes or run extraction, and not while the project is Deferred or Closed.';
const EDIT_PROPOSALS = 'Only the Project Manager, Owner or a Sponsor can edit proposals, and not while the project is Deferred or Closed.';

export const PROJECT_MATRIX: Readonly<Record<ProjectAction, MatrixRow>> = {
  'project.view': { roles: ['participant'], states: ALL, refusal: NOT_PARTICIPANT },
  'note.view': { roles: ['participant'], states: ALL, refusal: NOT_PARTICIPANT },
  'project.edit': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: "Only the Project Manager, Owner or a Sponsor can change the project's details, and not while it is Deferred or Closed.",
  },
  'project.stage': { roles: ['pm'], states: ['active'], refusal: 'Only the Project Manager can change the stage, and only while the project is Active.' },
  'note.import': { roles: ['pm', 'deputy_pm', 'owner', 'sponsor'], states: OPEN, refusal: IMPORT },
  'extraction.run': { roles: ['pm', 'deputy_pm', 'owner', 'sponsor'], states: OPEN, refusal: IMPORT },
  'proposal.edit': { roles: ['pm', 'owner', 'sponsor'], states: OPEN, refusal: EDIT_PROPOSALS },
  'meeting_date.set': { roles: ['pm', 'owner', 'sponsor'], states: OPEN, refusal: EDIT_PROPOSALS },
  'project.archive': {
    roles: ['pm', 'owner', 'sponsor'],
    states: ['closed'],
    refusal: 'Only the Project Manager, the Owner or a Sponsor can archive a project, and only once it is Closed.',
  },
  'proposal.review': {
    roles: ['owner', 'sponsor'],
    states: ['planned', 'active'],
    refusal: 'Only the Owner or a Sponsor can approve or reject proposals, and only while the project is Planned or Active.',
  },
};

/** What an Active Audit or Oversight grant allows: reading only. */
export const GRANT_ACTIONS: readonly ProjectAction[] = ['project.view', 'note.view'];
export const GRANT_READ_ONLY = 'Audit and Oversight access is read-only.';

export function decide(input: { action: ProjectAction; roles: ProjectRole[]; status: ProjectStatus }): { allowed: true } | { allowed: false; reason: string } {
  const row = PROJECT_MATRIX[input.action];
  const roleOk = row.roles.includes('participant') ? input.roles.length > 0 : input.roles.some((r) => row.roles.includes(r));
  return roleOk && row.states.includes(input.status) ? { allowed: true } : { allowed: false, reason: row.refusal };
}

/** Who may appoint, invite, extend, change the dates of or revoke each role. */
export const ROLE_MANAGERS: Readonly<Record<ProjectRole, ReadonlyArray<ProjectRole | 'administrator'>>> = {
  owner: ['administrator'],
  sponsor: ['administrator', 'owner'],
  pm: ['administrator', 'owner', 'sponsor'],
  deputy_pm: ['pm', 'owner', 'sponsor'],
  member: ['pm', 'owner', 'sponsor'],
};

export const ROLE_LABEL: Readonly<Record<ProjectRole, string>> = {
  pm: 'Project Manager',
  deputy_pm: 'Deputy Project Manager',
  owner: 'Owner',
  sponsor: 'Sponsor',
  member: 'Member',
};

const MANAGER_TEXT: Readonly<Record<ProjectRole, string>> = {
  owner: 'an Enterprise Administrator',
  sponsor: 'an Enterprise Administrator or the Owner',
  pm: 'an Enterprise Administrator, the Owner or a Sponsor',
  deputy_pm: 'the Project Manager, the Owner or a Sponsor',
  member: 'the Project Manager, the Owner or a Sponsor',
};

/**
 * Appointments (appoint, extend, change dates, revoke) stay open to the role's managers in every status, so a
 * required role that lapses while Deferred or Closed can be repaired before resuming (Consolidated Specification
 * §5, D21, Q05). Invitations are locked while Deferred or Closed (Product Summary §10).
 */
export function canManageRole(input: {
  target: ProjectRole;
  roles: ProjectRole[];
  isAdmin: boolean;
  status: ProjectStatus;
  via: 'appointment' | 'invitation';
}): { allowed: true } | { allowed: false; reason: string } {
  const managers = ROLE_MANAGERS[input.target];
  const holder = (input.isAdmin && managers.includes('administrator')) || input.roles.some((r) => managers.includes(r));
  if (input.via === 'appointment') {
    return holder ? { allowed: true } : { allowed: false, reason: `Only ${MANAGER_TEXT[input.target]} can manage the ${ROLE_LABEL[input.target]} role.` };
  }
  if (holder && OPEN.includes(input.status)) return { allowed: true };
  return {
    allowed: false,
    reason: `Only ${MANAGER_TEXT[input.target]} can invite for the ${ROLE_LABEL[input.target]} role, and not while the project is Deferred or Closed.`,
  };
}
