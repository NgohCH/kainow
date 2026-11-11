import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { isCalendarDate } from '../extraction/due';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { membershipState } from '../projects/membership';
import { ChangesService, type Deliver } from './changes.service';
import { NOT_A_REVIEWER } from './deadline-handlers';

export interface BatchResult {
  requestId: string;
  taskId: string;
  outcome: 'applied' | 'waiting' | 'refused';
  reason?: string;
}

const isManager = (ctx: ProjectContext) => ctx.roles.includes('pm') || ctx.roles.includes('deputy_pm');
const MEMBERSHIP_ORDER = ['active', 'on_hold', 'scheduled', 'expired', 'revoked'] as const;

/** The deadline review screen and its batches of replacement dates (spec §7). */
@Injectable()
export class DeadlineService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly changes: ChangesService,
  ) {}

  private async manager(user: AuthUser, projectId: string, db: Pool | PoolClient = this.pool, lock = false): Promise<ProjectContext> {
    const ctx = await this.access.context(user, projectId, db, lock);
    if (!isManager(ctx)) throw new ForbiddenException(NOT_A_REVIEWER);
    return ctx;
  }

  /** Every marked task with what the preparer needs to choose a date. */
  async view(user: AuthUser, projectId: string) {
    const ctx = await this.manager(user, projectId);
    const { rows } = await this.pool.query(
      `SELECT t.id, t.title, t.depth, t.parent_id AS "parentId", t.status, t.assignee_id AS "assigneeId", u.display_name AS "assigneeName",
              to_char(t.due_on, 'YYYY-MM-DD') AS "previousDueOn", to_char(p.due_on, 'YYYY-MM-DD') AS "parentDueOn",
              (SELECT json_build_object('id', r.id, 'kind', r.kind, 'version', r.version, 'dueOn', v.terms ->> 'dueOn')
                 FROM change_requests r JOIN change_request_versions v ON v.request_id = r.id AND v.version = r.version
                WHERE r.target_kind = 'task' AND r.target_id = t.id AND r.status = 'pending' LIMIT 1) AS "pendingRequest"
         FROM tasks t JOIN users u ON u.id = t.assignee_id LEFT JOIN tasks p ON p.id = t.parent_id
        WHERE t.project_id = $1 AND t.deadline_review_required AND t.status NOT IN ('completed', 'cancelled')
        ORDER BY t.due_on, t.authorised_at, t.id`,
      [projectId],
    );
    const stateOf = (userId: string): string => {
      const states = ctx.rows.filter((m) => m.userId === userId).map((m) => membershipState(m, ctx.today));
      return MEMBERSHIP_ORDER.find((s) => states.includes(s)) ?? 'none';
    };
    return {
      projectStatus: ctx.project.status,
      tasks: rows.map((r) => ({
        id: r.id as string,
        title: r.title as string,
        depth: r.depth as number,
        parentId: r.parentId as string | null,
        status: r.status as string,
        assignee: { id: r.assigneeId as string, displayName: r.assigneeName as string },
        membershipState: stateOf(r.assigneeId),
        previousDueOn: r.previousDueOn as string,
        parentDueOn: r.parentDueOn as string | null,
        pendingRequest: (r.pendingRequest ?? null) as { id: string; kind: string; version: number; dueOn: string | null } | null,
      })),
    };
  }

  /** { tasks: [{ taskId, dueOn }] }: one request per task, sharing a new batch id. All of them or none. */
  async submit(user: AuthUser, projectId: string, input: { tasks?: unknown }) {
    const list = Array.isArray(input.tasks) ? input.tasks : [];
    if (list.length === 0) throw new BadRequestException('Choose a new date for at least one task.');
    if (list.length > 500) throw new BadRequestException('Prepare at most 500 tasks at a time.');
    const items = list.map((x) => {
      const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
      if (typeof o.taskId !== 'string' || !UUID.test(o.taskId)) throw new BadRequestException('Choose the task each date is for.');
      if (typeof o.dueOn !== 'string' || !isCalendarDate(o.dueOn)) throw new BadRequestException('Dates must be in the form YYYY-MM-DD.');
      return { taskId: o.taskId, dueOn: o.dueOn };
    });
    if (new Set(items.map((i) => i.taskId)).size !== items.length) throw new BadRequestException('Give each task one new date.');
    const batchId = uuidv7(this.now().getTime());
    const delivers: Deliver[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.manager(user, projectId, client, true);
      const requests: Array<{ requestId: string; taskId: string; dueOn: string; dueAfterParent: boolean }> = [];
      for (const item of items) {
        const out = await this.changes.submitWithin(
          client, user, projectId,
          { kind: 'deadline_review', targetKind: 'task', targetId: item.taskId, terms: { dueOn: item.dueOn }, batchId },
          {}, (d) => delivers.push(d),
        );
        const parent = (
          await client.query(`SELECT to_char(p.due_on, 'YYYY-MM-DD') AS due FROM tasks t JOIN tasks p ON p.id = t.parent_id WHERE t.id = $1`, [item.taskId])
        ).rows[0] as { due: string } | undefined;
        requests.push({ requestId: out.request.id, taskId: item.taskId, dueOn: item.dueOn, dueAfterParent: !!parent && item.dueOn > parent.due });
      }
      await client.query('COMMIT');
      return { batchId, requests };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Approves every waiting request of a batch that this person may approve, each on its own so one refusal does not
   * undo the others.
   */
  async approveBatch(user: AuthUser, batchId: string): Promise<{ results: BatchResult[] }> {
    if (!UUID.test(batchId)) throw new NotFoundException();
    const { rows } = await this.pool.query(
      `SELECT id, project_id AS "projectId", target_id AS "taskId", version FROM change_requests WHERE batch_id = $1 AND status = 'pending' ORDER BY submitted_at, id`,
      [batchId],
    );
    if (rows.length === 0) {
      const any = (await this.pool.query(`SELECT project_id FROM change_requests WHERE batch_id = $1 LIMIT 1`, [batchId])).rows[0];
      if (!any) throw new NotFoundException();
      await this.access.context(user, any.project_id);
      return { results: [] };
    }
    // Someone who is not an Owner or Sponsor of the project has nothing to approve.
    await this.access.context(user, rows[0].projectId);
    const results: BatchResult[] = [];
    for (const r of rows as Array<{ id: string; taskId: string; version: number }>) {
      try {
        const out = await this.changes.approve(user, r.id, { version: r.version });
        results.push({ requestId: r.id, taskId: r.taskId, outcome: out.applied ? 'applied' : 'waiting' });
      } catch (err) {
        if (err instanceof ForbiddenException && results.length === 0) {
          throw err;
        }
        const reason = err instanceof Error ? ((err as { response?: { message?: unknown } }).response?.message ?? err.message) : 'Not approved.';
        results.push({ requestId: r.id, taskId: r.taskId, outcome: 'refused', reason: String(reason) });
      }
    }
    return { results };
  }
}
