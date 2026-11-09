import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { effectiveCount } from './rules';

type Db = Pool | PoolClient;
type Org = { required: number; projectsMayOverride: boolean };
export type PendingChoice = 'keep' | 'restart';

export const NOT_ALLOWED_PROJECT = 'Approval counts are set by the Administrator.';
export const OWNER_OR_SPONSOR_ONLY = "Only an Owner or Sponsor can set this project's approval count.";
export const RESTART_REASON = 'Review restarted after the approval count changed';

const COUNT_MESSAGE = 'Choose 1, 2 or 3 approvals.';
const isCount = (v: unknown): v is 1 | 2 | 3 => v === 1 || v === 2 || v === 3;

/** How many distinct Owner/Sponsor approvals an authorisation needs, and what happens to requests already waiting. */
@Injectable()
export class PolicyService {
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

  async organisation(db: Db = this.pool, lock = false): Promise<Org> {
    const { rows } = await db.query(
      `SELECT required, projects_may_override AS "projectsMayOverride" FROM approval_policy WHERE id = 1 ${lock ? 'FOR UPDATE' : ''}`,
    );
    return { required: rows[0].required, projectsMayOverride: rows[0].projectsMayOverride };
  }

  /** The count a project's authorisations need now. */
  async effectiveFor(c: Db, projectId: string): Promise<number> {
    const org = await this.organisation(c);
    const { rows } = await c.query(`SELECT required_approvals AS "requiredApprovals" FROM projects WHERE id = $1`, [projectId]);
    return effectiveCount(org, { requiredApprovals: rows[0]?.requiredApprovals ?? null });
  }

  /** Pending requests a change would touch: one project's, or (organisation-wide) those in projects without an active override. */
  async pendingAffected(scope: { projectId?: string }): Promise<number> {
    if (scope.projectId) {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n FROM change_requests WHERE status = 'pending' AND project_id = $1`,
        [scope.projectId],
      );
      return rows[0].n;
    }
    const org = await this.organisation();
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM change_requests r JOIN projects p ON p.id = r.project_id
        WHERE r.status = 'pending' AND ($1::boolean = false OR p.required_approvals IS NULL)`,
      [org.projectsMayOverride],
    );
    return rows[0].n;
  }

  private async history(scopeProjectId: string | null) {
    const { rows } = await this.pool.query(
      `SELECT h.id, h.field, h.old_value AS "oldValue", h.new_value AS "newValue", h.reason, h.pending_choice AS "pendingChoice",
              u.display_name AS actor, h.actor_id AS "actorId", h.at
         FROM approval_policy_changes h JOIN users u ON u.id = h.actor_id
        WHERE h.project_id IS NOT DISTINCT FROM $1
        ORDER BY h.at DESC, h.id DESC`,
      [scopeProjectId],
    );
    return rows;
  }

  async organisationView() {
    return { ...(await this.organisation()), history: await this.history(null) };
  }

  async projectView(user: AuthUser, projectId: string) {
    const ctx = await this.access.context(user, projectId);
    const org = await this.organisation();
    const own = (await this.pool.query(`SELECT required_approvals AS own FROM projects WHERE id = $1`, [projectId])).rows[0].own as number | null;
    return {
      effective: effectiveCount(org, { requiredApprovals: own }),
      own,
      mayEdit: org.projectsMayOverride && ctx.roles.some((r) => r === 'owner' || r === 'sponsor'),
      history: await this.history(projectId),
    };
  }

  private static reason(v: unknown): string {
    if (typeof v !== 'string' || v.trim() === '') throw new BadRequestException('Write a reason for the change.');
    return v.trim();
  }

  private static choice(v: unknown): PendingChoice {
    if (v !== 'keep' && v !== 'restart') throw new BadRequestException('Choose whether to keep or restart the requests already waiting.');
    return v;
  }

