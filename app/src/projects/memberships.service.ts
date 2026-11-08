import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { isCalendarDate } from '../extraction/due';
import { type ProjectContext, ProjectAccess } from './access.service';
import { canManageRole } from './matrix';
import { type MembershipRow, type ProjectRole, membershipState, requiredRolesCheck, separationCheck } from './membership';

export const PROJECT_ROLES: readonly ProjectRole[] = ['pm', 'deputy_pm', 'owner', 'sponsor', 'member'];

/** A start date and an optional expiry, checked against the project's creation day. */
export function cleanDates(createdOn: string, startsIn: unknown, expiresIn: unknown): { startsOn: string; expiresOn: string | null } {
  const date = (v: unknown, optional: boolean): string | null => {
    if (optional && (v === undefined || v === null || v === '')) return null;
    if (!isCalendarDate(v)) throw new BadRequestException('Dates must be in the form YYYY-MM-DD.');
    return v;
  };
  const startsOn = date(startsIn, false) as string;
  const expiresOn = date(expiresIn, true);
  if (startsOn < createdOn || (expiresOn !== null && expiresOn < createdOn)) {
    throw new BadRequestException('Membership dates cannot be before the project was created.');
  }
  if (expiresOn !== null && expiresOn < startsOn) throw new BadRequestException('The expiry cannot be before the start.');
  return { startsOn, expiresOn };
}

export function cleanRole(v: unknown): ProjectRole {
  if (!PROJECT_ROLES.includes(v as ProjectRole)) throw new BadRequestException('Choose a role: pm, deputy_pm, owner, sponsor or member.');
  return v as ProjectRole;
}

/**
 * The checks every new appointment passes, whether made directly or by accepting an invitation, against
 * the project's memberships as they would be with the candidate added. Callers hold the project row lock.
 */
export function checkNewAppointment(ctx: ProjectContext, candidate: MembershipRow): void {
  const current = (m: MembershipRow) => ['scheduled', 'active'].includes(membershipState(m, ctx.today));
  if (ctx.rows.some((m) => m.userId === candidate.userId && m.role === candidate.role && !m.revokedAt)) {
    throw new ConflictException('That person already holds this role in the project; extend or change its dates instead.');
  }
  if (candidate.role === 'owner' && ctx.rows.some((m) => m.role === 'owner' && current(m))) {
    throw new ConflictException('A project can have only one Owner.');
  }
  // A new PM replaces the old one (done by the caller), so the old PM does not count here.
  const others = candidate.role === 'pm' ? ctx.rows.filter((m) => m.role !== 'pm') : ctx.rows;
  const sep = separationCheck([...others, candidate], ctx.today);
  if (!sep.ok) throw new ConflictException(sep.reason);
}

