/**
 * Membership state, effective roles, required roles and role separation (V1.0 accepted rules).
 * Pure functions. Days are 'YYYY-MM-DD' in UTC+8: a membership starts at 00:00 on starts_on and a
 * date-only expiry ends access at 00:00 after expires_on.
 */

export type ProjectRole = 'pm' | 'deputy_pm' | 'owner' | 'sponsor' | 'member';
export type MembershipState = 'scheduled' | 'active' | 'on_hold' | 'expired' | 'revoked';

export interface MembershipRow {
  userId: string;
  role: ProjectRole;
  startsOn: string;
  expiresOn: string | null;
  revokedAt: Date | null;
  /** A hold (account disabled, investigation) is current when heldAt is set and not followed by restoredAt. */
  heldAt?: Date | null;
  restoredAt?: Date | null;
}

export function isHeld(m: MembershipRow): boolean {
  if (!m.heldAt) return false;
  return !m.restoredAt || new Date(m.restoredAt).getTime() < new Date(m.heldAt).getTime();
}

const UTC8_MS = 8 * 60 * 60 * 1000;

/** The calendar day in UTC+8 for an instant. */
export function todayUtc8(now: Date): string {
  return new Date(now.getTime() + UTC8_MS).toISOString().slice(0, 10);
}

export function membershipState(m: MembershipRow, today: string): MembershipState {
  if (m.revokedAt) return 'revoked';
  if (m.expiresOn !== null && today > m.expiresOn) return 'expired';
  if (isHeld(m)) return 'on_hold';
  if (today < m.startsOn) return 'scheduled';
  return 'active';
}

/** The roles a person holds today through Active memberships. */
export function effectiveRoles(rows: MembershipRow[], userId: string, today: string): ProjectRole[] {
  return rows.filter((r) => r.userId === userId && membershipState(r, today) === 'active').map((r) => r.role);
}

/** Scheduled or Active: an appointment that has been accepted and has not ended. */
const current = (r: MembershipRow, today: string): boolean => ['scheduled', 'active'].includes(membershipState(r, today));

/** Roles that only one person may hold at any one time; a successor may be appointed to follow on. */
export const SINGLE_HOLDER_ROLES: readonly ProjectRole[] = ['pm', 'owner'];

/** Whether two appointments' date ranges share at least one day (no expiry runs on for ever). */
export function datesOverlap(a: MembershipRow, b: MembershipRow): boolean {
  const end = (r: MembershipRow) => r.expiresOn ?? '9999-12-31';
  return a.startsOn <= end(b) && b.startsOn <= end(a);
}

/** A single-holder role that two different people would hold on the same day, if any. */
export function doubleHolding(rows: MembershipRow[], today: string): ProjectRole | null {
  const live = rows.filter((r) => current(r, today));
  for (const role of SINGLE_HOLDER_ROLES) {
    const holders = live.filter((r) => r.role === role);
    for (const a of holders) for (const b of holders) if (a.userId !== b.userId && datesOverlap(a, b)) return role;
  }
  return null;
}

/**
 * The required roles: exactly one Project Manager, a Member who is a different person, and an Owner or
 * a Sponsor. 'accepted' counts Scheduled and Active appointments; 'active' counts Active ones only.
 * A Project Manager followed by a successor (dates that do not overlap) still counts as one.
 */
export function requiredRolesCheck(rows: MembershipRow[], today: string, mode: 'accepted' | 'active'): { ok: boolean; missing: string[] } {
  const counted = rows.filter((r) => (mode === 'active' ? membershipState(r, today) === 'active' : current(r, today)));
  const pmRows = counted.filter((r) => r.role === 'pm');
  const pms = new Set(pmRows.map((r) => r.userId));
  const missing: string[] = [];
  if (pmRows.length === 0 || doubleHolding(pmRows, today) === 'pm') missing.push('a Project Manager');
  else if (!counted.some((r) => r.role === 'member' && !pms.has(r.userId))) missing.push('a Member who is not the Project Manager');
  if (!counted.some((r) => r.role === 'owner' || r.role === 'sponsor')) missing.push('an Owner or a Sponsor');
  return { ok: missing.length === 0, missing };
}

export const SEPARATION_REASON = 'With seven or more people, the Project Manager, Owner and Sponsors must be different people.';

/** At seven or more current people, nobody may hold two of Project Manager, Owner and Sponsor. */
export function separationCheck(rows: MembershipRow[], today: string): { ok: boolean; reason: string | null } {
  const live = rows.filter((r) => current(r, today));
  const people = new Set(live.map((r) => r.userId));
  if (people.size < 7) return { ok: true, reason: null };
  for (const person of people) {
    const held = new Set(live.filter((r) => r.userId === person && ['pm', 'owner', 'sponsor'].includes(r.role)).map((r) => r.role));
    if (held.size > 1) return { ok: false, reason: SEPARATION_REASON };
  }
  return { ok: true, reason: null };
}
