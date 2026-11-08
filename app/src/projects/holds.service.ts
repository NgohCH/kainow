import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from './access.service';
import { canManageRole } from './matrix';
import { membershipState } from './membership';
import { checkMembershipsAfter } from './memberships.service';
import { OrganisationService } from './organisation.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Investigation of held memberships (V1.0 Sign-in, Access Requests and Account Lifecycle §5): findings
 * recorded by the Project Manager or a manager of the held role, and restoration by a manager of that role.
 */
@Injectable()
export class HoldsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly org: OrganisationService,
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

  private async load(c: Pool | PoolClient, user: AuthUser, membershipId: string, lock: boolean) {
    if (!UUID.test(membershipId)) throw new NotFoundException();
    const m = (await c.query(`SELECT project_id FROM memberships WHERE id = $1`, [membershipId])).rows[0];
    if (!m) throw new NotFoundException();
    const ctx = await this.access.context(user, m.project_id, c, lock);
    const row = ctx.rows.find((r) => r.id === membershipId);
    if (!row) throw new NotFoundException();
    return { ctx, row };
  }

  private managesRole(ctx: ProjectContext, role: Parameters<typeof canManageRole>[0]['target']): boolean {
    return canManageRole({ target: role, roles: ctx.roles, isAdmin: ctx.isAdmin, status: ctx.project.status, via: 'appointment' }).allowed;
  }

  async recordFinding(user: AuthUser, membershipId: string, input: Record<string, unknown>) {
    const finding = text(input.finding);
    if (finding === '' || finding.length > 4000) throw new BadRequestException('Write the finding (up to 4000 characters).');
    const recommendation = input.recommendation;
    if (recommendation !== 'restore' && recommendation !== 'revoke') throw new BadRequestException('Recommend restore or revoke.');
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, row } = await this.load(c, user, membershipId, true);
      if (!ctx.roles.includes('pm') && !this.managesRole(ctx, row.role)) {
        throw new ForbiddenException('Only the Project Manager or a manager of this role can record a finding.');
      }
      if (membershipState(row, ctx.today) !== 'on_hold') throw new ConflictException('This membership is not On Hold.');
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO membership_findings (id, membership_id, finding, recommendation, recorded_by, at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, row.id, finding, recommendation, user.id, at],
      );
      await c.query(`INSERT INTO membership_events (id, membership_id, kind, actor_id, reason, at) VALUES ($1, $2, 'finding', $3, $4, $5)`, [
        uuidv7(at.getTime()), row.id, user.id, `Recommends ${recommendation}`, at,
      ]);
      await writeAudit(c, { at, action: 'membership.finding', actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id, detail: { membershipId: row.id, recommendation } });
      return { finding: { id, recommendation, at } };
    });
  }

  async findings(user: AuthUser, membershipId: string) {
    const { ctx, row } = await this.load(this.pool, user, membershipId, false);
    const { rows } = await this.pool.query(
      `SELECT f.id, f.finding, f.recommendation, f.at, f.recorded_by AS "recordedById", u.display_name AS "recordedBy"
         FROM membership_findings f JOIN users u ON u.id = f.recorded_by WHERE f.membership_id = $1 ORDER BY f.at, f.id`,
      [row.id],
    );
    const isAuthor = rows.some((r) => r.recordedById === user.id);
    if (!isAuthor && !ctx.roles.includes('pm') && !this.managesRole(ctx, row.role)) {
      throw new ForbiddenException('Only the investigators and the managers of this role can read the findings.');
    }
    return { findings: rows.map(({ recordedById: _id, ...f }) => f) };
  }

  async restore(user: AuthUser, membershipId: string, input: Record<string, unknown>) {
    const reason = text(input.reason);
    if (reason === '') throw new BadRequestException('A reason is required.');
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, row } = await this.load(c, user, membershipId, true);
      const v = canManageRole({ target: row.role, roles: ctx.roles, isAdmin: ctx.isAdmin, status: ctx.project.status, via: 'appointment' });
      if (!v.allowed) throw new ForbiddenException(v.reason);
      const state = membershipState(row, ctx.today);
      if (state === 'expired') throw new ConflictException('This membership has ended; extend it before restoring it.');
      if (state === 'revoked') throw new ConflictException('This membership was revoked; invite the person again instead.');
      if (state !== 'on_hold') throw new ConflictException('This membership is not On Hold.');
      const account = (await c.query(`SELECT status FROM users WHERE id = $1`, [row.userId])).rows[0];
      if (account.status === 'disabled') throw new ConflictException('The account is disabled; an Administrator must enable it first.');
      if (!(await this.org.isEligible(row.email))) throw new ConflictException('That address is not in an eligible organisation domain.');
      checkMembershipsAfter(ctx, ctx.rows.map((r) => (r.id === row.id ? { ...r, restoredAt: at } : r)));
      await c.query(`UPDATE memberships SET restored_at = $2, restored_by = $3, restore_reason = $4 WHERE id = $1`, [row.id, at, user.id, reason]);
      await c.query(`INSERT INTO membership_events (id, membership_id, kind, actor_id, reason, at) VALUES ($1, $2, 'restored', $3, $4, $5)`, [
        uuidv7(at.getTime()), row.id, user.id, reason, at,
      ]);
      await writeAudit(c, { at, action: 'membership.restored', actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id, detail: { membershipId: row.id } });
      const restored = { ...row, restoredAt: at };
      return { membership: { id: row.id, state: membershipState(restored, ctx.today) } };
    });
  }
}
