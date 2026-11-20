/**
 * The SQL twins of the access rules `ProjectAccess.load` applies in TypeScript, for filters that run inside a query.
 * `todayParam` is a placeholder such as `$2` holding the UTC+8 day ('YYYY-MM-DD'), as `ProjectContext.today`.
 */

/** SQL: the membership row `m` is held now (`isHeld`: held and not restored since). */
const heldSql = (m: string) => `(${m}.held_at IS NOT NULL AND (${m}.restored_at IS NULL OR ${m}.restored_at < ${m}.held_at))`;

/** SQL: the membership row `m` is Active today (`membershipState(...) === 'active'`): not revoked, not expired, not held, started. */
export function activeMembershipSql(m: string, todayParam: string): string {
  return `(${m}.revoked_at IS NULL
         AND (${m}.expires_on IS NULL OR ${m}.expires_on >= ${todayParam}::date)
         AND NOT ${heldSql(m)}
         AND ${m}.starts_on <= ${todayParam}::date)`;
}

/** SQL: the membership row `m` is On Hold today (`membershipState(...) === 'on_hold'`): not revoked, not expired, held. */
export function onHoldMembershipSql(m: string, todayParam: string): string {
  return `(${m}.revoked_at IS NULL
         AND (${m}.expires_on IS NULL OR ${m}.expires_on >= ${todayParam}::date)
         AND ${heldSql(m)})`;
}

/**
 * SQL: the person holds an Active role in `roles` on the project `projectExpr` today (`effectiveRoles`). `alias` names
 * the inner memberships row, so the expression can sit inside another query on memberships.
 */
export function holdsActiveRoleSql(projectExpr: string, userParam: string, todayParam: string, roles: readonly string[], alias = 'arm'): string {
  return `EXISTS (
      SELECT 1 FROM memberships ${alias}
       WHERE ${alias}.project_id = ${projectExpr} AND ${alias}.user_id = ${userParam}::uuid AND ${alias}.role IN (${roles.map((r) => `'${r}'`).join(', ')})
         AND ${activeMembershipSql(alias, todayParam)})`;
}

/**
 * SQL: the person holds an Audit or Oversight grant on `projectExpr` that gives access today (`grantGivesAccess`): approved,
 * not revoked, not past its end day, not suspended, started, and none of their memberships in the project is On Hold.
 */
export function grantGivesAccessSql(projectExpr: string, userParam: string, todayParam: string): string {
  return `EXISTS (
      SELECT 1 FROM access_grants ag
       WHERE ag.project_id = ${projectExpr} AND ag.user_id = ${userParam}::uuid
         AND ag.revoked_at IS NULL AND ag.decision = 'approved'
         AND ag.expires_on >= ${todayParam}::date AND ag.suspended_at IS NULL AND ag.starts_on <= ${todayParam}::date
         AND NOT EXISTS (SELECT 1 FROM memberships hm WHERE hm.project_id = ${projectExpr} AND hm.user_id = ${userParam}::uuid
                           AND ${onHoldMembershipSql('hm', todayParam)}))`;
}