  /** { required?, projectsMayOverride?, reason, pending } by the Administrator. */
  async setOrganisation(user: AuthUser, body: Record<string, unknown>): Promise<void> {
    const hasRequired = 'required' in body;
    const hasOverride = 'projectsMayOverride' in body;
    if (!hasRequired && !hasOverride) throw new BadRequestException(COUNT_MESSAGE);
    if (hasRequired && !isCount(body.required)) throw new BadRequestException(COUNT_MESSAGE);
    if (hasOverride && typeof body.projectsMayOverride !== 'boolean') {
      throw new BadRequestException('Say whether projects may set their own count.');
    }
    const reason = PolicyService.reason(body.reason);
    const pending = PolicyService.choice(body.pending);
    const at = this.now();
    await this.tx(async (c) => {
      const old = await this.organisation(c, true);
      const next: Org = {
        required: hasRequired ? (body.required as number) : old.required,
        projectsMayOverride: hasOverride ? (body.projectsMayOverride as boolean) : old.projectsMayOverride,
      };
      const log = async (field: string, from: unknown, to: unknown) =>
        c.query(
          `INSERT INTO approval_policy_changes (id, project_id, field, old_value, new_value, reason, pending_choice, actor_id, at)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8)`,
          [uuidv7(at.getTime()), field, String(from), String(to), reason, pending, user.id, at],
        );
      if (next.required !== old.required) await log('required', old.required, next.required);
      if (next.projectsMayOverride !== old.projectsMayOverride) await log('projects_may_override', old.projectsMayOverride, next.projectsMayOverride);
      await c.query(`UPDATE approval_policy SET required = $1, projects_may_override = $2, updated_by = $3, updated_at = $4 WHERE id = 1`, [
        next.required,
        next.projectsMayOverride,
        user.id,
        at,
      ]);
      await writeAudit(c, { at, action: 'approval_policy.changed', actorUserId: user.id, subjectType: 'organisation', detail: { from: old, to: next, pending } });
      if (pending === 'restart') {
        const { rows } = await c.query(
          `SELECT r.id, r.project_id AS "projectId", p.required_approvals AS "own"
             FROM change_requests r JOIN projects p ON p.id = r.project_id WHERE r.status = 'pending' ORDER BY r.id`,
        );
        for (const r of rows) {
          const was = effectiveCount(old, { requiredApprovals: r.own });
          const now = effectiveCount(next, { requiredApprovals: r.own });
          if (was !== now) await this.restart(c, r.id, r.projectId, now, user.id, at);
        }
      }
    });
  }

  /** { required: 1|2|3|null, reason, pending } by a project's Owner or Sponsor, when the Administrator allows it. */
  async setProject(user: AuthUser, projectId: string, body: Record<string, unknown>): Promise<void> {
    const at = this.now();
    await this.tx(async (c) => {
      const ctx = await this.access.context(user, projectId, c, true);
      if (!ctx.roles.some((r) => r === 'owner' || r === 'sponsor')) throw new ForbiddenException(OWNER_OR_SPONSOR_ONLY);
      const org = await this.organisation(c, true);
      if (!org.projectsMayOverride) throw new ForbiddenException(NOT_ALLOWED_PROJECT);
      const value = body.required;
      if (value !== null && !isCount(value)) throw new BadRequestException(COUNT_MESSAGE);
      const reason = PolicyService.reason(body.reason);
      const pending = PolicyService.choice(body.pending);
      const own = (await c.query(`SELECT required_approvals AS own FROM projects WHERE id = $1`, [projectId])).rows[0].own as number | null;
      if (own === value) return;
      await c.query(`UPDATE projects SET required_approvals = $2 WHERE id = $1`, [projectId, value]);
      await c.query(
        `INSERT INTO approval_policy_changes (id, project_id, field, old_value, new_value, reason, pending_choice, actor_id, at)
         VALUES ($1, $2, 'required', $3, $4, $5, $6, $7, $8)`,
        [uuidv7(at.getTime()), projectId, own === null ? null : String(own), value === null ? null : String(value), reason, pending, user.id, at],
      );
      await writeAudit(c, { at, action: 'approval_policy.project_changed', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { from: own, to: value, pending } });
      if (pending === 'restart') {
        const was = effectiveCount(org, { requiredApprovals: own });
        const now = effectiveCount(org, { requiredApprovals: value });
        if (was !== now) {
          const { rows } = await c.query(`SELECT id FROM change_requests WHERE project_id = $1 AND status = 'pending' ORDER BY id`, [projectId]);
          for (const r of rows) await this.restart(c, r.id, projectId, now, user.id, at);
        }
      }
    });
  }

  /** A new version with the same terms and the new count; approvals given on earlier versions no longer count. */
  private async restart(c: PoolClient, requestId: string, projectId: string, required: number, actorId: string, at: Date): Promise<void> {
    const cur = (await c.query(`SELECT version FROM change_requests WHERE id = $1 FOR UPDATE`, [requestId])).rows[0].version as number;
    const next = cur + 1;
    await c.query(
      `INSERT INTO change_request_versions (request_id, version, terms, reason, author_id, at)
       SELECT request_id, $3, terms, $4, $5, $6 FROM change_request_versions WHERE request_id = $1 AND version = $2`,
      [requestId, cur, next, RESTART_REASON, actorId, at],
    );
    await c.query(`UPDATE change_requests SET version = $2, required_approvals = $3 WHERE id = $1`, [requestId, next, required]);
    await writeAudit(c, { at, action: 'change.review_restarted', actorUserId: actorId, subjectType: 'project', subjectId: projectId, detail: { requestId, version: next, required } });
  }
}
