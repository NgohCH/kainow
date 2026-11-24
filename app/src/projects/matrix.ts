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
  | 'project.stages'
  | 'note.import'
  | 'extraction.run'
  | 'proposal.edit'
  | 'meeting_date.set'
  | 'proposal.review'
  | 'project.archive'
  | 'proposal.submit'
  | 'audience.change'
  | 'discussion.post'
  | 'analysis.request'
  | 'notes.submit'
  | 'meeting.restricted'
  | 'minutes.publish'
  | 'message.moderate'
  | 'message.restore'
  | 'feedback.review'
  | 'assist.ask'
  | 'assist.share'
  | 'assist.review'
  | 'report.request'
  | 'report.manage'
  | 'summary.request'
  | 'summary.approve'
  | 'summary.review'
  | 'source.delete'
  | 'source.restore'
  | 'record.delete'
  | 'record.restore'
  | 'record.delegate_deletion'
  | 'secret.report'
  | 'quarantine.release'
  | 'quarantine.copies'
  | 'ai.limits.manage'
  | 'ai.connections.manage'
  | 'outputs.settings'
  | 'ai.connections.view'
  | 'ai.usage.view'
  | 'output.submit'
  | 'output.manage'
  | 'output.approve_request'
  | 'output.audience'
  | 'output.delete'
  | 'output.restore'
  | 'resource.view'
  | 'resource.edit'
  | 'finance.record'
  | 'finance.propose'
  | 'finance.settings';

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
  // The project's own list of stages (D131): a delegated setting like the output and finance settings.
  'project.stages': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: "Only the Project Manager, the Owner or a Sponsor can change the project's stages, and not while the project is Deferred or Closed.",
  },
  'note.import': { roles: ['pm', 'deputy_pm', 'owner', 'sponsor'], states: OPEN, refusal: IMPORT },
  'extraction.run': { roles: ['pm', 'deputy_pm', 'owner', 'sponsor'], states: OPEN, refusal: IMPORT },
  'proposal.edit': { roles: ['pm', 'owner', 'sponsor'], states: OPEN, refusal: EDIT_PROPOSALS },
  'meeting_date.set': { roles: ['pm', 'owner', 'sponsor'], states: OPEN, refusal: EDIT_PROPOSALS },
  'proposal.submit': {
    roles: ['participant'],
    states: OPEN,
    refusal: 'Only people in the project can propose, and not while it is Deferred or Closed.',
  },
  'project.archive': {
    roles: ['pm', 'owner', 'sponsor'],
    states: ['closed'],
    refusal: 'Only the Project Manager, the Owner or a Sponsor can archive a project, and only once it is Closed.',
  },
  'audience.change': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Project Manager, Owner or a Sponsor can change who may read this, and not while the project is Deferred or Closed.',
  },
  'discussion.post': {
    roles: ['participant'],
    states: OPEN,
    refusal: 'Only people in the project can post, and not while the project is Deferred or Closed.',
  },
  'analysis.request': {
    roles: ['participant'],
    states: OPEN,
    refusal: 'Only people in the project can ask for analysis, and not while the project is Deferred or Closed.',
  },
  'notes.submit': {
    roles: ['participant'],
    states: OPEN,
    refusal: 'Only people in the project can submit notes, and not while the project is Deferred or Closed.',
  },
  'meeting.restricted': {
    roles: ['pm', 'deputy_pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Project Manager, a Deputy, the Owner or a Sponsor can start a Restricted meeting, and not while the project is Deferred or Closed.',
  },
  'minutes.publish': {
    roles: ['pm', 'deputy_pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Project Manager, a Deputy, the Owner or a Sponsor can publish minutes, and not while the project is Deferred or Closed.',
  },
  'message.moderate': {
    roles: ['pm', 'deputy_pm'],
    states: OPEN,
    refusal: 'Only the Project Manager or a Deputy can hide or delete messages written by others, and not while the project is Deferred or Closed.',
  },
  'message.restore': {
    roles: ['pm', 'deputy_pm'],
    states: ALL,
    refusal: 'Only the Project Manager or a Deputy can restore a message.',
  },
  'feedback.review': {
    roles: ['pm', 'deputy_pm'],
    states: ALL,
    refusal: 'Only the Project Manager or a Deputy can review feedback on AI output.',
  },
  'assist.ask': {
    roles: ['participant'],
    states: OPEN,
    refusal: 'Only people in the project can ask the AI, and not while the project is Deferred or Closed.',
  },
  'assist.share': {
    roles: ['participant'],
    states: OPEN,
    refusal: 'Only people in the project can share an AI answer, and not while the project is Deferred or Closed.',
  },
  'assist.review': {
    roles: ['pm', 'deputy_pm'],
    states: ALL,
    refusal: 'Only the Project Manager or a Deputy can hide, clear or withdraw AI output.',
  },
  'report.request': {
    roles: ['participant'],
    states: OPEN,
    refusal: 'Only people in the project can request a draft report, and not while the project is Deferred or Closed.',
  },
  'report.manage': {
    roles: ['pm', 'deputy_pm'],
    states: OPEN,
    refusal: "Only the Project Manager or a Deputy can edit or share someone else's draft report, and not while the project is Deferred or Closed.",
  },
  'summary.request': {
    roles: ['pm', 'deputy_pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Project Manager, a Deputy, the Owner or a Sponsor can request or edit a shareable summary, and not while the project is Deferred or Closed.',
  },
  'summary.approve': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Project Manager, the Owner or a Sponsor can approve a summary, and not while the project is Deferred or Closed.',
  },
  'summary.review': {
    roles: ['pm', 'owner', 'sponsor'],
    states: ALL,
    refusal: 'Only the Project Manager, the Owner or a Sponsor can confirm or withdraw a summary in review.',
  },
  // Deleting is open while the project is open; restoring, reporting and release are protective, so open in every state (Q04).
  'source.delete': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Project Manager, the Owner or a Sponsor can delete a source, and not while the project is Deferred or Closed.',
  },
  'source.restore': {
    roles: ['pm', 'owner', 'sponsor'],
    states: ALL,
    refusal: 'Only the Project Manager, the Owner or a Sponsor can restore a source.',
  },
  // The Project Manager deletes and restores records only under a delegation (D83), which the records service checks.
  'record.delete': {
    roles: ['owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Owner or a Sponsor, or the Project Manager they delegated it to, can delete a record, and not while the project is Deferred or Closed.',
  },
  'record.restore': {
    roles: ['owner', 'sponsor'],
    states: ALL,
    refusal: 'Only the Owner or a Sponsor, or the Project Manager they delegated it to, can restore a record.',
  },
  'record.delegate_deletion': {
    roles: ['owner', 'sponsor'],
    states: ALL,
    refusal: 'Only the Owner or a Sponsor can delegate record deletion to the Project Manager or end it.',
  },
  'secret.report': {
    roles: ['participant'],
    states: ALL,
    refusal: 'Only people who can read this can report a suspected secret.',
  },
  'quarantine.release': {
    roles: ['pm', 'owner', 'sponsor'],
    states: ALL,
    refusal: 'Only the Project Manager, the Owner or a Sponsor can review and release an item held for a suspected credential.',
  },
  'quarantine.copies': {
    roles: ['pm', 'deputy_pm'],
    states: ALL,
    refusal: 'Only the Project Manager or a Deputy can confirm or dismiss possible copies of a suspected credential.',
  },
  'ai.limits.manage': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: "Only the Project Manager, the Owner or a Sponsor can change the project's AI limits, and only when the Administrator allows it.",
  },
  'ai.connections.manage': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: "Only the Project Manager, the Owner or a Sponsor can manage the project's AI connections, and only when the Administrator allows it.",
  },
  'outputs.settings': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: "Only the Project Manager, the Owner or a Sponsor can change the project's output settings, and not while the project is Deferred or Closed.",
  },
  'ai.connections.view': {
    roles: ['pm', 'deputy_pm', 'owner', 'sponsor'],
    states: ALL,
    refusal: "Only the Project Manager, a Deputy, the Owner or a Sponsor can see the project's AI connections and limits.",
  },
  // Not the Deputy (they see connections and limits, not who spent what), and not the Administrator standing alone.
  'ai.usage.view': {
    roles: ['pm', 'owner', 'sponsor'],
    states: ALL,
    refusal: "Only the Project Manager, the Owner or a Sponsor can see the project's AI usage.",
  },
  // Sub-project 8 (spec 9). Reading financial detail is not a row: it depends on the project's settings (finance/readers.ts).
  'resource.view': {
    roles: ['participant'],
    states: ALL,
    refusal: 'Only people in the project can see its resources.',
  },
  'resource.edit': {
    roles: ['pm', 'deputy_pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Project Manager, a Deputy, the Owner or a Sponsor can change resource lines, and not while the project is Deferred or Closed.',
  },
  'finance.record': {
    roles: ['pm', 'deputy_pm'],
    states: OPEN,
    refusal: 'Only the Project Manager or a Deputy can record spending, and not while the project is Deferred or Closed.',
  },
  // The finance service narrows adjustments to the Project Manager and Deputies; the budget is open to all four.
  'finance.propose': {
    roles: ['pm', 'deputy_pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: 'Only the Project Manager, a Deputy, the Owner or a Sponsor can propose a budget or a finance change, and not while the project is Deferred or Closed.',
  },
  // Delegated by the Administrator (D94), who may always change them: both checked in FinanceSettingsService.
  'finance.settings': {
    roles: ['pm', 'owner', 'sponsor'],
    states: OPEN,
    refusal: "Only the Project Manager, the Owner or a Sponsor can change the project's finance settings, and not while the project is Deferred or Closed.",
  },
  'proposal.review': {
    roles: ['owner', 'sponsor'],
    states: ['planned', 'active'],
    refusal: 'Only the Owner or a Sponsor can approve or reject proposals, and only while the project is Planned or Active.',
  },
  'output.submit': {
    roles: ['pm', 'deputy_pm', 'owner', 'sponsor', 'member'],
    states: OPEN,
    refusal: 'Only people in the project can submit an output, and not while the project is Deferred or Closed.',
  },
  'output.manage': {
    roles: ['pm', 'deputy_pm'],
    states: OPEN,
    refusal: 'Only the Project Manager or a Deputy can register, decline or change outputs, and not while the project is Deferred or Closed.',
  },
  'output.approve_request': {
    roles: ['pm', 'deputy_pm'],
    states: ['planned', 'active'],
    refusal: 'Only the Project Manager or a Deputy can ask for an output to be approved, and only while the project is Planned or Active.',
  },
  'output.audience': {
    roles: ['pm', 'owner', 'sponsor'],
    states: ALL,
    refusal: 'Only the Project Manager, the Owner or a Sponsor can change who may read an output.',
  },
  // Deleting a register entry follows sub-project 5: open projects only; restoring is protective, so in every state.
  'output.delete': {
    roles: ['pm', 'deputy_pm'],
    states: OPEN,
    refusal: 'Only the Project Manager or a Deputy can delete an output, and not while the project is Deferred or Closed.',
  },
  'output.restore': {
    roles: ['pm', 'deputy_pm'],
    states: ALL,
    refusal: 'Only the Project Manager or a Deputy can restore an output.',
  },
};

/**
 * What an Active Audit or Oversight grant allows: reading only, plus asking the AI a private question within the
 * grant's scope (AI assist spec 5.1; an answer to a grant holder is never shared) and reporting a suspected secret in
 * what they can read (history spec 6), and the project's resource lines (resources spec 9). The project state still applies.
 */
export const GRANT_ACTIONS: readonly ProjectAction[] = ['project.view', 'note.view', 'assist.ask', 'secret.report', 'resource.view'];
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
