import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { GRANT_READ_ONLY, type ProjectStatus } from '../projects/matrix';
import { membershipState } from '../projects/membership';
import { ChangesService, type Deliver, type RequestView } from './changes.service';
import { RECEIVING_NOT_ACTIVE } from './handover-handler';
import { kindAllowedIn } from './rules';
import { endDelegation, loadClosure, openDelegation, openQuestion, openRisk, openTask, readinessOf } from './closure';

export const FINAL_ACCEPT_OS = 'Only an Owner or Sponsor can accept a risk with no further review.';
export const NOT_PREPARER = 'Only an Owner or Sponsor, or the Project Manager when they have allowed it, can prepare the closure.';
export { RECEIVING_NOT_ACTIVE };
export const NOT_THIS_PROJECT = 'Choose a project other than this one.';
export const ALREADY_HANDED_OVER = 'This risk has already been handed over.';
const DELEGATE_OS = 'Only an Owner or Sponsor can let the Project Manager close this project.';
const REVOKE_OS = "Only an Owner or Sponsor can withdraw the Project Manager's permission to close.";
const NOT_CLOSABLE = 'Closing can be prepared only while the project is Planned, Active or Deferred.';
const CANCEL_WAITING = 'Withdraw the waiting cancellation before choosing again.';

const CLOSABLE: readonly ProjectStatus[] = ['planned', 'active', 'deferred'];
const ALLOWED: Record<string, readonly string[]> = {
  task: ['cancel', 'keep'],
  question: ['resolve', 'withdraw', 'unresolved'],
  risk: ['handover', 'final_accept'],
};
const TABLE = { task: 'tasks', question: 'questions', risk: 'risks' } as const;

const text = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC').trim() : '');
const isOwnerOrSponsor = (ctx: ProjectContext) => ctx.roles.some((r) => r === 'owner' || r === 'sponsor');

/**
 * Closing a project (spec §6, §6.1): a disposition for every open task, question and risk, chosen over as many
 * sittings as needed, and an Owner's or Sponsor's permission for the Project Manager to prepare and close.
 */
