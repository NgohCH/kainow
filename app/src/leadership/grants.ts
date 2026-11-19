/**
 * Leadership grants (D89; dashboards design section 6.1). Days are 'YYYY-MM-DD' in UTC+8. `expiresOn` is the last day,
 * inclusive: access works through 23:59 that day and ends at 00:00 the next day. A leadership grant gives summary
 * fields only: it adds no matrix action and no project access.
 */
import type { Pool, PoolClient } from 'pg';

export type LeadershipGrantState = 'scheduled' | 'active' | 'ended' | 'revoked';
export type LeadershipScopeKind = 'organisation' | 'departments' | 'projects';
export const LEADERSHIP_SCOPE_KINDS: readonly LeadershipScopeKind[] = ['organisation', 'departments', 'projects'];

export function leadershipGrantState(g: { startsOn: string; expiresOn: string | null; revokedAt: string | Date | null }, today: string): LeadershipGrantState {
  if (g.revokedAt) return 'revoked';
  if (g.expiresOn !== null && today > g.expiresOn) return 'ended';
  if (today < g.startsOn) return 'scheduled';
  return 'active';
}

/**
 * The projects a person's Active leadership grants cover, worked out now: null when they hold no Active grant or their
 * account is not Active. The union of every Active grant's scope: all projects (organisation scope), projects whose
 * current owning department is in scope, or the named projects.
 */
export async function leadershipProjectIds(db: Pool | PoolClient, userId: string, today: string): Promise<string[] | null> {
  const { rows: grants } = await db.query(
    `SELECT g.id, g.scope_kind AS "scopeKind"
       FROM leadership_grants g JOIN users u ON u.id = g.user_id
      WHERE g.user_id = $1 AND u.status = 'active' AND g.revoked_at IS NULL
        AND g.starts_on <= $2::date AND (g.expires_on IS NULL OR g.expires_on >= $2::date)`,
    [userId, today],
  );
  if (grants.length === 0) return null;
  if (grants.some((g) => g.scopeKind === 'organisation')) {
    return (await db.query(`SELECT id FROM projects ORDER BY id`)).rows.map((r) => r.id as string);
  }
  const ids = grants.map((g) => g.id as string);
  const { rows } = await db.query(
    `SELECT p.id FROM projects p
      WHERE p.owning_department_id IN (SELECT department_id FROM leadership_grant_departments WHERE grant_id = ANY($1::uuid[]))
         OR p.id IN (SELECT project_id FROM leadership_grant_projects WHERE grant_id = ANY($1::uuid[]))
      ORDER BY p.id`,
    [ids],
  );
  return rows.map((r) => r.id as string);
}
