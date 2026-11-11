import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { type RequestView, ChangesService } from '../changes/changes.service';
import { AlreadyAuthorised, authoriseProposalHandler } from '../changes/handlers';
import { decisionHandlers } from '../changes/decision-handlers';
import { lockPendingAuthorisation, rejectPendingAuthorisation } from '../changes/end-pending';
import { deadlineHandlers } from '../changes/deadline-handlers';
import { handoverHandler } from '../changes/handover-handler';
import { taskHandlers } from '../changes/task-handlers';
import { PG_POOL } from '../db/database.module';
import { isCalendarDate, readDue } from '../extraction/due';
import { ExtractionService } from '../extraction/extraction.service';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { InvitationsService } from '../projects/invitations.service';
import { GRANT_READ_ONLY } from '../projects/matrix';
import { checkNewAppointment } from '../projects/memberships.service';
import { membershipState, todayUtc8 } from '../projects/membership';
import { type QuestionAction, type RiskAction, SEVERITIES, type Severity, questionTransition, riskTransition } from './lifecycles';
import { TASK_ACTIONS, type TaskAction, type TaskStatus, ancestorsToReopen, parentMayComplete, taskIndicators, taskTransition } from './tasks';

export const MISSING_ACCOUNTABILITY = 'The project is missing a required role, so proposals cannot be approved until it is repaired.';
export const NEEDS_ASSIGNEE = 'A task needs one assignee and a due date before it can be authorised.';
export const HUMAN_LABEL = 'Human proposal — no discussion source';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RecordKind = 'task' | 'decision' | 'question' | 'risk';
export interface Created {
  record: { kind: RecordKind; id: string; subtaskIds?: string[] };
  delivered?: boolean;
}

/** What authorising a proposal answers: the record (made now, or already), or the request still waiting for approvers. */
export type Authorised = (Created & { created: boolean }) | { request: RequestView; created: false; waiting: true };

/** What a human proposal or an approved extraction item contributes to a record. */
export interface Content {
  kind: 'action' | 'decision' | 'question' | 'risk';
  text: string;
  owner: string | null;
}

export const NEEDS_NEW_DATE = 'This task needs a new authorised due date first.';
/** The task actions refused on a task marked for deadline review. */
const MARKED_REFUSES: readonly TaskAction[] = ['start', 'unblock', 'complete'];

type Origin = { itemId: string } | { proposalId: string };
const originColumns = (o: Origin) => ('itemId' in o ? { item: o.itemId, proposal: null } : { item: null, proposal: o.proposalId });

/** People who currently belong to the project (Scheduled or Active), the ones a record can name. */
const isProjectPerson = (ctx: ProjectContext, userId: unknown): userId is string =>
  typeof userId === 'string' && UUID.test(userId) && ctx.rows.some((m) => m.userId === userId && ['scheduled', 'active'].includes(membershipState(m, ctx.today)));

/** Whether someone holds an Active membership of any role in the project today. */
export const isActiveIn = (ctx: ProjectContext, userId: string): boolean =>
  ctx.rows.some((m) => m.userId === userId && membershipState(m, ctx.today) === 'active');

