/**
 * Who receives each notice (spec section 5). Routing and cover are pure; loaders read the database.
 * Only people with an Active account and an Active role today are ever recipients, except the minimal
 * Administrator fallback.
 */
import type { Pool, PoolClient } from 'pg';
import { type MembershipRow, type ProjectRole, effectiveRoles } from '../projects/membership';
import type { TriggerKind } from './planner';

type Db = Pool | PoolClient;

export interface Holder {
  userId: string;
  roles: ProjectRole[];
}

export type RouteKind = TriggerKind | 'resumption' | 'assignee_unavailable';

export interface RouteContext {
  holders: Holder[];
  assigneeId: string | null;
  responsibleId?: string | null;
  admins: string[];
}

export interface Route {
  to: string[];
  noIndependent: boolean;
  minimal: boolean;
}

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();
const withRole = (holders: Holder[], ...roles: ProjectRole[]): string[] =>
  sorted(holders.filter((h) => h.roles.some((r) => roles.includes(r))).map((h) => h.userId));

export function routeFor(kind: RouteKind, ctx: RouteContext): Route {
  const { holders, assigneeId } = ctx;
  const isHolder = (id: string | null | undefined): id is string => !!id && holders.some((h) => h.userId === id);
  const pm = withRole(holders, 'pm');
  const os = withRole(holders, 'owner', 'sponsor');
  const result = (to: string[], escalation = false): Route => {
    const list = sorted(escalation ? to.filter((id) => id !== assigneeId) : to);
    return { to: list, noIndependent: escalation && list.length === 0, minimal: false };
  };

  switch (kind) {
    case 'reminder':
      return result(isHolder(assigneeId) ? [assigneeId] : []);
    case 'overdue': {
      const roles = holders.find((h) => h.userId === assigneeId)?.roles ?? [];
      if (roles.includes('owner') || roles.includes('sponsor')) return result([...os, ...pm], true);
      if (roles.includes('pm')) return result(os, true);
      return result(pm, true);
    }
    case 'parent_deadline':
      return result(assigneeId !== null && pm.includes(assigneeId) ? os : pm, true);
    case 'past_due_set':
      return result([...(isHolder(assigneeId) ? [assigneeId] : []), ...pm]);
    case 'risk_review_due':
    case 'risk_review_missed':
      return result([...(isHolder(ctx.responsibleId) ? [ctx.responsibleId] : []), ...pm]);
    case 'assignee_unavailable':
      if (pm.length > 0) return result(pm);
      if (os.length > 0) return result(os);
      return { to: sorted(ctx.admins), noIndependent: false, minimal: true };
    case 'resumption':
      return result(pm);
  }
}

const COVERED: readonly RouteKind[] = ['overdue', 'parent_deadline', 'assignee_unavailable'];

/**
 * Adds cover for recipients who are away or have email off: PM covered by every Owner and Sponsor; an
 * Owner or Sponsor by the PM and the other Owners and Sponsors. Never the assignee, never an
 * unreachable person, never an Administrator.
 */
export function applyCover(
  kind: RouteKind,
  route: { to: string[]; minimal?: boolean },
  ctx: { holders: Holder[]; assigneeId: string | null; unreachable: ReadonlySet<string> },
): { to: string[]; covering: string[] } {
  const original = sorted(route.to);
  if (!COVERED.includes(kind) || route.minimal) return { to: original, covering: [] };
  const pm = withRole(ctx.holders, 'pm');
  const os = withRole(ctx.holders, 'owner', 'sponsor');
  const added = new Set<string>();
  for (const id of original) {
    if (!ctx.unreachable.has(id)) continue;
    const roles = ctx.holders.find((h) => h.userId === id)?.roles ?? [];
    if (roles.includes('pm')) os.forEach((x) => added.add(x));
    if (roles.includes('owner') || roles.includes('sponsor')) [...pm, ...os].forEach((x) => added.add(x));
  }
  const covering = sorted([...added].filter((id) => !original.includes(id) && id !== ctx.assigneeId && !ctx.unreachable.has(id)));
  return { to: sorted([...original, ...covering]), covering };
}

/** People with an Active role in the project today and an Active account, with those roles. */
export async function loadHolders(db: Db, projectId: string, today: string): Promise<Holder[]> {
  const m = await db.query(
    `SELECT m.user_id AS "userId", m.role, to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn",
            to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn", m.revoked_at AS "revokedAt",
            m.held_at AS "heldAt", m.restored_at AS "restoredAt"
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1 AND u.status = 'active'
      ORDER BY m.user_id, m.id`,
    [projectId],
  );
  const rows = m.rows as MembershipRow[];
  const out: Holder[] = [];
  for (const userId of sorted(rows.map((r) => r.userId))) {
    const roles = effectiveRoles(rows, userId, today);
    if (roles.length > 0) out.push({ userId, roles: [...new Set(roles)] });
  }
  return out;
}

export async function isEligible(db: Db, userId: string, projectId: string | null, today: string): Promise<boolean> {
  if (projectId === null) {
    const r = await db.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active' AND role = 'enterprise_administrator'`, [userId]);
    return r.rows.length > 0;
  }
  return (await loadHolders(db, projectId, today)).some((h) => h.userId === userId);
}

/** People who get no email today: away on `today` (inclusive), or email preference 'off' for the project. */
export async function loadUnreachable(db: Db, projectId: string, today: string): Promise<Set<string>> {
  const r = await db.query(
    `SELECT user_id AS "userId" FROM away_periods
      WHERE removed_at IS NULL AND starts_on <= $1::date AND ends_on >= $1::date
     UNION
     SELECT user_id FROM email_preferences WHERE project_id = $2 AND choice = 'off'`,
    [today, projectId],
  );
  return new Set(r.rows.map((x: { userId: string }) => x.userId));
}

/** Active Enterprise Administrators, for the minimal fallback. */
export async function loadAdmins(db: Db): Promise<string[]> {
  const r = await db.query(`SELECT id FROM users WHERE status = 'active' AND role = 'enterprise_administrator' ORDER BY id`);
  return r.rows.map((x: { id: string }) => x.id);
}
