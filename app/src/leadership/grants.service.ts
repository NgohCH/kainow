import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { isCalendarDate } from '../extraction/due';
import { todayUtc8 } from '../projects/membership';
import { LEADERSHIP_SCOPE_KINDS, type LeadershipScopeKind, leadershipGrantState } from './grants';

const DATE = 'Dates must be in the form YYYY-MM-DD.';
const SELF = 'Nobody can grant leadership access to themselves.';
const REASON = 'Give a reason (up to 1,000 characters).';

export interface GrantScopeInput {
  kind?: unknown;
  departmentIds?: unknown;
  projectIds?: unknown;
}
export interface GrantInput {
  userId?: unknown;
  scope?: GrantScopeInput;
  startsOn?: unknown;
  expiresOn?: unknown;
  reason?: unknown;
}

const SELECT = `
  SELECT g.id, g.user_id AS "userId", u.display_name AS "userName", u.email, u.status AS "accountStatus", g.scope_kind AS "scopeKind",
         to_char(g.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(g.expires_on, 'YYYY-MM-DD') AS "expiresOn", g.reason,
         g.granted_by AS "grantedBy", g.granted_at AS "grantedAt", g.revoked_at AS "revokedAt", g.revoked_by AS "revokedBy", g.revoke_reason AS "revokeReason",
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) ORDER BY lower(d.name), d.id)
                     FROM leadership_grant_departments gd JOIN departments d ON d.id = gd.department_id WHERE gd.grant_id = g.id), '[]') AS departments,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) ORDER BY lower(p.name), p.id)
                     FROM leadership_grant_projects gp JOIN projects p ON p.id = gp.project_id WHERE gp.grant_id = g.id), '[]') AS projects,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'actorId', e.actor_id, 'at', e.at, 'reason', e.reason, 'detail', e.detail) ORDER BY e.at, e.id)
                     FROM leadership_grant_events e WHERE e.grant_id = g.id), '[]') AS events
    FROM leadership_grants g JOIN users u ON u.id = g.user_id`;