@Injectable()
export class RecordsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly extraction: ExtractionService,
    private readonly invitations: InvitationsService,
    private readonly changes: ChangesService,
  ) {
    changes.register(authoriseProposalHandler({ records: this, extraction }));
    for (const h of taskHandlers({ records: this })) changes.register(h);
    for (const h of decisionHandlers()) changes.register(h);
    changes.register(handoverHandler());
    for (const h of deadlineHandlers()) changes.register(h);
  }

  async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
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

  /** The record a proposal already made, if any (a task counts by its top-level row). */
  async existingRecord(c: PoolClient | Pool, origin: Origin): Promise<Created['record'] | null> {
    const col = 'itemId' in origin ? 'origin_item_id' : 'origin_proposal_id';
    const id = 'itemId' in origin ? origin.itemId : origin.proposalId;
    const { rows } = await c.query(
      `SELECT 'task' AS kind, id FROM tasks WHERE ${col} = $1 AND depth = 0
       UNION ALL SELECT 'decision', id FROM decisions WHERE ${col} = $1
       UNION ALL SELECT 'question', id FROM questions WHERE ${col} = $1
       UNION ALL SELECT 'risk', id FROM risks WHERE ${col} = $1`,
      [id],
    );
    return rows[0] ? { kind: rows[0].kind, id: rows[0].id } : null;
  }

  /** Authorise one extraction proposal: approve it and create its record, once (V1.0 proposals §7), through an authorise_proposal request. */
  async authoriseItem(user: AuthUser, runId: string, itemId: string, body: Record<string, unknown>): Promise<Authorised> {
    if (!UUID.test(itemId)) throw new NotFoundException();
    const projectId = await this.access.projectOfRun(runId);
    const item = (await this.pool.query(`SELECT run_id FROM extraction_items WHERE id = $1`, [itemId])).rows[0];
    if (!item || item.run_id !== runId) throw new NotFoundException();
    return this.authoriseThrough(user, projectId, 'extraction_item', itemId, body);
  }

  /**
   * The authoriser's click submits an authorise_proposal request and is its first approval. When that completes the
   * count the record is made at once (2a's 201); otherwise the request waits for more approvers (202). A proposal
   * that already has its record answers with it (200).
   */
  private async authoriseThrough(user: AuthUser, projectId: string, targetKind: 'extraction_item' | 'human_proposal', targetId: string, body: Record<string, unknown>): Promise<Authorised> {
    try {
      const out = await this.changes.submit(user, projectId, { kind: 'authorise_proposal', targetKind, targetId, terms: body }, { approveNow: true });
      if (out.applied?.record) {
        return { record: out.applied.record, created: true, ...(out.applied.delivered !== undefined ? { delivered: out.applied.delivered } : {}) };
      }
      return { request: out.request, created: false, waiting: true };
    } catch (err) {
      if (err instanceof AlreadyAuthorised) return { record: err.record, created: false };
      throw err;
    }
  }

  /** Resolve a task assignee: a project person, or an eligible email (account made Invited, invitation issued). */
  async assignee(c: PoolClient, ctx: ProjectContext, user: AuthUser, body: Record<string, unknown>, at: Date) {
    if (body.assigneeId !== undefined && body.assigneeId !== null && body.assigneeId !== '') {
      if (!isProjectPerson(ctx, body.assigneeId)) throw new BadRequestException(NEEDS_ASSIGNEE);
      return { userId: body.assigneeId as string, invitationId: null as string | null, deliver: null as null | (() => Promise<boolean>) };
    }
    const email = typeof body.inviteEmail === 'string' ? body.inviteEmail.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new BadRequestException(NEEDS_ASSIGNEE);
    const existing = (await c.query(`SELECT id, status FROM users WHERE email = $1`, [email])).rows[0];
    if (existing && isProjectPerson(ctx, existing.id)) return { userId: existing.id as string, invitationId: null, deliver: null };
    if (existing?.status === 'disabled') throw new BadRequestException('That account is disabled; an Administrator must enable it first.');
    if (existing) {
      // The same checks as inviting from the People tab: an expired or held Member is extended or restored there.
      try {
        checkNewAppointment(ctx, { userId: existing.id, role: 'member', startsOn: ctx.today, expiresOn: null, revokedAt: null });
      } catch {
        throw new ConflictException('This person already has a Member appointment here; extend or restore it on the People tab, then choose them.');
      }
    }
    const inv = await this.invitations.issueMemberInvitation(c, ctx.project.id, email, user.id, ctx.today, at);
    let userId = existing?.id as string | undefined;
    if (!userId) {
      // The assignee needs an account to be named on the task; it stays Invited until their first sign-in.
      userId = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'member', 'invited', $4, $4)`,
        [userId, email, email.split('@')[0], at],
      );
      await writeAudit(c, { at, action: 'user.created_for_task', actorUserId: user.id, subjectType: 'user', subjectId: userId });
    }
    return { userId, invitationId: inv.id, deliver: inv.deliver };
  }

  dueOf(v: unknown): string {
    if (typeof v !== 'string' || !isCalendarDate(v)) throw new BadRequestException(NEEDS_ASSIGNEE);
    return v;
  }

  async insertTask(
    c: PoolClient,
    ctx: ProjectContext,
    t: { parentId: string | null; depth: number; title: string; assigneeId: string; ownerAsWritten: string | null; dueOn: string; invitationId: string | null; origin: Origin | null; followsTaskId?: string | null },
    user: AuthUser,
    at: Date,
    note: string | null,
  ): Promise<string> {
    const id = uuidv7(at.getTime());
    const o = t.origin ? originColumns(t.origin) : { item: null, proposal: null };
    await c.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, owner_as_written, due_on, invitation_id, origin_item_id, origin_proposal_id, authorised_by, authorised_at, follows_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, ctx.project.id, t.parentId, t.depth, t.title, t.assigneeId, t.ownerAsWritten, t.dueOn, t.invitationId, o.item, o.proposal, user.id, at, t.followsTaskId ?? null],
    );
    await c.query(`INSERT INTO task_events (id, task_id, kind, to_status, note, actor_id, at) VALUES ($1, $2, 'authorised', 'not_started', $3, $4, $5)`, [
      uuidv7(at.getTime()), id, note, user.id, at,
    ]);
    return id;
  }

  /** Create the record for an approved proposal, in the caller's transaction. */
  async createFrom(
    c: PoolClient,
    ctx: ProjectContext,
    origin: Origin,
    content: Content,
    body: Record<string, unknown>,
    user: AuthUser,
    at: Date,
  ): Promise<{ record: Created['record']; deliver: (() => Promise<boolean>) | null }> {
    const o = originColumns(origin);
    const id = uuidv7(at.getTime());
    let record: Created['record'];
    let deliver: (() => Promise<boolean>) | null = null;
    switch (content.kind) {
      case 'action': {
        const who = await this.assignee(c, ctx, user, body, at);
        const dueOn = this.dueOf(body.dueOn);
        deliver = who.deliver;
        const follows = 'proposalId' in origin
          ? ((await c.query(`SELECT follows_task_id FROM human_proposals WHERE id = $1`, [origin.proposalId])).rows[0]?.follows_task_id as string | null) ?? null
          : null;
        const taskId = await this.insertTask(
          c, ctx,
          { parentId: null, depth: 0, title: content.text, assigneeId: who.userId, ownerAsWritten: content.owner, dueOn, invitationId: who.invitationId, origin, followsTaskId: follows },
          user, at, null,
        );
        const subtaskIds: string[] = [];
        const subs = Array.isArray(body.subtasks) ? (body.subtasks as Array<Record<string, unknown>>) : [];
        for (const s of subs) {
          const title = typeof s.title === 'string' ? s.title.trim() : '';
          if (title === '') throw new BadRequestException('Each subtask needs a title.');
          const sub = await this.assignee(c, ctx, user, s, at);
          const subDeliver = sub.deliver;
          if (subDeliver) {
            const prev = deliver;
            deliver = async () => ((prev ? await prev() : true) && (await subDeliver()));
          }
          subtaskIds.push(
            await this.insertTask(
              c, ctx,
              { parentId: taskId, depth: 1, title, assigneeId: sub.userId, ownerAsWritten: null, dueOn: this.dueOf(s.dueOn), invitationId: sub.invitationId, origin: null },
              user, at, 'Split at authorisation',
            ),
          );
        }
        record = { kind: 'task', id: taskId, subtaskIds };
        break;
      }
      case 'question': {
        const requester = body.requesterId === undefined || body.requesterId === null || body.requesterId === '' ? user.id : body.requesterId;
        if (requester !== user.id && !isProjectPerson(ctx, requester)) throw new BadRequestException('Choose the requester from the project\'s people.');
        await c.query(
          `INSERT INTO questions (id, project_id, text, requester_id, origin_item_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, ctx.project.id, content.text, requester, o.item, o.proposal, user.id, at],
        );
        record = { kind: 'question', id };
        break;
      }
      case 'risk': {
        if (!SEVERITIES.includes(body.severity as Severity)) throw new BadRequestException('Choose a severity.');
        const responsible = body.responsibleId === undefined || body.responsibleId === null || body.responsibleId === '' ? null : body.responsibleId;
        if (responsible !== null && !isProjectPerson(ctx, responsible)) throw new BadRequestException('Choose the responsible person from the project\'s people.');
        const reviewOn = body.reviewOn === undefined || body.reviewOn === null || body.reviewOn === '' ? null : body.reviewOn;
        if (reviewOn !== null && !isCalendarDate(reviewOn)) throw new BadRequestException('Dates must be in the form YYYY-MM-DD.');
        await c.query(
          `INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, origin_item_id, origin_proposal_id, authorised_by, authorised_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, ctx.project.id, content.text, body.severity, responsible, reviewOn, o.item, o.proposal, user.id, at],
        );
        record = { kind: 'risk', id };
        break;
      }
      case 'decision': {
        const rationale = typeof body.rationale === 'string' && body.rationale.trim() !== '' ? body.rationale.trim().slice(0, 4000) : null;
        await c.query(
          `INSERT INTO decisions (id, project_id, statement, rationale, origin_item_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, ctx.project.id, content.text, rationale, o.item, o.proposal, user.id, at],
        );
        record = { kind: 'decision', id };
        break;
      }
    }
    await writeAudit(c, { at, action: `record.authorised`, actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id, detail: { kind: record.kind, id: record.id, ...('itemId' in origin ? { itemId: origin.itemId } : { proposalId: origin.proposalId }) } });
    return { record, deliver };
  }

  /** A person's own proposal without a discussion source (V1.0 proposals §4). */
  async propose(user: AuthUser, projectId: string, input: Record<string, unknown>) {
    const kind = input.kind;
    if (!['action', 'decision', 'question', 'risk'].includes(kind as string)) throw new BadRequestException('Choose action, decision, question or risk.');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text === '' || text.length > 2000) throw new BadRequestException('Write the proposal (up to 2000 characters).');
    const opt = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null);
    const at = this.now();
    return this.tx(async (c) => {
      await this.access.authorize(user, 'proposal.submit', projectId, c, true);
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO human_proposals (id, project_id, kind, text, owner, due, proposed_by, proposed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, projectId, kind, text, opt(input.owner), opt(input.due), user.id, at],
      );
      await writeAudit(c, { at, action: 'proposal.submitted', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { proposalId: id, kind } });
      return { proposal: { id, kind, text } };
    });
  }

  /** A cancelled task offers a follow-up: a people's proposal that, once authorised, becomes a task linked to it (spec 4.3). */
  async followUp(user: AuthUser, taskId: string, input: Record<string, unknown>) {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text === '' || text.length > 2000) throw new BadRequestException('Write the proposal (up to 2000 characters).');
    const opt = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null);
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, task } = await this.taskContext(c, user, taskId, true);
      await this.access.authorize(user, 'proposal.submit', ctx.project.id, c, true);
      if (task.status !== 'cancelled') throw new ConflictException('A follow-up task can be proposed only for a cancelled task.');
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO human_proposals (id, project_id, kind, text, owner, due, proposed_by, proposed_at, follows_task_id) VALUES ($1, $2, 'action', $3, $4, $5, $6, $7, $8)`,
        [id, ctx.project.id, text, opt(input.owner), opt(input.due), user.id, at, task.id],
      );
      await writeAudit(c, { at, action: 'proposal.submitted', actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id, detail: { proposalId: id, kind: 'action', followsTaskId: task.id } });
      return { proposal: { id, kind: 'action', text, followsTaskId: task.id } };
    });
  }

  async proposals(user: AuthUser, projectId: string) {
    await this.access.authorize(user, 'project.view', projectId);
    const { rows } = await this.pool.query(
      `SELECT h.id, h.kind, h.text, h.owner, h.due, u.display_name AS "proposedBy", h.proposed_at AS "proposedAt",
              h.review_status AS "reviewStatus", h.reject_reason AS "rejectReason", h.follows_task_id AS "followsTaskId"
         FROM human_proposals h JOIN users u ON u.id = h.proposed_by WHERE h.project_id = $1 ORDER BY h.proposed_at, h.id`,
      [projectId],
    );
    const out = [];
    for (const r of rows) {
      // The written due, read against the day it was proposed (UTC+8), so the Authorise form can pre-fill the date.
      const dueReading = readDue({ due: r.due, dueEvent: null, meetingDate: todayUtc8(new Date(r.proposedAt)) });
      out.push({ ...r, dueReading, label: HUMAN_LABEL, record: await this.existingRecord(this.pool, { proposalId: r.id }) });
    }
    return { proposals: out };
  }

  /** Locks a human proposal and returns it with its project (404 when unknown). */
  private async lockProposal(c: PoolClient, proposalId: string) {
    if (!UUID.test(proposalId)) throw new NotFoundException();
    const p = (await c.query(`SELECT id, project_id, kind, text, owner, review_status FROM human_proposals WHERE id = $1`, [proposalId])).rows[0];
    if (!p) throw new NotFoundException();
    return p as { id: string; project_id: string; kind: Content['kind']; text: string; owner: string | null; review_status: string };
  }

  async authoriseProposal(user: AuthUser, proposalId: string, body: Record<string, unknown>): Promise<Authorised> {
    if (!UUID.test(proposalId)) throw new NotFoundException();
    const p = (await this.pool.query(`SELECT project_id FROM human_proposals WHERE id = $1`, [proposalId])).rows[0];
    if (!p) throw new NotFoundException();
    return this.authoriseThrough(user, p.project_id, 'human_proposal', proposalId, body);
  }

  async rejectProposal(user: AuthUser, proposalId: string, input: Record<string, unknown>) {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '') throw new BadRequestException('A reason is required.');
    const at = this.now();
    return this.tx(async (c) => {
      const peek = await this.lockProposal(c, proposalId);
      await this.access.authorize(user, 'proposal.review', peek.project_id, c, true);
      await lockPendingAuthorisation(c, 'human_proposal', proposalId);
      const p = (await c.query(`SELECT review_status FROM human_proposals WHERE id = $1 FOR UPDATE`, [proposalId])).rows[0];
      if (p.review_status !== 'pending') throw new ConflictException('Only a proposal waiting for review can be rejected.');
      await c.query(`UPDATE human_proposals SET review_status = 'rejected', reviewed_by = $2, reviewed_at = $3, reject_reason = $4 WHERE id = $1`, [proposalId, user.id, at, reason]);
      await rejectPendingAuthorisation(c, 'human_proposal', proposalId, user.id, at, reason);
      await writeAudit(c, { at, action: 'proposal.rejected', actorUserId: user.id, subjectType: 'project', subjectId: peek.project_id, detail: { proposalId } });
      return { proposal: { id: proposalId, reviewStatus: 'rejected' } };
    });
  }

  /** A refused change becomes 400 (missing input), 403 (not this person's to make) or 409 (state or rule). */
  static refusal(reason: string): never {
    if (reason === 'A note is required.' || reason.startsWith('Write ')) throw new BadRequestException(reason);
    if (reason.startsWith('Only ')) throw new ForbiddenException(reason);
    throw new ConflictException(reason);
  }

  /** Loads a task's project (a participant or grant holder may read it; changes are checked by the rules). */
  private async taskContext(c: PoolClient | Pool, user: AuthUser, taskId: string, lock: boolean) {
    if (!UUID.test(taskId)) throw new NotFoundException();
    const row = (await c.query(`SELECT project_id FROM tasks WHERE id = $1`, [taskId])).rows[0];
    if (!row) throw new NotFoundException();
    const ctx = await this.access.authorize(user, 'project.view', row.project_id, c, lock);
    const task = (
      await c.query(
        `SELECT id, parent_id AS "parentId", depth, assignee_id AS "assigneeId", status, to_char(due_on, 'YYYY-MM-DD') AS "dueOn"
           FROM tasks WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
        [taskId],
      )
    ).rows[0] as { id: string; parentId: string | null; depth: number; assigneeId: string; status: TaskStatus; dueOn: string };
    return { ctx, task };
  }

  /** Start, block, unblock, complete or reopen one task (V1.0 task lifecycle §3, §5). */
  async taskAction(user: AuthUser, taskId: string, action: TaskAction, input: Record<string, unknown>) {
    const note = typeof input.note === 'string' ? input.note.trim() : null;
    const overrideReason = typeof input.overrideReason === 'string' && input.overrideReason.trim() !== '' ? input.overrideReason.trim() : null;
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, task } = await this.taskContext(c, user, taskId, true);
      if (ctx.roles.length === 0) throw new ForbiddenException(GRANT_READ_ONLY);
      const verdict = taskTransition({
        action,
        status: task.status,
        actor: { isAssignee: task.assigneeId === user.id, roles: ctx.roles },
        projectStatus: ctx.project.status,
        assigneeActive: isActiveIn(ctx, task.assigneeId),
        note,
      });
      if (!verdict.allowed) RecordsService.refusal(verdict.reason);
      // A task marked for deadline review needs a new authorised date before it starts, resumes or completes (spec §7).
      if (MARKED_REFUSES.includes(action) && (await c.query(`SELECT deadline_review_required FROM tasks WHERE id = $1`, [task.id])).rows[0].deadline_review_required) {
        RecordsService.refusal(NEEDS_NEW_DATE);
      }
      let override = false;
      if (action === 'complete') {
        const children = (await c.query(`SELECT status FROM tasks WHERE parent_id = $1`, [task.id])).rows.map((r) => r.status as TaskStatus);
        const parentRule = parentMayComplete(children, overrideReason, ctx.roles);
        if (!parentRule.allowed) RecordsService.refusal(parentRule.reason);
        override = parentRule.override;
      }
      const change = async (id: string, from: TaskStatus, to: TaskStatus, kind: string, why: string | null, overrideWhy: string | null) => {
        await c.query(`UPDATE tasks SET status = $2, completed_at = CASE WHEN $2 = 'completed' THEN $3::timestamptz ELSE NULL END WHERE id = $1`, [id, to, at]);
        await c.query(
          `INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, override_reason, actor_id, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [uuidv7(at.getTime()), id, kind, from, to, why, overrideWhy, user.id, at],
        );
      };
      const KIND: Record<TaskAction, string> = { start: 'started', block: 'blocked', unblock: 'unblocked', complete: 'completed', reopen: 'reopened' };
      await change(task.id, task.status, verdict.to, KIND[action], note, override ? overrideReason : null);
      if (action === 'reopen') {
        // A reopened subtask reopens its completed parent (and grandparent) in the same action.
        const chain: Array<{ id: string; status: TaskStatus }> = [];
        let parentId = task.parentId;
        while (parentId) {
          const p = (await c.query(`SELECT id, parent_id, status FROM tasks WHERE id = $1 FOR UPDATE`, [parentId])).rows[0];
          chain.push({ id: p.id, status: p.status });
          parentId = p.parent_id;
        }
        for (const id of ancestorsToReopen(chain)) await change(id, 'completed', 'in_progress', 'reopened', note, null);
      }
      await writeAudit(c, { at, action: `task.${KIND[action]}`, actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id, detail: { taskId: task.id } });
      return { task: { id: task.id, status: verdict.to } };
    });
  }

  /** Loads a question or risk with its project under lock; anyone who may read the project gets this far. */
  private async recordContext(c: PoolClient, user: AuthUser, table: 'questions' | 'risks', id: string) {
    if (!UUID.test(id)) throw new NotFoundException();
    const row = (await c.query(`SELECT project_id FROM ${table} WHERE id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException();
    const ctx = await this.access.authorize(user, 'project.view', row.project_id, c, true);
    const rec = (await c.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    return { ctx, rec };
  }

  private async recordEvent(
    c: PoolClient,
    kind: 'question' | 'risk',
    id: string,
    event: string,
    from: string,
    to: string,
    note: string | null,
    actorId: string,
    at: Date,
    detail: Record<string, { from: unknown; to: unknown }> | null = null,
  ) {
    await c.query(
      `INSERT INTO record_events (id, record_kind, record_id, kind, from_status, to_status, note, actor_id, at, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [uuidv7(at.getTime()), kind, id, event, from, to, note, actorId, at, detail === null ? null : JSON.stringify(detail)],
    );
  }

  /** Answer, resolve, reopen or withdraw a question (V1.0 questions §3). */
  async questionAction(user: AuthUser, id: string, action: QuestionAction, input: Record<string, unknown>) {
    const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
    const note = action === 'answer' ? text(input.text) : action === 'resolve' ? text(input.note) ?? '' : text(input.reason);
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, rec } = await this.recordContext(c, user, 'questions', id);
      if (ctx.roles.length === 0) throw new ForbiddenException(GRANT_READ_ONLY);
      const verdict = questionTransition({
        action,
        status: rec.status,
        actor: { isRequester: rec.requester_id === user.id, roles: ctx.roles, active: isActiveIn(ctx, user.id) },
        projectStatus: ctx.project.status,
        note,
      });
      if (!verdict.allowed) RecordsService.refusal(verdict.reason);
      if (action === 'answer') {
        await c.query(`INSERT INTO question_answers (id, question_id, answer, author_id, at) VALUES ($1, $2, $3, $4, $5)`, [uuidv7(at.getTime()), id, note, user.id, at]);
      }
      await c.query(`UPDATE questions SET status = $2 WHERE id = $1`, [id, verdict.to]);
      const EVENT: Record<QuestionAction, string> = { answer: 'answered', resolve: 'resolved', reopen: 'reopened', withdraw: 'withdrawn' };
      await this.recordEvent(c, 'question', id, EVENT[action], rec.status, verdict.to, action === 'answer' ? null : note, user.id, at);
      await writeAudit(c, { at, action: `question.${EVENT[action]}`, actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id, detail: { questionId: id } });
      return { question: { id, status: verdict.to } };
    });
  }

  /** Mitigate, update, accept, resolve or reopen a risk (V1.0 risks §5, §9). */
  async riskAction(user: AuthUser, id: string, action: RiskAction, input: Record<string, unknown>) {
    const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null;
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, rec } = await this.recordContext(c, user, 'risks', id);
      if (ctx.roles.length === 0) throw new ForbiddenException(GRANT_READ_ONLY);
      // Only mitigating, updating and accepting change the responsible person, review date or mitigation.
      const fieldsChange = action === 'mitigate' || action === 'update' || action === 'accept';
      if (!fieldsChange) input = { note: input.note };
      const responsible = input.responsibleId === undefined ? rec.responsible_id : input.responsibleId === null || input.responsibleId === '' ? null : input.responsibleId;
      if (responsible !== null && responsible !== rec.responsible_id && !isProjectPerson(ctx, responsible)) {
        throw new BadRequestException('Choose the responsible person from the project\'s people.');
      }
      const reviewOnIn = input.reviewOn === undefined ? undefined : input.reviewOn === null || input.reviewOn === '' ? null : input.reviewOn;
      if (reviewOnIn !== undefined && reviewOnIn !== null && !isCalendarDate(reviewOnIn)) throw new BadRequestException('Dates must be in the form YYYY-MM-DD.');
      const reviewOn = reviewOnIn === undefined ? rec.review_on : reviewOnIn;
      const verdict = riskTransition({
        action,
        status: rec.status,
        actor: { isResponsible: rec.responsible_id === user.id, roles: ctx.roles },
        projectStatus: ctx.project.status,
        note,
        responsibleSet: responsible !== null,
        reviewOnSet: reviewOn !== null,
      });
      if (!verdict.allowed) RecordsService.refusal(verdict.reason);
      const mitigation = typeof input.mitigation === 'string' && input.mitigation.trim() !== '' ? input.mitigation.trim().slice(0, 4000) : rec.mitigation;
      const day = (d: unknown) => (d instanceof Date ? todayUtc8(d) : (d as string | null));
      const before = { responsible: rec.responsible_id as string | null, reviewOn: rec.review_on === null ? null : String(day(rec.review_on)).slice(0, 10), mitigation: rec.mitigation as string | null };
      const after = { responsible: responsible as string | null, reviewOn: reviewOn === null ? null : String(day(reviewOn)).slice(0, 10), mitigation };
      const detail: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of ['responsible', 'reviewOn', 'mitigation'] as const) if (before[k] !== after[k]) detail[k] = { from: before[k], to: after[k] };
      await c.query(`UPDATE risks SET status = $2, responsible_id = $3, review_on = $4, mitigation = $5 WHERE id = $1`, [id, verdict.to, responsible, reviewOn, mitigation]);
      const EVENT: Record<RiskAction, string> = { mitigate: 'mitigating', update: 'updated', accept: 'accepted', resolve: 'resolved', reopen: 'reopened' };
      await this.recordEvent(c, 'risk', id, EVENT[action], rec.status, verdict.to, note, user.id, at, Object.keys(detail).length > 0 ? detail : null);
      await writeAudit(c, { at, action: `risk.${EVENT[action]}`, actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id, detail: { riskId: id } });
      return { risk: { id, status: verdict.to } };
    });
  }

  /** One task with its history and source quote. */
  async getTask(user: AuthUser, taskId: string) {
    const { ctx, task } = await this.taskContext(this.pool, user, taskId, false);
    const list = await this.listFor(ctx, user);
    const view = list.tasks.find((t) => t.id === task.id);
    const history = (
      await this.pool.query(
        `SELECT e.kind, e.from_status AS "from", e.to_status AS "to", e.note, e.override_reason AS "overrideReason", e.detail, u.display_name AS actor, e.at
           FROM task_events e JOIN users u ON u.id = e.actor_id WHERE e.task_id = $1 ORDER BY e.at, e.id`,
        [taskId],
      )
    ).rows;
    return { task: view, history };
  }

  /** Every record of a project, for participants and grant holders (V1.0: read follows project access). */
  async list(user: AuthUser, projectId: string) {
    const ctx = await this.access.authorize(user, 'project.view', projectId);
    return this.listFor(ctx, user);
  }

  async listFor(ctx: ProjectContext, user: AuthUser) {
    const tasks = (
      await this.pool.query(
        `SELECT t.id, t.parent_id AS "parentId", t.depth, t.title, t.assignee_id AS "assigneeId", u.display_name AS "assigneeName",
                t.owner_as_written AS "ownerAsWritten", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn", t.status,
                to_char(p.due_on, 'YYYY-MM-DD') AS "parentDueOn",
                CASE WHEN i.id IS NULL THEN NULL WHEN i.status = 'invited' AND i.expires_at <= now() THEN 'expired' ELSE i.status END AS "invitationStatus",
                x.quote, p.status AS "parentStatus",
                CASE WHEN fo.id IS NULL THEN NULL ELSE json_build_object('id', fo.id, 'title', fo.title) END AS follows,
                (SELECT json_build_object('id', n.id, 'title', n.title) FROM tasks n WHERE n.follows_task_id = t.id ORDER BY n.authorised_at, n.id LIMIT 1) AS "followedBy",
                EXISTS (SELECT 1 FROM change_requests r WHERE r.target_kind = 'task' AND r.target_id = t.id AND r.status = 'pending') AS "changeWaiting",
                t.deadline_review_required AS "deadlineReviewRequired"
           FROM tasks t JOIN users u ON u.id = t.assignee_id
           LEFT JOIN tasks p ON p.id = t.parent_id
           LEFT JOIN tasks fo ON fo.id = t.follows_task_id
           LEFT JOIN invitations i ON i.id = t.invitation_id
           LEFT JOIN extraction_items x ON x.id = t.origin_item_id
          WHERE t.project_id = $1
          ORDER BY t.due_on, t.authorised_at, t.id`,
        [ctx.project.id],
      )
    ).rows;
    const view = tasks.map((t) => ({
      id: t.id,
      parentId: t.parentId,
      depth: t.depth,
      title: t.title,
      assignee: { id: t.assigneeId, displayName: t.assigneeName },
      ownerAsWritten: t.ownerAsWritten,
      dueOn: t.dueOn,
      status: t.status as TaskStatus,
      ...taskIndicators({
        status: t.status,
        dueOn: t.dueOn,
        parentDueOn: t.parentDueOn,
        assigneeActive: isActiveIn(ctx, t.assigneeId),
        invitationStatus: t.invitationStatus,
        today: ctx.today,
        deadlineReviewRequired: t.deadlineReviewRequired,
      }),
      source: t.quote ? { quote: t.quote as string } : null,
      changeWaiting: t.changeWaiting as boolean,
      parentCancelled: t.parentStatus === 'cancelled' && t.status !== 'cancelled' && t.status !== 'completed',
      follows: (t.follows ?? null) as { id: string; title: string } | null,
      followedBy: (t.followedBy ?? null) as { id: string; title: string } | null,
      // What this viewer may do now (notes are asked for when they act).
      mayAct: ctx.roles.length === 0 || t.status === 'cancelled' ? [] : TASK_ACTIONS.filter(
        (action) =>
          !(t.deadlineReviewRequired && MARKED_REFUSES.includes(action)) &&
          taskTransition({
            action,
            status: t.status,
            actor: { isAssignee: t.assigneeId === user.id, roles: ctx.roles },
            projectStatus: ctx.project.status,
            assigneeActive: isActiveIn(ctx, t.assigneeId),
            note: 'x',
          }).allowed,
      ),
    }));
    // Top-level tasks by due date, each followed by its subtasks (and theirs).
    const byParent = new Map<string | null, typeof view>();
    for (const v of view) byParent.set(v.parentId, [...(byParent.get(v.parentId) ?? []), v]);
    const ordered: typeof view = [];
    const walk = (parent: string | null) => {
      for (const v of byParent.get(parent) ?? []) {
        ordered.push(v);
        walk(v.id);
      }
    };
    walk(null);
    const decisions = (
      await this.pool.query(
        `SELECT d.id, d.statement, d.rationale, d.status, u.display_name AS "authorisedBy", d.authorised_at AS "authorisedAt",
                CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id', o.id, 'statement', o.statement) END AS replaces,
                (SELECT json_build_object('id', n.id, 'statement', n.statement) FROM decisions n WHERE n.replaces_id = d.id ORDER BY n.authorised_at, n.id LIMIT 1) AS "replacedBy",
                EXISTS (SELECT 1 FROM change_requests r WHERE r.target_kind = 'decision' AND r.target_id = d.id AND r.status = 'pending') AS "changeWaiting"
           FROM decisions d JOIN users u ON u.id = d.authorised_by LEFT JOIN decisions o ON o.id = d.replaces_id
          WHERE d.project_id = $1 ORDER BY d.authorised_at, d.id`,
        [ctx.project.id],
      )
    ).rows.map((d) => ({
      ...d,
      // Only an Owner or Sponsor changes a decision, and only an Active one while the project is Active.
      mayAct: d.status === 'active' && ctx.project.status === 'active' && ctx.roles.some((r) => r === 'owner' || r === 'sponsor') ? ['supersede', 'withdraw'] : [],
    }));
    const questions = (
      await this.pool.query(
        `SELECT q.id, q.text, q.status, json_build_object('id', r.id, 'displayName', r.display_name) AS requester,
                COALESCE((SELECT json_agg(json_build_object('answer', a.answer, 'author', au.display_name, 'at', a.at) ORDER BY a.at, a.id)
                            FROM question_answers a JOIN users au ON au.id = a.author_id WHERE a.question_id = q.id), '[]') AS answers
           FROM questions q JOIN users r ON r.id = q.requester_id WHERE q.project_id = $1 ORDER BY q.authorised_at, q.id`,
        [ctx.project.id],
      )
    ).rows.map((q) => {
      const actor = { isRequester: q.requester.id === user.id, roles: ctx.roles, active: isActiveIn(ctx, user.id) };
      const actions: QuestionAction[] = ['answer', 'resolve', 'reopen', 'withdraw'];
      return { ...q, mayAct: ctx.roles.length === 0 ? [] : actions.filter((action) => questionTransition({ action, status: q.status, actor, projectStatus: ctx.project.status, note: 'x' }).allowed) };
    });
    const risks = (
      await this.pool.query(
        `SELECT k.id, k.description, k.severity, k.status, k.mitigation, to_char(k.review_on, 'YYYY-MM-DD') AS "reviewOn",
                CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object('id', r.id, 'displayName', r.display_name) END AS responsible,
                (SELECT json_build_object('projectId', e.detail->>'fromProjectId', 'name', e.detail->>'fromProjectName') FROM record_events e
                  WHERE e.record_kind = 'risk' AND e.record_id = k.id AND e.kind = 'handed_over_from' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS "handedOverFrom",
                (SELECT json_build_object('projectId', e.detail->>'toProjectId', 'name', e.detail->>'toProjectName') FROM record_events e
                  WHERE e.record_kind = 'risk' AND e.record_id = k.id AND e.kind = 'handed_over_to' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS "handedOverTo"
           FROM risks k LEFT JOIN users r ON r.id = k.responsible_id WHERE k.project_id = $1 ORDER BY k.authorised_at, k.id`,
        [ctx.project.id],
      )
    ).rows.map((k) => {
      const actor = { isResponsible: k.responsible?.id === user.id, roles: ctx.roles };
      const actions: RiskAction[] = ['mitigate', 'update', 'accept', 'resolve', 'reopen'];
      const mayAct = ctx.roles.length === 0 ? [] : actions.filter(
        (action) => riskTransition({ action, status: k.status, actor, projectStatus: ctx.project.status, note: 'x', responsibleSet: true, reviewOnSet: true }).allowed,
      );
      return { ...k, mayAct };
    });
    const open = (
      await this.pool.query(
        `SELECT f.id, f.record_kind AS kind, f.record_id AS "recordId", f.raised_at AS "raisedAt",
                json_build_object('id', d.id, 'statement', d.statement, 'status', d.status) AS decision
           FROM review_flags f JOIN decisions d ON d.id = f.decision_id
          WHERE f.project_id = $1 AND f.cleared_at IS NULL ORDER BY f.raised_at, f.id`,
        [ctx.project.id],
      )
    ).rows;
    const flagsOf = (kind: string, id: string) => open.filter((f) => f.kind === kind && f.recordId === id).map((f) => ({ id: f.id, decision: f.decision, raisedAt: f.raisedAt }));
    return {
      tasks: ordered.map((x) => ({ ...x, reviewFlags: flagsOf('task', x.id) })),
      decisions,
      questions: questions.map((x) => ({ ...x, reviewFlags: flagsOf('question', x.id) })),
      risks: risks.map((x) => ({ ...x, reviewFlags: flagsOf('risk', x.id) })),
    };
  }
}
