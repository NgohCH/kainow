/**
 * Display helpers for projects. Which lifecycle buttons to offer mirrors the server's transition table
 * (app/src/projects/lifecycle.ts); the server still decides every change and explains any refusal.
 */

export type ProjectRole = 'pm' | 'deputy_pm' | 'owner' | 'sponsor' | 'member';
export type ProjectStatus = 'draft' | 'planned' | 'active' | 'deferred' | 'closed';
export type MembershipState = 'scheduled' | 'active' | 'expired' | 'revoked';
export type ClosureOutcome = 'delivered' | 'partially_delivered' | 'abandoned';

export const ROLES: readonly ProjectRole[] = ['pm', 'deputy_pm', 'owner', 'sponsor', 'member'];
export const STAGES: readonly string[] = ['Initiation', 'Planning', 'Execution', 'Review & Acceptance', 'Closure'];
export const SUBSTAGES: Readonly<Record<string, readonly string[]>> = {
  Initiation: ['Define Purpose', 'Identify Participants', 'Confirm Accountability'],
  Planning: ['Define Scope', 'Break Down Work', 'Identify Resources', 'Approve Plan'],
  Execution: ['In Progress', 'Monitoring & Follow-up'],
  'Review & Acceptance': ['Review Deliverables', 'Resolve Outstanding Items', 'Confirm Acceptance'],
  Closure: ['Record Outcome', 'Handover', 'Close Project'],
};

const ROLE_LABEL: Record<ProjectRole, string> = {
  pm: 'Project Manager',
  deputy_pm: 'Deputy Project Manager',
  owner: 'Owner',
  sponsor: 'Sponsor',
  member: 'Member',
};
export const roleLabel = (r: ProjectRole): string => ROLE_LABEL[r];

const STATE_LABEL: Record<MembershipState, string> = { scheduled: 'Starts later', active: 'Active', expired: 'Expired', revoked: 'Revoked' };
export const membershipStateLabel = (s: MembershipState): string => STATE_LABEL[s];

export const STATUS_LABEL: Record<ProjectStatus, string> = { draft: 'Draft', planned: 'Planned', active: 'Active', deferred: 'Deferred', closed: 'Closed' };
export const OUTCOME_LABEL: Record<ClosureOutcome, string> = { delivered: 'Delivered', partially_delivered: 'Partially Delivered', abandoned: 'Abandoned' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Expires 16 Nov 2026, 2:30 pm' in UTC+8. */
export function formatExpiry(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const h = t.getUTCHours();
  const m = String(t.getUTCMinutes()).padStart(2, '0');
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `Expires ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${hour12}:${m} ${h < 12 ? 'am' : 'pm'}`;
}

export interface TransitionOption {
  to: ProjectStatus;
  label: string;
  fastTrack: boolean;
  needs: { reason: boolean; outcome: boolean; stage: boolean };
  outcomes?: ClosureOutcome[];
}

type Who = ReadonlyArray<ProjectRole | 'administrator'>;
const PM_OS: Who = ['pm', 'owner', 'sponsor'];
const OS: Who = ['owner', 'sponsor'];
const ALL_OUTCOMES: ClosureOutcome[] = ['delivered', 'partially_delivered', 'abandoned'];

const TABLE: Array<{ from: ProjectStatus; who: Who } & TransitionOption> = [
  { from: 'draft', to: 'planned', who: PM_OS, label: 'Move to Planned', fastTrack: false, needs: { reason: false, outcome: false, stage: false } },
  { from: 'draft', to: 'active', who: ['pm'], label: 'Fast-track to Active', fastTrack: true, needs: { reason: true, outcome: false, stage: false } },
  { from: 'planned', to: 'active', who: PM_OS, label: 'Make Active', fastTrack: false, needs: { reason: false, outcome: false, stage: false } },
  { from: 'planned', to: 'closed', who: OS, label: 'Close as Abandoned', fastTrack: false, needs: { reason: true, outcome: true, stage: false }, outcomes: ['abandoned'] },
  { from: 'active', to: 'deferred', who: PM_OS, label: 'Defer', fastTrack: false, needs: { reason: true, outcome: false, stage: false } },
  { from: 'active', to: 'closed', who: OS, label: 'Close', fastTrack: false, needs: { reason: true, outcome: true, stage: false }, outcomes: ALL_OUTCOMES },
  { from: 'deferred', to: 'active', who: ['administrator', ...PM_OS], label: 'Resume', fastTrack: false, needs: { reason: true, outcome: false, stage: true } },
  { from: 'deferred', to: 'closed', who: OS, label: 'Close', fastTrack: false, needs: { reason: true, outcome: true, stage: false }, outcomes: ALL_OUTCOMES },
  { from: 'closed', to: 'active', who: OS, label: 'Reopen', fastTrack: false, needs: { reason: true, outcome: false, stage: true } },
];

/** The lifecycle changes this person may ask for from this status (role gates are checked by the server). */
export function transitionsFor(status: ProjectStatus, roles: ProjectRole[], isAdmin: boolean): TransitionOption[] {
  return TABLE.filter((t) => t.from === status && ((isAdmin && t.who.includes('administrator')) || roles.some((r) => t.who.includes(r)))).map(
    ({ from: _from, who: _who, ...option }) => option,
  );
}

/** Who may manage each role (the role-management matrix), for showing invite and change controls. */
const MANAGERS: Record<ProjectRole, ReadonlyArray<ProjectRole | 'administrator'>> = {
  owner: ['administrator'],
  sponsor: ['administrator', 'owner'],
  pm: ['administrator', 'owner', 'sponsor'],
  deputy_pm: ['pm', 'owner', 'sponsor'],
  member: ['pm', 'owner', 'sponsor'],
};

export function canManage(target: ProjectRole, roles: ProjectRole[], isAdmin: boolean, status: ProjectStatus): boolean {
  if (!['draft', 'planned', 'active'].includes(status)) return false;
  return (isAdmin && MANAGERS[target].includes('administrator')) || roles.some((r) => MANAGERS[target].includes(r));
}

/** Roles this person may invite or appoint. */
export function manageableRoles(roles: ProjectRole[], isAdmin: boolean, status: ProjectStatus): ProjectRole[] {
  return ROLES.filter((r) => canManage(r, roles, isAdmin, status));
}

/** How long the project has been in its current stage, in whole days (UTC+8 calendar days). */
export function stageDuration(startedAt: string, now: Date = new Date()): string {
  const day = (d: Date) => Math.floor((d.getTime() + 8 * 3600 * 1000) / 86_400_000);
  const days = day(now) - day(new Date(startedAt));
  return days <= 0 ? 'started today' : days === 1 ? '1 day in this stage' : `${days} days in this stage`;
}