/** An Enterprise Administrator's leadership grants (D89): who sees the summary, for which projects, and for how long. */
@Injectable()
export class LeadershipGrantsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
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

  private view(row: any, today: string) {
    return { ...row, state: leadershipGrantState(row, today) };
  }

  private async one(db: Pool | PoolClient, id: string, today: string) {
    const row = (await db.query(`${SELECT} WHERE g.id = $1`, [id])).rows[0];
    return this.view(row, today);
  }

  async list() {
    const today = todayUtc8(this.now());
    const { rows } = await this.pool.query(`${SELECT} ORDER BY g.granted_at DESC, g.id DESC`);
    return { grants: rows.map((r) => this.view(r, today)) };
  }

  private ids(input: unknown, what: string): string[] {
    if (!Array.isArray(input) || input.length === 0 || input.some((v) => typeof v !== 'string' || !UUID.test(v))) {
      throw new BadRequestException(`Choose at least one ${what}.`);
    }
    return [...new Set(input as string[])];
  }

  private async event(c: PoolClient, grantId: string, kind: 'granted' | 'end_changed' | 'revoked', actorId: string, at: Date, reason: string, detail: Record<string, unknown>) {
    await c.query(`INSERT INTO leadership_grant_events (id, grant_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      uuidv7(at.getTime()), grantId, kind, actorId, at, reason, JSON.stringify(detail),
    ]);
  }

  async grant(actor: AuthUser, input: GrantInput) {
    const scope = input.scope && typeof input.scope === 'object' ? input.scope : {};
    const kind = scope.kind as LeadershipScopeKind;
    if (!LEADERSHIP_SCOPE_KINDS.includes(kind)) throw new BadRequestException('Choose the whole organisation, departments or projects.');
    if (typeof input.userId !== 'string' || !UUID.test(input.userId)) throw new BadRequestException('Choose the person the access is for.');
    const userId = input.userId;
    if (userId === actor.id) throw new BadRequestException(SELF);
    if (!isCalendarDate(input.startsOn)) throw new BadRequestException(DATE);
    const startsOn = input.startsOn as string;
    const hasEnd = input.expiresOn !== undefined && input.expiresOn !== null && input.expiresOn !== '';
    if (hasEnd && !isCalendarDate(input.expiresOn)) throw new BadRequestException(DATE);
    const expiresOn = hasEnd ? (input.expiresOn as string) : null;
    if (expiresOn !== null && expiresOn < startsOn) throw new BadRequestException('The end date cannot be before the start date.');
    const departmentIds = kind === 'departments' ? this.ids(scope.departmentIds, 'department') : [];
    const projectIds = kind === 'projects' ? this.ids(scope.projectIds, 'project') : [];
    const reason = readReason(input.reason, 'a reason', { refusal: REASON });
    const at = this.now();
    return this.tx(async (c) => {
      const target = (await c.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [userId])).rows[0];
      if (!target) throw new BadRequestException('Choose an Active account.');
      if (departmentIds.length) {
        const n = (await c.query(`SELECT count(*)::int AS n FROM departments WHERE id = ANY($1::uuid[])`, [departmentIds])).rows[0].n;
        if (n !== departmentIds.length) throw new BadRequestException('Choose existing departments.');
      }
      if (projectIds.length) {
        const n = (await c.query(`SELECT count(*)::int AS n FROM projects WHERE id = ANY($1::uuid[])`, [projectIds])).rows[0].n;
        if (n !== projectIds.length) throw new BadRequestException('Choose existing projects.');
      }
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO leadership_grants (id, user_id, scope_kind, starts_on, expires_on, reason, granted_by, granted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, userId, kind, startsOn, expiresOn, reason, actor.id, at],
      );
      for (const d of departmentIds) await c.query(`INSERT INTO leadership_grant_departments (grant_id, department_id) VALUES ($1, $2)`, [id, d]);
      for (const p of projectIds) await c.query(`INSERT INTO leadership_grant_projects (grant_id, project_id) VALUES ($1, $2)`, [id, p]);
      const detail = { scope: kind, startsOn, expiresOn, departmentIds, projectIds };
      await this.event(c, id, 'granted', actor.id, at, reason, detail);
      await writeAudit(c, { at, action: 'leadership.granted', actorUserId: actor.id, subjectType: 'user', subjectId: userId, detail: { grantId: id, ...detail } });
      return { grant: await this.one(c, id, todayUtc8(at)) };
    });
  }

  private async lock(c: PoolClient, id: string) {
    if (!UUID.test(id)) throw new NotFoundException();
    const g = (
      await c.query(
        `SELECT user_id AS "userId", to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn", revoked_at AS "revokedAt"
           FROM leadership_grants WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0] as { userId: string; startsOn: string; expiresOn: string | null; revokedAt: Date | null } | undefined;
    if (!g) throw new NotFoundException();
    if (g.revokedAt) throw new ConflictException('This access was revoked; grant it again instead.');
    return g;
  }

  /** Sets, moves or removes (null) the last day of a grant. */
  async changeEnd(actor: AuthUser, id: string, expiresOnInput: unknown, reasonInput: unknown) {
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    const expiresOn = expiresOnInput === undefined || expiresOnInput === null || expiresOnInput === '' ? null : expiresOnInput;
    if (expiresOn !== null && !isCalendarDate(expiresOn)) throw new BadRequestException(DATE);
    const at = this.now();
    return this.tx(async (c) => {
      const g = await this.lock(c, id);
      if (expiresOn !== null && (expiresOn as string) < g.startsOn) throw new BadRequestException('The end date cannot be before the start date.');
      await c.query(`UPDATE leadership_grants SET expires_on = $2 WHERE id = $1`, [id, expiresOn]);
      const detail = { previousExpiresOn: g.expiresOn, expiresOn };
      await this.event(c, id, 'end_changed', actor.id, at, reason, detail);
      await writeAudit(c, { at, action: 'leadership.end_changed', actorUserId: actor.id, subjectType: 'user', subjectId: g.userId, detail: { grantId: id, ...detail } });
      return { grant: await this.one(c, id, todayUtc8(at)) };
    });
  }

  /** Ends access at once. */
  async revoke(actor: AuthUser, id: string, reasonInput: unknown) {
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    const at = this.now();
    return this.tx(async (c) => {
      const g = await this.lock(c, id);
      await c.query(`UPDATE leadership_grants SET revoked_at = $2, revoked_by = $3, revoke_reason = $4 WHERE id = $1`, [id, at, actor.id, reason]);
      await this.event(c, id, 'revoked', actor.id, at, reason, {});
      await writeAudit(c, { at, action: 'leadership.revoked', actorUserId: actor.id, subjectType: 'user', subjectId: g.userId, detail: { grantId: id } });
      return { grant: await this.one(c, id, todayUtc8(at)) };
    });
  }
}
