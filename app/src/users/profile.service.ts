import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { AuthUser } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { type MembershipRow, membershipState, todayUtc8 } from '../projects/membership';
import { UsersService } from './users.service';

interface RoleRow extends MembershipRow {
  projectId: string;
  projectName: string;
}

/** The day a past role ended (UTC+8): its expiry day, or the day it was revoked if that came first. */
function endedOn(m: MembershipRow): string {
  const revokedOn = m.revokedAt ? todayUtc8(m.revokedAt) : null;
  if (revokedOn === null) return m.expiresOn as string;
  return m.expiresOn !== null && m.expiresOn < revokedOn ? m.expiresOn : revokedOn;
}

/** What a signed-in person sees about themselves (D134). It is only ever read for the person asking. */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly access: ProjectAccess,
    private readonly users: UsersService,
  ) {}

  async profile(user: AuthUser) {
    const today = this.access.today();
    const { rows } = await this.pool.query<RoleRow>(
      `SELECT m.project_id AS "projectId", p.name AS "projectName", m.user_id AS "userId", m.role,
              to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn",
              m.revoked_at AS "revokedAt", m.held_at AS "heldAt", m.restored_at AS "restoredAt"
         FROM memberships m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id = $1 ORDER BY lower(p.name), p.id, m.starts_on, m.id`,
      [user.id],
    );
    const opens = new Map<string, boolean>();
    const roles = [];
    const pastRoles = [];
    for (const m of rows) {
      const role = { projectId: m.projectId, projectName: m.projectName, role: m.role, since: m.startsOn };
      // Expired and revoked roles are past; scheduled and held ones have not ended.
      if (['expired', 'revoked'].includes(membershipState(m, today))) {
        pastRoles.push({ ...role, endedOn: endedOn(m) });
        continue;
      }
      let canOpen = opens.get(m.projectId);
      if (canOpen === undefined) {
        canOpen = await this.canOpen(user, m.projectId);
        opens.set(m.projectId, canOpen);
      }
      roles.push({ ...role, until: m.expiresOn, canOpen });
    }
    pastRoles.sort((a, b) => b.endedOn.localeCompare(a.endedOn));
    return { name: user.displayName, email: user.email, department: await this.users.department(user.id), roles, pastRoles };
  }

  /** The check that opening a project makes (ProjectsService.detail). */
  private async canOpen(user: AuthUser, projectId: string): Promise<boolean> {
    try {
      await this.access.context(user, projectId);
      return true;
    } catch (err) {
      if (err instanceof NotFoundException) return false;
      throw err;
    }
  }
}
