import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { type MembershipRow, type ProjectRole, effectiveRoles, membershipState, requiredRolesCheck, todayUtc8 } from './membership';
import { type ProjectAction, type ProjectStatus, decide } from './matrix';

export const NOT_FOUND = 'Project not found';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MembershipRecord extends MembershipRow {
  id: string;
  holdReason?: string | null;
  displayName: string;
  email: string;
}

/** What a person may know about one project right now. */
export interface ProjectContext {
  project: { id: string; status: ProjectStatus; createdOn: string };
  roles: ProjectRole[];
  isAdmin: boolean;
  rows: MembershipRecord[];
  today: string;
  /** An Active project whose required roles are not all Active today. */
  missingAccountability: boolean;
  missingRoles: string[];
  /** A membership in this project is On Hold and needs investigating. */
  onHold: boolean;
}

/** People who manage roles here (or the Administrator) see holds and their reasons. */
export function managesRoles(ctx: ProjectContext): boolean {
  return ctx.isAdmin || ctx.roles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor');
}

type Db = Pool | PoolClient;

/**
 * The one place project access is decided: memberships Active today give roles, and the matrix says what
 * each role may do in each project status. A person with no role sees nothing of a project (404).
 */
@Injectable()
export class ProjectAccess {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  today(): string {
    return todayUtc8(this.now());
  }

  /** Loads a project and its memberships. `lock` takes the project row for the rest of the transaction. */
  async load(projectId: string, user: AuthUser, db: Db = this.pool, lock = false): Promise<ProjectContext | null> {
    if (!UUID.test(projectId)) return null;
    const p = await db.query(
      `SELECT id, status, to_char(created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS "createdOn"
         FROM projects WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [projectId],
    );
    if (!p.rows[0]) return null;
    const m = await db.query(
      `SELECT m.id, m.user_id AS "userId", m.role, to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn",
              to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn", m.revoked_at AS "revokedAt",
              m.held_at AS "heldAt", m.restored_at AS "restoredAt", m.hold_reason AS "holdReason",
              u.display_name AS "displayName", u.email
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 ORDER BY m.starts_on, m.id`,
      [projectId],
    );
    const rows = m.rows as MembershipRecord[];
    const today = this.today();
    const status = p.rows[0].status as ProjectStatus;
    const required = requiredRolesCheck(rows, today, 'active');
    const missing = status === 'active' && !required.ok;
    return {
      project: { id: p.rows[0].id, status, createdOn: p.rows[0].createdOn },
      roles: effectiveRoles(rows, user.id, today),
      isAdmin: user.role === 'enterprise_administrator',
      rows,
      today,
      missingAccountability: missing,
      missingRoles: missing ? required.missing : [],
      onHold: rows.some((r) => membershipState(r, today) === 'on_hold'),
    };
  }

  /** A participant, or an administrator (who may manage appointments and see the details, never content). */
  async context(user: AuthUser, projectId: string, db: Db = this.pool, lock = false): Promise<ProjectContext> {
    const ctx = await this.load(projectId, user, db, lock);
    if (!ctx || (ctx.roles.length === 0 && !ctx.isAdmin)) throw new NotFoundException(NOT_FOUND);
    return ctx;
  }

  /** Allowed by the matrix for this person in this project now, or 404 (not a participant) / 403 (with the reason). */
  async authorize(user: AuthUser, action: ProjectAction, projectId: string, db: Db = this.pool, lock = false): Promise<ProjectContext> {
    const ctx = await this.load(projectId, user, db, lock);
    if (!ctx || ctx.roles.length === 0) throw new NotFoundException(NOT_FOUND);
    const verdict = decide({ action, roles: ctx.roles, status: ctx.project.status });
    if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
    return ctx;
  }

  /** The projects where this person has an Active membership today. */
  async visibleProjectIds(userId: string, db: Db = this.pool): Promise<string[]> {
    const { rows } = await db.query(
      `SELECT DISTINCT m.project_id AS id FROM memberships m
        WHERE m.user_id = $1 AND m.revoked_at IS NULL AND m.starts_on <= $2::date AND (m.expires_on IS NULL OR m.expires_on >= $2::date)`,
      [userId, this.today()],
    );
    return rows.map((r) => r.id);
  }

  /** The project a note belongs to; notes from before projects belong to none and are not found. */
  async projectOfSource(sourceId: string, db: Db = this.pool): Promise<string> {
    if (!UUID.test(sourceId)) throw new NotFoundException();
    const { rows } = await db.query(`SELECT project_id FROM sources WHERE id = $1`, [sourceId]);
    if (!rows[0]?.project_id) throw new NotFoundException();
    return rows[0].project_id;
  }

  /** The project an extraction run belongs to, through its note. */
  async projectOfRun(runId: string, db: Db = this.pool): Promise<string> {
    if (!UUID.test(runId)) throw new NotFoundException();
    const { rows } = await db.query(
      `SELECT s.project_id FROM extraction_runs r JOIN source_versions v ON v.id = r.source_version_id JOIN sources s ON s.id = v.source_id
        WHERE r.id = $1`,
      [runId],
    );
    if (!rows[0]?.project_id) throw new NotFoundException();
    return rows[0].project_id;
  }

  /** Membership state of a row today (for display). */
  stateOf(row: MembershipRow): ReturnType<typeof membershipState> {
    return membershipState(row, this.today());
  }
}
