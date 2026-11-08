/**
 * Audit and Oversight grants (V1.0 Sign-in, Access Requests and Account Lifecycle §8; Configuration C03).
 * Pure functions. Days are 'YYYY-MM-DD' in UTC+8; a grant's end day is its last valid day.
 */
import { type MembershipRow, isHeld, membershipState } from './membership';

export type GrantKind = 'audit' | 'oversight';
export const GRANT_KINDS: readonly GrantKind[] = ['audit', 'oversight'];

export interface GrantRow {
  id: string;
  userId: string;
  kind: GrantKind;
  startsOn: string;
  expiresOn: string;
  requestedBy: string;
  decision: 'approved' | 'declined' | null;
  suspendedAt: Date | null;
  revokedAt: Date | null;
}

export type GrantState = 'requested' | 'declined' | 'scheduled' | 'active' | 'suspended' | 'expired' | 'revoked';

export const GRANT_DEFAULT_DAYS = 30;
export const GRANT_MAX_DAYS = 90;

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export function grantState(g: GrantRow, today: string): GrantState {
  if (g.revokedAt) return 'revoked';
  if (g.decision === 'declined') return 'declined';
  if (g.decision === null) return 'requested';
  if (today > g.expiresOn) return 'expired';
  if (g.suspendedAt) return 'suspended';
  if (today < g.startsOn) return 'scheduled';
  return 'active';
}

/** The default end: thirty days after the start. */
export function defaultGrantEnd(startsOn: string): string {
  return addDays(startsOn, GRANT_DEFAULT_DAYS);
}

/** An end on or after `fromDay` and at most ninety days after it. */
export function grantSpanOk(fromDay: string, toDay: string): boolean {
  const span = dayNumber(toDay) - dayNumber(fromDay);
  return span >= 0 && span <= GRANT_MAX_DAYS;
}

/** Nobody approves their own access, and the person who recorded a request does not decide it. */
export function mayDecide(input: { deciderId: string; grant: GrantRow }): { allowed: true } | { allowed: false; reason: string } {
  if (input.deciderId === input.grant.userId) return { allowed: false, reason: 'Nobody can approve access for themselves.' };
  if (input.deciderId === input.grant.requestedBy) return { allowed: false, reason: 'The person who recorded the request cannot also decide it.' };
  return { allowed: true };
}

/** An Active grant gives access unless one of the holder's memberships in the same project is On Hold. */
export function grantGivesAccess(g: GrantRow, today: string, memberships: MembershipRow[]): boolean {
  if (grantState(g, today) !== 'active') return false;
  return !memberships.some((m) => m.userId === g.userId && isHeld(m) && membershipState(m, today) === 'on_hold');
}