@Injectable()
export class MembershipsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private mayManage(ctx: ProjectContext, target: ProjectRole): void {
    const v = canManageRole({ target, roles: ctx.roles, isAdmin: ctx.isAdmin, status: ctx.project.status, via: 'appointment' });
    if (!v.allowed) throw new ForbiddenException(v.reason);
  }

  /** Inserts an appointment (replacing the current PM when appointing a PM) with its history. */
  async insertAppointment(
    c: PoolClient,
    ctx: ProjectContext,
    candidate: MembershipRow,
    actorId: string,
    reason: string,
    at: Date,
  ): Promise<string> {
    if (candidate.role === 'pm') {
      for (const old of ctx.rows.filter((m) => m.role === 'pm' && !m.revokedAt && membershipState(m, ctx.today) !== 'expired')) {
        if (old.userId === candidate.userId) continue;
        await c.query(`UPDATE memberships SET revoked_at = $2, revoked_by = $3, revoke_reason = 'Replaced by a new Project Manager' WHERE id = $1`, [
          old.id, at, actorId,
        ]);
        await c.query(
          `INSERT INTO membership_events (id, membership_id, kind, previous_starts_on, previous_expires_on, actor_id, reason, at)
           VALUES ($1, $2, 'revoked', $3, $4, $5, 'Replaced by a new Project Manager', $6)`,
          [uuidv7(at.getTime()), old.id, old.startsOn, old.expiresOn, actorId, at],
        );
      }
    }
    const id = uuidv7(at.getTime());
    await c.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id, ctx.project.id, candidate.userId, candidate.role, candidate.startsOn, candidate.expiresOn,
    ]);
    await c.query(
      `INSERT INTO membership_events (id, membership_id, kind, new_starts_on, new_expires_on, actor_id, reason, at) VALUES ($1, $2, 'appointed', $3, $4, $5, $6, $7)`,
      [uuidv7(at.getTime()), id, candidate.startsOn, candidate.expiresOn, actorId, reason, at],
    );
    await writeAudit(c, {
      at,
      action: 'membership.appointed',
      actorUserId: actorId,
      subjectType: 'project',
      subjectId: ctx.project.id,
      detail: { membershipId: id, userId: candidate.userId, role: candidate.role },
    });
    return id;
  }

  async appoint(user: AuthUser, projectId: string, input: Record<string, unknown>) {
    const role = cleanRole(input.role);
    const at = this.now();
    return this.tx(async (c) => {
      const ctx = await this.access.context(user, projectId, c, true);
      this.mayManage(ctx, role);
      const { startsOn, expiresOn } = cleanDates(ctx.project.createdOn, input.startsOn, input.expiresOn);
      const target = typeof input.userId === 'string' && /^[0-9a-f-]{36}$/i.test(input.userId)
        ? (await c.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [input.userId])).rows[0]
        : undefined;
      if (!target) throw new BadRequestException('Choose an active person to appoint.');
      const candidate: MembershipRow = { userId: target.id, role, startsOn, expiresOn, revokedAt: null };
      checkNewAppointment(ctx, candidate);
      const id = await this.insertAppointment(c, ctx, candidate, user.id, 'Appointed', at);
      return { membership: { id, userId: target.id, role, startsOn, expiresOn, state: membershipState(candidate, ctx.today) } };
    });
  }

  /** Loads one membership and its project under lock, and checks the person may manage that role. */
  private async loadForChange(c: PoolClient, user: AuthUser, membershipId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(membershipId)) throw new NotFoundException();
    const m = (await c.query(`SELECT project_id FROM memberships WHERE id = $1`, [membershipId])).rows[0];
    if (!m) throw new NotFoundException();
    const ctx = await this.access.context(user, m.project_id, c, true);
    const row = ctx.rows.find((r) => r.id === membershipId);
    if (!row) throw new NotFoundException();
    this.mayManage(ctx, row.role);
    if (row.revokedAt) throw new ConflictException('This membership was revoked; invite the person again instead.');
    return { ctx, row };
  }

  private async recordChange(
    c: PoolClient,
    kind: 'extended' | 'dates_changed' | 'revoked',
    row: MembershipRow & { id: string },
    next: { startsOn: string; expiresOn: string | null } | null,
    actorId: string,
    reason: string | null,
    at: Date,
    projectId: string,
  ) {
    await c.query(
      `INSERT INTO membership_events (id, membership_id, kind, previous_starts_on, previous_expires_on, new_starts_on, new_expires_on, actor_id, reason, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [uuidv7(at.getTime()), row.id, kind, row.startsOn, row.expiresOn, next?.startsOn ?? null, next?.expiresOn ?? null, actorId, reason, at],
    );
    await writeAudit(c, { at, action: `membership.${kind}`, actorUserId: actorId, subjectType: 'project', subjectId: projectId, detail: { membershipId: row.id } });
  }

  async extend(user: AuthUser, membershipId: string, input: Record<string, unknown>) {
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, row } = await this.loadForChange(c, user, membershipId);
      const next = cleanDates(ctx.project.createdOn, row.startsOn, input.expiresOn);
      if (next.expiresOn === null) throw new BadRequestException('Give the new expiry date.');
      const sep = separationCheck(ctx.rows.map((r) => (r.id === row.id ? { ...r, ...next } : r)), ctx.today);
      if (!sep.ok) throw new ConflictException(sep.reason);
      await c.query(`UPDATE memberships SET expires_on = $2 WHERE id = $1`, [row.id, next.expiresOn]);
      await this.recordChange(c, 'extended', row, next, user.id, null, at, ctx.project.id);
      return { membership: { id: row.id, ...next, state: membershipState({ ...row, ...next }, ctx.today) } };
    });
  }

  async changeDates(user: AuthUser, membershipId: string, input: Record<string, unknown>) {
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, row } = await this.loadForChange(c, user, membershipId);
      const next = cleanDates(ctx.project.createdOn, input.startsOn, input.expiresOn);
      const sep = separationCheck(ctx.rows.map((r) => (r.id === row.id ? { ...r, ...next } : r)), ctx.today);
      if (!sep.ok) throw new ConflictException(sep.reason);
      await c.query(`UPDATE memberships SET starts_on = $2, expires_on = $3 WHERE id = $1`, [row.id, next.startsOn, next.expiresOn]);
      await this.recordChange(c, 'dates_changed', row, next, user.id, null, at, ctx.project.id);
      return { membership: { id: row.id, ...next, state: membershipState({ ...row, ...next }, ctx.today) } };
    });
  }

  async revoke(user: AuthUser, membershipId: string, input: Record<string, unknown>) {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '') throw new BadRequestException('A reason is required.');
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, row } = await this.loadForChange(c, user, membershipId);
      // Arrange a replacement before removing a required role (Product Summary §4); a Draft may be incomplete.
      if (ctx.project.status !== 'draft') {
        const before = requiredRolesCheck(ctx.rows, ctx.today, 'accepted').missing;
        const after = requiredRolesCheck(ctx.rows.filter((r) => r.id !== row.id), ctx.today, 'accepted').missing;
        const lost = after.filter((m) => !before.includes(m));
        if (lost.length > 0) {
          throw new ConflictException(`Arrange a replacement first. Without this appointment the project would be missing ${lost.join(' and ')}.`);
        }
      }
      await c.query(`UPDATE memberships SET revoked_at = $2, revoked_by = $3, revoke_reason = $4 WHERE id = $1`, [row.id, at, user.id, reason]);
      await this.recordChange(c, 'revoked', row, null, user.id, reason, at, ctx.project.id);
      return { membership: { id: row.id, state: 'revoked' } };
    });
  }
}
