import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { isCalendarDate } from '../extraction/due';
import { type ProjectContext, ProjectAccess, managesGrants } from './access.service';
import { GRANT_KINDS, type GrantKind, type GrantRow, defaultGrantEnd, grantSpanOk, grantState, mayDecide } from './grants';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_MANAGER = 'Only an Enterprise Administrator, the Owner or a Sponsor can manage Audit and Oversight access.';
const SPAN = 'Access can be granted for at most 90 days at a time.';
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

type Kind = 'approved' | 'declined' | 'extended' | 'suspended' | 'restored' | 'revoked';

/** Audit and Oversight access (V1.0 account lifecycle §8): recorded requests, independent decisions, time limits. */
@Injectable()
export class GrantsService {
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

  private mustManage(ctx: ProjectContext): void {
    if (!managesGrants(ctx)) throw new ForbiddenException(NOT_MANAGER);
  }

  private view(g: GrantRow & { purpose: string; scope: string }, today: string) {
    return { id: g.id, userId: g.userId, kind: g.kind, purpose: g.purpose, scope: g.scope, startsOn: g.startsOn, expiresOn: g.expiresOn, state: grantState(g, today) };
  }

  private async event(c: PoolClient, grantId: string, kind: Kind | 'requested', actorId: string, at: Date, reason: string | null, prev?: string, next?: string) {
    await c.query(
      `INSERT INTO grant_events (id, grant_id, kind, previous_expires_on, new_expires_on, actor_id, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(at.getTime()), grantId, kind, prev ?? null, next ?? null, actorId, reason, at],
    );
  }

  async request(user: AuthUser, projectId: string, input: Record<string, unknown>) {
    const kind = input.kind as GrantKind;
    if (!GRANT_KINDS.includes(kind)) throw new BadRequestException('Choose audit or oversight.');
    const purpose = text(input.purpose);
    const scope = text(input.scope);
    if (purpose === '' || purpose.length > 2000) throw new BadRequestException('Give the purpose (up to 2000 characters).');
    if (scope === '' || scope.length > 2000) throw new BadRequestException('Give the requested scope (up to 2000 characters).');
    if (!isCalendarDate(input.startsOn)) throw new BadRequestException('Dates must be in the form YYYY-MM-DD.');
    const startsOn = input.startsOn as string;
    const expiresOn = input.expiresOn === undefined || input.expiresOn === null || input.expiresOn === '' ? defaultGrantEnd(startsOn) : input.expiresOn;
    if (!isCalendarDate(expiresOn)) throw new BadRequestException('Dates must be in the form YYYY-MM-DD.');
    if (!grantSpanOk(startsOn, expiresOn)) throw new BadRequestException(SPAN);
    if (typeof input.userId !== 'string' || !UUID.test(input.userId)) throw new BadRequestException('Choose the person the access is for.');
    const at = this.now();
    return this.tx(async (c) => {
      const ctx = await this.access.context(user, projectId, c, true);
      this.mustManage(ctx);
      if (startsOn < ctx.project.createdOn) throw new BadRequestException('Access cannot start before the project was created.');
      const target = (await c.query(`SELECT id FROM users WHERE id = $1 AND status <> 'disabled'`, [input.userId])).rows[0];
      if (!target) throw new BadRequestException('Choose an enabled account.');
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, projectId, target.id, kind, purpose, scope, startsOn, expiresOn, user.id, at],
      );
      await this.event(c, id, 'requested', user.id, at, null, undefined, expiresOn);
      await writeAudit(c, { at, action: 'grant.requested', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { grantId: id, kind } });
      const row: GrantRow & { purpose: string; scope: string } = {
        id, userId: target.id, kind, purpose, scope, startsOn, expiresOn, requestedBy: user.id, decision: null, suspendedAt: null, revokedAt: null,
      };
      return { grant: this.view(row, ctx.today) };
    });
  }

  /** Loads a grant under lock with its project context; only grant managers may act on it. */
  private async load(c: PoolClient, user: AuthUser, grantId: string) {
    if (!UUID.test(grantId)) throw new NotFoundException();
    const g = (
      await c.query(
        `SELECT id, project_id AS "projectId", user_id AS "userId", kind, purpose, scope, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn",
                to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn", requested_by AS "requestedBy", decision, suspended_at AS "suspendedAt", revoked_at AS "revokedAt"
           FROM access_grants WHERE id = $1 FOR UPDATE`,
        [grantId],
      )
    ).rows[0] as (GrantRow & { projectId: string; purpose: string; scope: string }) | undefined;
    if (!g) throw new NotFoundException();
    const ctx = await this.access.context(user, g.projectId, c, true);
    this.mustManage(ctx);
    return { g, ctx };
  }

  private reasonOf(input: Record<string, unknown>): string {
    const reason = text(input.reason);
    if (reason === '') throw new BadRequestException('A reason is required.');
    return reason;
  }

  async decide(user: AuthUser, grantId: string, decision: 'approved' | 'declined', input: Record<string, unknown>) {
    const reason = decision === 'declined' ? this.reasonOf(input) : text(input.reason) || null;
    const at = this.now();
    return this.tx(async (c) => {
      const { g, ctx } = await this.load(c, user, grantId);
      const may = mayDecide({ deciderId: user.id, grant: g });
      if (!may.allowed) throw new ForbiddenException(may.reason);
      if (g.revokedAt) throw new ConflictException('This access was revoked; record a new request instead.');
      if (g.decision !== null) throw new ConflictException('This request has already been decided.');
      await c.query(`UPDATE access_grants SET decision = $2, decided_by = $3, decided_at = $4, decision_reason = $5 WHERE id = $1`, [g.id, decision, user.id, at, reason]);
      await this.event(c, g.id, decision, user.id, at, reason);
      await writeAudit(c, { at, action: `grant.${decision}`, actorUserId: user.id, subjectType: 'project', subjectId: g.projectId, detail: { grantId: g.id } });
      return { grant: this.view({ ...g, decision }, ctx.today) };
    });
  }

  async extend(user: AuthUser, grantId: string, input: Record<string, unknown>) {
    const at = this.now();
    return this.tx(async (c) => {
      const { g, ctx } = await this.load(c, user, grantId);
      if (g.userId === user.id) throw new ForbiddenException('Nobody can extend their own access.');
      if (g.revokedAt) throw new ConflictException('This access was revoked; record a new request instead.');
      if (g.decision !== 'approved') throw new ConflictException('Only approved access can be extended.');
      if (!isCalendarDate(input.expiresOn)) throw new BadRequestException('Dates must be in the form YYYY-MM-DD.');
      const next = input.expiresOn as string;
      if (next <= g.expiresOn) throw new BadRequestException('The new end must be later than the current one.');
      if (!grantSpanOk(g.expiresOn, next)) throw new BadRequestException(SPAN);
      await c.query(`UPDATE access_grants SET expires_on = $2 WHERE id = $1`, [g.id, next]);
      await this.event(c, g.id, 'extended', user.id, at, null, g.expiresOn, next);
      await writeAudit(c, { at, action: 'grant.extended', actorUserId: user.id, subjectType: 'project', subjectId: g.projectId, detail: { grantId: g.id } });
      return { grant: this.view({ ...g, expiresOn: next }, ctx.today) };
    });
  }

  async suspend(user: AuthUser, grantId: string, input: Record<string, unknown>) {
    const reason = this.reasonOf(input);
    const at = this.now();
    return this.tx(async (c) => {
      const { g, ctx } = await this.load(c, user, grantId);
      if (g.revokedAt) throw new ConflictException('This access was revoked; record a new request instead.');
      if (g.decision !== 'approved') throw new ConflictException('Only approved access can be suspended.');
      if (g.suspendedAt) throw new ConflictException('This access is already suspended.');
      await c.query(`UPDATE access_grants SET suspended_at = $2, suspended_by = $3, suspend_reason = $4 WHERE id = $1`, [g.id, at, user.id, reason]);
      await this.event(c, g.id, 'suspended', user.id, at, reason);
      await writeAudit(c, { at, action: 'grant.suspended', actorUserId: user.id, subjectType: 'project', subjectId: g.projectId, detail: { grantId: g.id } });
      return { grant: this.view({ ...g, suspendedAt: at }, ctx.today) };
    });
  }

  async restore(user: AuthUser, grantId: string, input: Record<string, unknown>) {
    const reason = this.reasonOf(input);
    const at = this.now();
    return this.tx(async (c) => {
      const { g, ctx } = await this.load(c, user, grantId);
      if (g.revokedAt) throw new ConflictException('This access was revoked; record a new request instead.');
      if (!g.suspendedAt) throw new ConflictException('This access is not suspended.');
      await c.query(`UPDATE access_grants SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL WHERE id = $1`, [g.id]);
      await this.event(c, g.id, 'restored', user.id, at, reason);
      await writeAudit(c, { at, action: 'grant.restored', actorUserId: user.id, subjectType: 'project', subjectId: g.projectId, detail: { grantId: g.id } });
      return { grant: this.view({ ...g, suspendedAt: null }, ctx.today) };
    });
  }

  async revoke(user: AuthUser, grantId: string, input: Record<string, unknown>) {
    const reason = this.reasonOf(input);
    const at = this.now();
    return this.tx(async (c) => {
      const { g, ctx } = await this.load(c, user, grantId);
      if (g.revokedAt) throw new ConflictException('This access was revoked; record a new request instead.');
      await c.query(`UPDATE access_grants SET revoked_at = $2, revoked_by = $3, revoke_reason = $4 WHERE id = $1`, [g.id, at, user.id, reason]);
      await this.event(c, g.id, 'revoked', user.id, at, reason);
      await writeAudit(c, { at, action: 'grant.revoked', actorUserId: user.id, subjectType: 'project', subjectId: g.projectId, detail: { grantId: g.id } });
      return { grant: this.view({ ...g, revokedAt: at }, ctx.today) };
    });
  }
}
