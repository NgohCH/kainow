import { BadRequestException } from '@nestjs/common';
import { UUID } from '../common/uuid7';
import { type ProjectContext, canReadContent } from '../projects/access.service';
import type { ProjectRole } from '../projects/membership';

export type AudienceMode = 'project' | 'restricted';

export interface AudienceRow {
  id: string;
  projectId: string | null;
  mode: AudienceMode;
  namedUserIds: string[];
}

export interface AudienceChange {
  mode: AudienceMode;
  namedUserIds: string[];
}

export interface Person {
  id: string;
  displayName: string;
}

/** Who sees a Restricted source through their role alone (spec 6.1). */
export const RESTRICTED_ROLES: readonly ProjectRole[] = ['pm', 'deputy_pm', 'owner', 'sponsor'];

/**
 * Whether the person is in the audience. `ctx.roles` holds only Active memberships and `grantKinds` only
 * grants giving access today, so validity of a membership or grant is already applied. An Administrator
 * with no role or grant is never in an audience.
 */
export function inAudience(ctx: ProjectContext, a: AudienceRow): boolean {
  if (a.projectId !== ctx.project.id) return false;
  if (!canReadContent(ctx)) return false;
  if (a.mode === 'project') return true;
  return ctx.roles.some((r) => RESTRICTED_ROLES.includes(r)) || a.namedUserIds.includes(ctx.viewerId);
}

/**
 * The SQL twin of `inAudience`: a boolean expression over the audience row `audienceAlias`. The caller must
 * already have established that the person can read the project (a valid role or grant). The role test mirrors
 * `membershipState(...) === 'active'`: not revoked, not past its expiry day, not held, already started.
 * `userParam` and `todayParam` are placeholders such as `$1` and `$2` (a uuid and a UTC+8 'YYYY-MM-DD').
 */
export function audienceVisibleSql(audienceAlias: string, userParam: string, todayParam: string): string {
  const a = audienceAlias;
  return `(${a}.mode = 'project'
    OR EXISTS (SELECT 1 FROM audience_members am WHERE am.audience_id = ${a}.id AND am.user_id = ${userParam}::uuid)
    OR ${activeManagerSql(`${a}.project_id`, userParam, todayParam)})`;
}

/** SQL: the person holds an Active role among `roleList` (default: PM, Deputy, Owner or Sponsor) on the project `projectExpr` today. */
export function activeManagerSql(projectExpr: string, userParam: string, todayParam: string, roleList: readonly ProjectRole[] = RESTRICTED_ROLES): string {
  const roles = roleList.map((r) => `'${r}'`).join(', ');
  return `EXISTS (
      SELECT 1 FROM memberships rm
       WHERE rm.project_id = ${projectExpr} AND rm.user_id = ${userParam}::uuid AND rm.role IN (${roles})
         AND rm.revoked_at IS NULL
         AND (rm.expires_on IS NULL OR rm.expires_on >= ${todayParam}::date)
         AND (rm.held_at IS NULL OR (rm.restored_at IS NOT NULL AND rm.restored_at >= rm.held_at))
         AND rm.starts_on <= ${todayParam}::date)`;
}

const BAD_CHANGE = 'Choose Project-wide or Restricted, and name people only for a Restricted audience.';

/** Reads `{ mode, namedUserIds }` from a request body. Whether the named people belong to the project is checked later. */
export function parseAudienceChange(body: unknown): AudienceChange {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.mode !== 'project' && b.mode !== 'restricted') throw new BadRequestException(BAD_CHANGE);
  const raw = b.namedUserIds ?? [];
  if (!Array.isArray(raw) || raw.length > 200 || raw.some((x) => typeof x !== 'string' || !UUID.test(x))) {
    throw new BadRequestException('Name people by their account id.');
  }
  const namedUserIds = [...new Set(raw as string[])];
  if (b.mode === 'project' && namedUserIds.length > 0) throw new BadRequestException(BAD_CHANGE);
  return { mode: b.mode, namedUserIds };
}