@Injectable()
export class ClosureService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly changes: ChangesService,
  ) {}

  /** An Owner or Sponsor, or the Project Manager while an open delegation names them. */
  static async mayPrepare(db: Pool | PoolClient, ctx: ProjectContext, userId: string): Promise<boolean> {
    if (!CLOSABLE.includes(ctx.project.status)) return false;
    if (isOwnerOrSponsor(ctx)) return true;
    if (!ctx.roles.includes('pm')) return false;
    return (await openDelegation(db, ctx.project.id))?.pmUserId === userId;
  }

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

  /** The project, locked, for someone with a role in it; a grant holder reads but never changes (403). */
  private async actor(c: PoolClient, user: AuthUser, projectId: string): Promise<ProjectContext> {
    const ctx = await this.access.load(projectId, user, c, true);
    if (!ctx) throw new NotFoundException();
    if (ctx.roles.length === 0) {
      if (ctx.grantKinds.length === 0) throw new NotFoundException();
      throw new ForbiddenException(GRANT_READ_ONLY);
    }
    return ctx;
  }

  /** What is open, what has been chosen for it, whether Close may go ahead, and who may prepare it. */
  async view(user: AuthUser, projectId: string) {
    const ctx = await this.access.authorize(user, 'project.view', projectId);
    const loaded = await loadClosure(this.pool, projectId);
    const readiness = readinessOf(loaded);
    const all = [...loaded.tasks.map((x) => x.id), ...loaded.questions.map((x) => x.id), ...loaded.risks.map((x) => x.id)];
    const pending = (
      await this.pool.query(
        `SELECT id, kind, project_id AS "projectId", target_id AS "targetId", batch_id AS "batchId" FROM change_requests WHERE status = 'pending' AND target_id = ANY($1::uuid[])`,
        [all],
      )
    ).rows as Array<{ id: string; kind: string; projectId: string; targetId: string; batchId: string | null }>;
    const with_ = <T extends { id: string }>(kind: string, rows: T[]) =>
      rows.map((r) => {
        const d = loaded.dispositions.find((x) => x.recordKind === kind && x.recordId === r.id);
        const p = pending.find((x) => x.targetId === r.id);
        const missing = readiness.missing.find((m) => m.kind === kind && m.id === r.id);
        return {
          ...r,
          disposition: d
            ? { disposition: d.disposition, reason: d.reason, affectsDelivery: d.affectsDelivery, handoverProjectId: d.handoverProjectId, chosenBy: d.chosenBy, chosenAt: d.chosenAt }
            : null,
          pendingRequest: p ? { id: p.id, kind: p.kind, projectId: p.projectId, batchId: p.batchId } : null,
          /** Why this item still stops Close (a declined hand-over or a rejected cancellation says so), else null. */
          why: missing?.why ?? null,
        };
      });
    const delegation = await openDelegation(this.pool, projectId);
    return {
      items: {
        tasks: with_('task', loaded.tasks.filter(openTask)),
        questions: with_('question', loaded.questions.filter(openQuestion)),
        risks: with_('risk', loaded.risks.filter(openRisk)),
      },
      readiness,
      delegation: delegation ? { pm: delegation.pm, pmUserId: delegation.pmUserId, by: delegation.by, reason: delegation.reason, at: delegation.at } : null,
      mayPrepare: ctx.roles.length > 0 && (await ClosureService.mayPrepare(this.pool, ctx, user.id)),
    };
  }

  /** { recordKind, recordId, disposition, reason, affectsDelivery?, handoverProjectId? } */
  async dispose(user: AuthUser, projectId: string, input: Record<string, unknown>) {
    const recordKind = input.recordKind as keyof typeof TABLE;
    if (!(typeof recordKind === 'string' && recordKind in ALLOWED)) throw new BadRequestException('Choose a task, question or risk.');
    const disposition = input.disposition as string;
    if (!ALLOWED[recordKind].includes(disposition)) throw new BadRequestException('Choose a disposition for this item.');
    const recordId = typeof input.recordId === 'string' ? input.recordId : '';
    if (!UUID.test(recordId)) throw new NotFoundException();
    const reason = text(input.reason);
    if (reason === '') throw new BadRequestException('A reason is required.');
    const affectsDelivery = disposition === 'unresolved' && input.affectsDelivery === true;
    const at = this.now();
    const deliveries: Deliver[] = [];
    const out = await this.tx(async (c) => {
      const ctx = await this.actor(c, user, projectId);
      if (!CLOSABLE.includes(ctx.project.status)) throw new ConflictException(NOT_CLOSABLE);
      if (!(await ClosureService.mayPrepare(c, ctx, user.id))) throw new ForbiddenException(NOT_PREPARER);
      if (disposition === 'final_accept' && !isOwnerOrSponsor(ctx)) throw new ForbiddenException(FINAL_ACCEPT_OS);
      // Lock order matches an acceptance (request, then risk), so the two never wait on each other.
      if (recordKind === 'risk') await c.query(`SELECT 1 FROM change_requests WHERE kind = 'risk_handover' AND target_id = $1 AND status = 'pending' FOR UPDATE`, [recordId]);
      const rec = (
        await c.query(`SELECT id, status, to_char(${recordKind === 'risk' ? 'review_on' : 'NULL::date'}, 'YYYY-MM-DD') AS "reviewOn" FROM ${TABLE[recordKind]} WHERE id = $1 AND project_id = $2 FOR UPDATE`, [
          recordId, projectId,
        ])
      ).rows[0] as { id: string; status: string; reviewOn: string | null } | undefined;
      if (!rec) throw new NotFoundException();
      const open = recordKind === 'task' ? openTask(rec) : recordKind === 'question' ? openQuestion(rec) : openRisk(rec);
      if (!open) throw new ConflictException('This item is already finished.');
      if (recordKind === 'risk') {
        const done = await c.query(`SELECT 1 FROM change_requests WHERE kind = 'risk_handover' AND target_id = $1 AND status = 'authorised'`, [recordId]);
        if (done.rowCount) throw new ConflictException(ALREADY_HANDED_OVER);
      }

      let handoverProjectId: string | null = null;
      let request: RequestView | undefined;
      let offer: { id: string; kind: string; status: string; projectId: string } | undefined;
      if (recordKind === 'task') {
        const waiting = await c.query(
          `SELECT 1 FROM change_requests WHERE kind = 'cancel_task' AND target_kind = 'task' AND target_id = $1 AND status = 'pending' AND batch_id = $2`,
          [recordId, projectId],
        );
        if (waiting.rowCount && disposition !== 'cancel') throw new ConflictException(CANCEL_WAITING);
      }
      if (disposition === 'cancel') {
        // Every unfinished subtask has its own disposition, so cancelling a task here leaves its subtasks to theirs.
        const below = (
          await c.query(
            `WITH RECURSIVE below AS (SELECT id, status FROM tasks WHERE parent_id = $1 UNION ALL SELECT t.id, t.status FROM tasks t JOIN below b ON t.parent_id = b.id)
             SELECT id FROM below WHERE status NOT IN ('completed', 'cancelled')`,
            [recordId],
          )
        ).rows as Array<{ id: string }>;
        const subtasks = Object.fromEntries(below.map((s) => [s.id, 'keep']));
        const submitted = await this.changes.submitWithin(
          c, user, projectId,
          { kind: 'cancel_task', targetKind: 'task', targetId: recordId, terms: { reason, subtasks }, batchId: projectId },
          { approveNow: true },
          (d) => deliveries.push(d),
        );
        request = submitted.request;
      } else if (disposition === 'handover') {
        if (!kindAllowedIn('risk_handover', ctx.project.status, 'submit')) {
          throw new ConflictException(`This change cannot be proposed while the project is ${ctx.project.status[0].toUpperCase()}${ctx.project.status.slice(1)}.`);
        }
        if (typeof input.handoverProjectId !== 'string' || input.handoverProjectId === '') throw new BadRequestException('Choose the project to receive the risk.');
        if (input.handoverProjectId === projectId) throw new ConflictException(NOT_THIS_PROJECT);
        // Only a project the closer can see; any other is answered as if it did not exist.
        if (!UUID.test(input.handoverProjectId) || !(await this.access.visibleProjectIds(user.id, c)).includes(input.handoverProjectId)) throw new NotFoundException();
        handoverProjectId = input.handoverProjectId;
        const receiving = (await c.query(`SELECT status FROM projects WHERE id = $1`, [handoverProjectId])).rows[0];
        if (receiving?.status !== 'active') throw new ConflictException(RECEIVING_NOT_ACTIVE);
      }
      if (recordKind === 'risk') {
        // A new choice replaces any offer still waiting for the receiving project.
        await this.changes.withdrawHandovers(c, user, recordId, 'The closing project chose another disposition.', at);
        if (handoverProjectId !== null) {
          offer = await this.changes.offerHandover(c, user, { riskId: recordId, fromProjectId: projectId, toProjectId: handoverProjectId, reason }, at);
        }
      }

      await c.query(
        `UPDATE closure_dispositions SET replaced_at = $4 WHERE project_id = $1 AND record_kind = $2 AND record_id = $3 AND replaced_at IS NULL AND NOT final`,
        [projectId, recordKind, recordId, at],
      );
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO closure_dispositions (id, project_id, record_kind, record_id, disposition, reason, affects_delivery, handover_project_id, chosen_by, chosen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, projectId, recordKind, recordId, disposition, reason, affectsDelivery, handoverProjectId, user.id, at],
      );
      await writeAudit(c, {
        at,
        action: 'closure.disposition',
        actorUserId: user.id,
        subjectType: 'project',
        subjectId: projectId,
        detail: { recordKind, recordId, disposition, ...(request ? { requestId: request.id } : {}), ...(offer ? { requestId: offer.id, handoverProjectId } : {}) },
      });
      return {
        disposition: { id, recordKind, recordId, disposition, reason, affectsDelivery, handoverProjectId },
        ...(request ? { request } : offer ? { request: offer } : {}),
        readiness: readinessOf(await loadClosure(c, projectId)),
      };
    });
    for (const d of deliveries) await d().catch(() => false);
    return out;
  }

  /** { reason } by an Owner or Sponsor: the current Project Manager may prepare and close. */
  async delegate(user: AuthUser, projectId: string, input: Record<string, unknown>) {
    const reason = text(input.reason);
    const at = this.now();
    await this.tx(async (c) => {
      const ctx = await this.actor(c, user, projectId);
      if (!isOwnerOrSponsor(ctx)) throw new ForbiddenException(DELEGATE_OS);
      if (reason === '') throw new BadRequestException('A reason is required.');
      if (!CLOSABLE.includes(ctx.project.status)) throw new ConflictException(NOT_CLOSABLE);
      const pm = ctx.rows.find((m) => m.role === 'pm' && membershipState(m, ctx.today) === 'active');
      if (!pm) throw new ConflictException('The project has no active Project Manager.');
      if (await openDelegation(c, projectId)) throw new ConflictException('The Project Manager is already allowed to close this project.');
      const id = uuidv7(at.getTime());
      await c.query(`INSERT INTO closure_delegations (id, project_id, pm_user_id, delegated_by, reason, at) VALUES ($1, $2, $3, $4, $5, $6)`, [
        id, projectId, pm.userId, user.id, reason, at,
      ]);
      await writeAudit(c, { at, action: 'closure.delegated', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { delegationId: id, pmUserId: pm.userId } });
    });
    return this.view(user, projectId);
  }

  /** By any Owner or Sponsor: the Project Manager may no longer prepare or close. */
  async revoke(user: AuthUser, projectId: string) {
    const at = this.now();
    await this.tx(async (c) => {
      const ctx = await this.actor(c, user, projectId);
      if (!isOwnerOrSponsor(ctx)) throw new ForbiddenException(REVOKE_OS);
      if (!(await endDelegation(c, projectId, user.id, at, 'revoked'))) {
        throw new ConflictException('The Project Manager has not been allowed to close this project.');
      }
    });
    return this.view(user, projectId);
  }
}
