/**
 * Membership state, effective roles, required roles and role separation (V1.0 accepted rules).
 * Pure functions. Days are 'YYYY-MM-DD' in UTC+8: a membership starts at 00:00 on starts_on and a
 * date-only expiry ends access at 00:00 after expires_on.
 */

export type ProjectRole = 'pm' | 'deputy_pm' | 'owner' | 'sponsor' | 'member';
export type MembershipState = 'scheduled' | 'active' | 'expired' | 'revoked';

export interface MembershipRow {
  userId: string;
  role: ProjectRole;
  startsOn: string;
  expiresOn: string | null;
  revokedAt: Date | null;
}

const UTC8_MS = 8 * 60 * 60 * 1000;

/** The calendar day in UTC+8 for an instant. */
export function todayUtc8(now: Date): string {
  return new Date(now.getTime() + UTC8_MS).toISOString().slice(0, 10);
}

export function membershipState(m: MembershipRow, today: string): MembershipState {
  if (m.revokedAt) return 'revoked';
  if (today < m.startsOn) return 'scheduled';
  if (m.expiresOn !== null && today > m.expiresOn) return 'expired';
  return 'active';
}

/** The roles a person holds today through Active memberships. */
export function effectiveRoles(rows: MembershipRow[], userId: string, today: string): ProjectRole[] {
  return rows.filter((r) => r.userId === userId && membershipState(r, today) === 'active').map((r) => r.role);
}

/** Scheduled or Active: an appointment that has been accepted and has not ended. */
const current = (r: MembershipRow, today: string): boolean => ['scheduled', 'active'].includes(membershipState(r, today));

/**
 * The required roles: exactly one Project Manager, a Member who is a different person, and an Owner or
 * a Sponsor. 'accepted' counts Scheduled and Active appointments; 'active' counts Active ones only.
 */
export function requiredRolesCheck(rows: MembershipRow[], today: string, mode: 'accepted' | 'active'): { ok: boolean; missing: string[] } {
  const counted = rows.filter((r) => (mode === 'active' ? membershipState(r, today) === 'active' : current(r, today)));
  const pms = [...new Set(counted.filter((r) => r.role === 'pm').map((r) => r.userId))];
  const missing: string[] = [];
  if (pms.length !== 1) missing.push('a Project Manager');
  else if (!counted.some((r) => r.role === 'member' && r.userId !== pms[0])) missing.push('a Member who is not the Project Manager');
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
