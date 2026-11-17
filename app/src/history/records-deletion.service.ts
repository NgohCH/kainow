import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { onMaterialRemoved } from '../assist/removal';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { grantGivesAccess } from '../projects/grants';
import { GRANT_READ_ONLY, PROJECT_MATRIX } from '../projects/matrix';
import { effectiveRoles, membershipState } from '../projects/membership';
import { HELD } from './deleted-sql';
import { openRecordDelegation } from './delegation';
import { type RecordKind, RECORD_KINDS, deletionRefusal } from './final-states';

export const ALREADY_DELETED_RECORD = 'This record is already deleted.';
export const NOT_DELETED_RECORD = 'This record is not deleted.';
export const OPEN_SUBTASK = 'Cancel or complete every subtask before deleting this task.';
export const PARENT_DELETED = 'Restore the parent task first.';

const TABLE: Readonly<Record<RecordKind, string>> = { task: 'tasks', decision: 'decisions', question: 'questions', risk: 'risks' };

/**
 * Who may delete and restore records in this project (spec 4.1): an Owner or Sponsor, or the Project Manager while an
 * Owner or Sponsor has delegated it to them (D83). `delegatedPmId` is the PM named on the project's open delegation,
 * if any; until delegations exist (Task 4) callers pass nothing. The project state is checked separately.
 */
export function canActOnRecords(ctx: ProjectContext, userId: string, delegatedPmId: string | null = null): 'owner_sponsor' | 'delegated_pm' | null {
  if (ctx.roles.some((r) => r === 'owner' || r === 'sponsor')) return 'owner_sponsor';
  if (delegatedPmId !== null && delegatedPmId === userId && ctx.roles.includes('pm')) return 'delegated_pm';
  return null;
}

/**
 * Whether this person may take `action` on records of this project now: the matrix's project states, and the people
 * allowed by canActOnRecords (an Owner or Sponsor, or the PM under the open delegation). The matrix's role list is not
 * used, because the delegated PM is not in it. The routes and the History list both ask here so they cannot drift.
 */
export async function mayActOnRecords(db: Pool | PoolClient, ctx: ProjectContext, userId: string, action: 'record.delete' | 'record.restore'): Promise<'owner_sponsor' | 'delegated_pm' | null> {
  if (ctx.roles.length === 0 || !PROJECT_MATRIX[action].states.includes(ctx.project.status)) return null;
  return canActOnRecords(ctx, userId) ?? canActOnRecords(ctx, userId, (await openRecordDelegation(db, ctx.project.id))?.pmUserId ?? null);
}

interface Locked {
  ctx: ProjectContext;
  kind: RecordKind;
  id: string;
  status: string;
  deleted: boolean;
  heldCaseId: string | null;
  parentId: string | null;
  noFurtherReview: boolean;
  as: 'owner_sponsor' | 'delegated_pm';
}

/**
 * Deleting and restoring authorised records: tasks (with their subtasks), decisions, questions and risks (history
 * spec 4.3, 4.4). Nothing is removed: the record keeps its status, gains who, when and why, and its events table
 * records the act. A Deleted record leaves every list, count, search, digest and AI material.
 */
@Injectable()
export class RecordsDeletionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  private async inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * When the PM acts under the delegation, each active Owner and Sponsor gets an in-app notice: who, what kind of
   * record and which project, nothing of the record's title or the reason.
   */
  private async tellOwners(db: PoolClient, r: Locked, what: 'deleted' | 'restored', user: AuthUser, at: Date): Promise<void> {
    if (r.as !== 'delegated_pm') return;
    const name = (await db.query<{ name: string }>(`SELECT display_name AS name FROM users WHERE id = $1`, [user.id])).rows[0].name;
    const project = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [r.ctx.project.id])).rows[0].name;
    const ids = new Set(r.ctx.rows.filter((m) => (m.role === 'owner' || m.role === 'sponsor') && membershipState(m, r.ctx.today) === 'active').map((m) => m.userId));
    for (const userId of [...ids].sort()) {
      await db.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, summary, link, created_at, email_off) VALUES ($1, $2, $3, 'record_deletion_by_pm', $4, $5, $6, true)`,
        [uuidv7(at.getTime()), userId, r.ctx.project.id, `${name} ${what} a ${r.kind} in ${project}`, `#/projects/${r.ctx.project.id}`, at],
      );
    }
  }

  /**
   * The record, locked, for someone who may act on it. 404 for an unknown kind or id and for anyone outside the
   * project (records have no audience of their own); then 403: a grant holder (read-only), anyone but an Owner, a
   * Sponsor or a delegated PM, or a project state the action does not allow.
   *
   * Locks: the project row (as every record change takes it), then the record row; the caller then locks subtasks in
   * id order, then the removal hook locks answers and drafts.
   */
  private async locked(db: PoolClient, user: AuthUser, kindIn: string, id: string, action: 'record.delete' | 'record.restore'): Promise<Locked> {
    const kind = kindIn as RecordKind;
    if (!RECORD_KINDS.includes(kind) || !UUID.test(id)) throw new NotFoundException();
    const table = TABLE[kind];
    const projectId = (await db.query<{ projectId: string }>(`SELECT project_id AS "projectId" FROM ${table} WHERE id = $1`, [id])).rows[0]?.projectId;
    if (!projectId) throw new NotFoundException();
    const ctx = await this.access.authorize(user, 'project.view', projectId, db, true);
    const row = (
      await db.query<{ status: string; deleted: boolean; heldCaseId: string | null; parentId: string | null; noFurtherReview: boolean }>(
        `SELECT status, deleted_at IS NOT NULL AS deleted, held_case_id AS "heldCaseId",
                ${kind === 'task' ? 'parent_id' : 'NULL::uuid'} AS "parentId",
                ${kind === 'risk' ? "status = 'accepted' AND review_on IS NULL" : 'false'} AS "noFurtherReview"
           FROM ${table} WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (ctx.roles.length === 0) throw new ForbiddenException(GRANT_READ_ONLY);
    const as = await mayActOnRecords(db, ctx, user.id, action);
    if (as === null) throw new ForbiddenException(PROJECT_MATRIX[action].refusal);
    return { ctx, kind, id, as, ...row };
  }

  /**
   * Delete (spec 4.3): only from a final state, with a reason, while the project is Draft, Planned or Active. A task
   * takes its subtasks (and theirs) with it; every one not already Deleted must be final too, and each records
   * `deleted_with` = this task. Subtasks deleted earlier on their own keep their own deletion. In the same transaction
   * the removal hook treats the records' snapshots as removed AI material (`record_deleted`).
   */
  async delete(user: AuthUser, kind: string, id: string, body: { reason?: unknown }): Promise<{ kind: RecordKind; id: string; deleted: true }> {
    const out = await this.inTransaction(async (db) => {
      const r = await this.locked(db, user, kind, id, 'record.delete');
      if (r.heldCaseId) throw new ConflictException(HELD);
      if (r.deleted) throw new ConflictException(ALREADY_DELETED_RECORD);
      const refusal = deletionRefusal(r.kind, { status: r.status, noFurtherReview: r.noFurtherReview });
      if (refusal) throw new ConflictException(refusal);
      const below = r.kind === 'task' ? await this.subtasks(db, r.id) : [];
      const live = below.filter((s) => !s.deleted);
      if (live.some((s) => s.heldCaseId)) throw new ConflictException(HELD);
      if (live.some((s) => deletionRefusal('task', s) !== null)) throw new ConflictException(OPEN_SUBTASK);
      const reason = readReason(body.reason);
      const at = this.now();
      await db.query(`UPDATE ${TABLE[r.kind]} SET deleted_at = $2, deleted_by = $3, delete_reason = $4 WHERE id = $1`, [r.id, at, user.id, reason]);
      await this.event(db, r.kind, r.id, 'deleted', r.status, user, reason, at);
      for (const s of live) {
        await db.query(`UPDATE tasks SET deleted_at = $2, deleted_by = $3, delete_reason = $4, deleted_with = $5 WHERE id = $1`, [s.id, at, user.id, reason, r.id]);
        await this.event(db, 'task', s.id, 'deleted', s.status, user, reason, at);
      }
      await onMaterialRemoved(db, { records: [{ kind: r.kind, id: r.id }, ...live.map((s) => ({ kind: 'task' as const, id: s.id }))] }, 'record_deleted', at);
      await this.tellOwners(db, r, 'deleted', user, at);
      await writeAudit(db, {
        at, action: 'record.deleted', actorUserId: user.id, subjectType: r.kind, subjectId: r.id,
        detail: { projectId: r.ctx.project.id, subtasks: live.length, as: r.as },
      });
      return { kind: r.kind, id: r.id, deleted: true as const };
    });
    return out;
  }

  /**
   * Who will be able to see the record again (spec 4.3, 4.4): records have no audience of their own, so it is every
   * current participant (an Active membership today) and every grant holder whose grant gives access today, by name.
   */
  async restorePreview(user: AuthUser, kind: string, id: string): Promise<{ names: string[] }> {
    return this.inTransaction(async (db) => {
      const r = await this.locked(db, user, kind, id, 'record.restore');
      if (r.heldCaseId) throw new ConflictException(HELD);
      if (!r.deleted) throw new ConflictException(NOT_DELETED_RECORD);
      if (await this.parentDeleted(db, r)) throw new ConflictException(PARENT_DELETED);
      const { ctx } = r;
      const userIds = new Set<string>();
      for (const m of ctx.rows) if (effectiveRoles(ctx.rows, m.userId, ctx.today).length > 0) userIds.add(m.userId);
      for (const g of ctx.grants) if (grantGivesAccess(g, ctx.today, ctx.rows)) userIds.add(g.userId);
      const { rows } = await db.query<{ name: string }>(`SELECT display_name AS name FROM users WHERE id = ANY($1::uuid[])`, [[...userIds]]);
      return { names: rows.map((u) => u.name).sort((a, b) => a.localeCompare(b)) };
    });
  }

  /**
   * Restore (spec 4.4): in any project state, with a reason. The record returns with its status and history; a task
   * brings back exactly the subtasks deleted with it. A subtask waits for its parent. Nothing restarts: no AI, email,
   * notification, reminder, deadline change or invitation, and withdrawn AI answers stay withdrawn.
   */
  async restore(user: AuthUser, kind: string, id: string, body: { reason?: unknown }): Promise<{ kind: RecordKind; id: string; deleted: false; status: string }> {
    return this.inTransaction(async (db) => {
      const r = await this.locked(db, user, kind, id, 'record.restore');
      if (r.heldCaseId) throw new ConflictException(HELD);
      if (!r.deleted) throw new ConflictException(NOT_DELETED_RECORD);
      if (await this.parentDeleted(db, r)) throw new ConflictException(PARENT_DELETED);
      const withIt =
        r.kind === 'task'
          ? (await db.query<{ id: string; status: string }>(`SELECT id, status FROM tasks WHERE deleted_with = $1 ORDER BY id FOR UPDATE`, [r.id])).rows
          : [];
      const reason = readReason(body.reason);
      const at = this.now();
      const clear = `deleted_at = NULL, deleted_by = NULL, delete_reason = NULL${r.kind === 'task' ? ', deleted_with = NULL' : ''}`;
      await db.query(`UPDATE ${TABLE[r.kind]} SET ${clear} WHERE id = $1`, [r.id]);
      await this.event(db, r.kind, r.id, 'restored', r.status, user, reason, at);
      for (const s of withIt) {
        await db.query(`UPDATE tasks SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, deleted_with = NULL WHERE id = $1`, [s.id]);
        await this.event(db, 'task', s.id, 'restored', s.status, user, reason, at);
      }
      await this.tellOwners(db, r, 'restored', user, at);
      await writeAudit(db, {
        at, action: 'record.restored', actorUserId: user.id, subjectType: r.kind, subjectId: r.id,
        detail: { projectId: r.ctx.project.id, subtasks: withIt.length, as: r.as },
      });
      return { kind: r.kind, id: r.id, deleted: false as const, status: r.status };
    });
  }

  /** Every task below this one (any depth), locked in id order. */
  private async subtasks(db: PoolClient, taskId: string): Promise<Array<{ id: string; status: string; deleted: boolean; heldCaseId: string | null }>> {
    const ids = (
      await db.query<{ id: string }>(
        `WITH RECURSIVE below AS (SELECT id FROM tasks WHERE parent_id = $1 UNION ALL SELECT t.id FROM tasks t JOIN below b ON t.parent_id = b.id)
         SELECT id FROM below`,
        [taskId],
      )
    ).rows.map((x) => x.id);
    if (ids.length === 0) return [];
    return (
      await db.query(
        `SELECT id, status, deleted_at IS NOT NULL AS deleted, held_case_id AS "heldCaseId" FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [ids],
      )
    ).rows;
  }

  private async parentDeleted(db: PoolClient, r: Locked): Promise<boolean> {
    if (r.kind !== 'task' || r.parentId === null) return false;
    return (await db.query(`SELECT 1 FROM tasks WHERE id = $1 AND deleted_at IS NOT NULL`, [r.parentId])).rowCount === 1;
  }

  /** The deletion or restoration in the record's own history, with its reason; the status is unchanged. */
  private async event(db: PoolClient, kind: RecordKind, id: string, what: 'deleted' | 'restored', status: string, user: AuthUser, reason: string, at: Date): Promise<void> {
    if (kind === 'task') {
      await db.query(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at) VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`, [
        uuidv7(at.getTime()), id, what, status, reason, user.id, at,
      ]);
    } else {
      await db.query(
        `INSERT INTO record_events (id, record_kind, record_id, kind, from_status, to_status, note, actor_id, at) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
        [uuidv7(at.getTime()), kind, id, what, status, reason, user.id, at],
      );
    }
  }
}
