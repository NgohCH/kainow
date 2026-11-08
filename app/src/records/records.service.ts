import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { isCalendarDate } from '../extraction/due';
import { type ApprovedItem, ExtractionService } from '../extraction/extraction.service';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { InvitationsService } from '../projects/invitations.service';
import { membershipState } from '../projects/membership';
import { SEVERITIES, type Severity } from './lifecycles';
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

/** What a human proposal or an approved extraction item contributes to a record. */
export interface Content {
  kind: 'action' | 'decision' | 'question' | 'risk';
  text: string;
  owner: string | null;
}

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
  ) {}

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

  /** Authorise one extraction proposal: approve it and create its record, once (V1.0 proposals §7). */
  async authoriseItem(user: AuthUser, runId: string, itemId: string, body: Record<string, unknown>): Promise<Created & { created: boolean }> {
    if (!UUID.test(itemId)) throw new NotFoundException();
    const projectId = await this.access.projectOfRun(runId);
    const at = this.now();
    let deliver: (() => Promise<boolean>) | null = null;
    const result = await this.tx(async (c) => {
      const ctx = await this.authoriser(c, user, projectId);
      const existing = await this.existingRecord(c, { itemId });
      if (existing) return { record: existing, created: false };
      const approved: ApprovedItem = await this.extraction.approveInTx(c, runId, itemId, { sourceVersionId: body.sourceVersionId, occurrence: body.occurrence }, user.id, at);
      const made = await this.createFrom(c, ctx, { itemId }, approved, body, user, at);
      deliver = made.deliver;
      return { record: made.record, created: true };
    });
    const delivered = deliver ? await (deliver as () => Promise<boolean>)() : undefined;
    return { ...result, ...(delivered !== undefined ? { delivered } : {}) };
  }

  /** Owner or Sponsor, project Planned or Active, no required role missing; the project row is locked. */
  async authoriser(c: PoolClient, user: AuthUser, projectId: string): Promise<ProjectContext> {
    const ctx = await this.access.authorize(user, 'proposal.review', projectId, c, true);
    if (ctx.missingAccountability) throw new ConflictException(MISSING_ACCOUNTABILITY);
    return ctx;
  }

  /** Resolve a task assignee: a project person, or an eligible email (account made Invited, invitation issued). */
  private async assignee(c: PoolClient, ctx: ProjectContext, user: AuthUser, body: Record<string, unknown>, at: Date) {
    if (body.assigneeId !== undefined && body.assigneeId !== null && body.assigneeId !== '') {
      if (!isProjectPerson(ctx, body.assigneeId)) throw new BadRequestException(NEEDS_ASSIGNEE);
      return { userId: body.assigneeId as string, invitationId: null as string | null, deliver: null as null | (() => Promise<boolean>) };
    }
    const email = typeof body.inviteEmail === 'string' ? body.inviteEmail.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new BadRequestException(NEEDS_ASSIGNEE);
    const existing = (await c.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0];
    if (existing && isProjectPerson(ctx, existing.id)) return { userId: existing.id as string, invitationId: null, deliver: null };
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

  private dueOf(v: unknown): string {
    if (typeof v !== 'string' || !isCalendarDate(v)) throw new BadRequestException(NEEDS_ASSIGNEE);
    return v;
  }

  private async insertTask(
    c: PoolClient,
    ctx: ProjectContext,
    t: { parentId: string | null; depth: number; title: string; assigneeId: string; ownerAsWritten: string | null; dueOn: string; invitationId: string | null; origin: Origin | null },
    user: AuthUser,
    at: Date,
    note: string | null,
  ): Promise<string> {
    const id = uuidv7(at.getTime());
    const o = t.origin ? originColumns(t.origin) : { item: null, proposal: null };
    await c.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, owner_as_written, due_on, invitation_id, origin_item_id, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, ctx.project.id, t.parentId, t.depth, t.title, t.assigneeId, t.ownerAsWritten, t.dueOn, t.invitationId, o.item, o.proposal, user.id, at],
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
        const taskId = await this.insertTask(
          c, ctx,
          { parentId: null, depth: 0, title: content.text, assigneeId: who.userId, ownerAsWritten: content.owner, dueOn, invitationId: who.invitationId, origin },
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

  async proposals(user: AuthUser, projectId: string) {
    await this.access.authorize(user, 'project.view', projectId);
    const { rows } = await this.pool.query(
      `SELECT h.id, h.kind, h.text, h.owner, h.due, u.display_name AS "proposedBy", h.proposed_at AS "proposedAt",
              h.review_status AS "reviewStatus", h.reject_reason AS "rejectReason"
         FROM human_proposals h JOIN users u ON u.id = h.proposed_by WHERE h.project_id = $1 ORDER BY h.proposed_at, h.id`,
      [projectId],
    );
    const out = [];
    for (const r of rows) out.push({ ...r, label: HUMAN_LABEL, record: await this.existingRecord(this.pool, { proposalId: r.id }) });
    return { proposals: out };
  }

  /** Locks a human proposal and returns it with its project (404 when unknown). */
  private async lockProposal(c: PoolClient, proposalId: string) {
    if (!UUID.test(proposalId)) throw new NotFoundException();
    const p = (await c.query(`SELECT id, project_id, kind, text, owner, review_status FROM human_proposals WHERE id = $1`, [proposalId])).rows[0];
    if (!p) throw new NotFoundException();
    return p as { id: string; project_id: string; kind: Content['kind']; text: string; owner: string | null; review_status: string };
  }

  async authoriseProposal(user: AuthUser, proposalId: string, body: Record<string, unknown>): Promise<Created & { created: boolean }> {
    const at = this.now();
    let deliver: (() => Promise<boolean>) | null = null;
    const result = await this.tx(async (c) => {
      const peek = await this.lockProposal(c, proposalId);
      const ctx = await this.authoriser(c, user, peek.project_id);
      const p = (await c.query(`SELECT review_status FROM human_proposals WHERE id = $1 FOR UPDATE`, [proposalId])).rows[0];
      const existing = await this.existingRecord(c, { proposalId });
      if (existing) return { record: existing, created: false };
      if (p.review_status === 'rejected') throw new ConflictException('This proposal was rejected.');
      const made = await this.createFrom(c, ctx, { proposalId }, { kind: peek.kind, text: peek.text, owner: peek.owner }, body, user, at);
      await c.query(`UPDATE human_proposals SET review_status = 'approved', reviewed_by = $2, reviewed_at = $3 WHERE id = $1`, [proposalId, user.id, at]);
      deliver = made.deliver;
      return { record: made.record, created: true };
    });
    const delivered = deliver ? await (deliver as () => Promise<boolean>)() : undefined;
    return { ...result, ...(delivered !== undefined ? { delivered } : {}) };
  }

  async rejectProposal(user: AuthUser, proposalId: string, input: Record<string, unknown>) {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '') throw new BadRequestException('A reason is required.');
    const at = this.now();
    return this.tx(async (c) => {
      const peek = await this.lockProposal(c, proposalId);
      await this.access.authorize(user, 'proposal.review', peek.project_id, c, true);
      const p = (await c.query(`SELECT review_status FROM human_proposals WHERE id = $1 FOR UPDATE`, [proposalId])).rows[0];
      if (p.review_status !== 'pending') throw new ConflictException('Only a proposal waiting for review can be rejected.');
      await c.query(`UPDATE human_proposals SET review_status = 'rejected', reviewed_by = $2, reviewed_at = $3, reject_reason = $4 WHERE id = $1`, [proposalId, user.id, at, reason]);
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
      const verdict = taskTransition({
        action,
        status: task.status,
        actor: { isAssignee: task.assigneeId === user.id, roles: ctx.roles },
        projectStatus: ctx.project.status,
        assigneeActive: isActiveIn(ctx, task.assigneeId),
        note,
      });
      if (!verdict.allowed) RecordsService.refusal(verdict.reason);
      let override = false;
      if (action === 'complete') {
        const children = (await c.query(`SELECT status FROM tasks WHERE parent_id = $1`, [task.id])).rows.map((r) => r.status as TaskStatus);
        const parentRule = parentMayComplete(children, overrideReason, ctx.roles);
        if (!parentRule.allowed) RecordsService.refusal(parentRule.reason);
        override = parentRule.override;
      }
      const change = async (id: string, from: TaskStatus, to: TaskStatus, kind: string, why: string | null, overrideWhy: string | null) => {
        await c.query(`UPDATE tasks SET status = $2 WHERE id = $1`, [id, to]);
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

  /** The Project Manager or a Deputy splits a task by adding a subtask (two levels at most), with a reason. */
  async addSubtask(user: AuthUser, parentId: string, input: Record<string, unknown>) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (title === '') throw new BadRequestException('Give the subtask a title.');
    if (reason === '') throw new BadRequestException('A reason is required.');
    const at = this.now();
    return this.tx(async (c) => {
      const { ctx, task } = await this.taskContext(c, user, parentId, true);
      if (!ctx.roles.includes('pm') && !ctx.roles.includes('deputy_pm')) throw new ForbiddenException('Only the Project Manager or a Deputy can add a subtask.');
      if (ctx.project.status !== 'active') throw new ConflictException('Tasks change only while the project is Active.');
      if (task.depth >= 2) throw new ConflictException('Subtasks go at most two levels deep.');
      if (!isProjectPerson(ctx, input.assigneeId)) throw new BadRequestException(NEEDS_ASSIGNEE);
      const dueOn = this.dueOf(input.dueOn);
      const id = await this.insertTask(
        c, ctx,
        { parentId: task.id, depth: task.depth + 1, title, assigneeId: input.assigneeId as string, ownerAsWritten: null, dueOn, invitationId: null, origin: null },
        user, at, reason,
      );
      await writeAudit(c, { at, action: 'task.subtask_added', actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id, detail: { taskId: id, parentId: task.id } });
      return { task: { id, parentId: task.id, depth: task.depth + 1 } };
    });
  }

  /** One task with its history and source quote. */
  async getTask(user: AuthUser, taskId: string) {
    const { ctx, task } = await this.taskContext(this.pool, user, taskId, false);
    const list = await this.listFor(ctx, user);
    const view = list.tasks.find((t) => t.id === task.id);
    const history = (
      await this.pool.query(
        `SELECT e.kind, e.from_status AS "from", e.to_status AS "to", e.note, e.override_reason AS "overrideReason", u.display_name AS actor, e.at
           FROM task_events e JOIN users u ON u.id = e.actor_id WHERE e.task_id = $1 AND e.kind <> 'authorised' ORDER BY e.at, e.id`,
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
                x.quote
           FROM tasks t JOIN users u ON u.id = t.assignee_id
           LEFT JOIN tasks p ON p.id = t.parent_id
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
      }),
      source: t.quote ? { quote: t.quote as string } : null,
      // What this viewer may do now (notes are asked for when they act).
      mayAct: TASK_ACTIONS.filter(
        (action) =>
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
    return { tasks: ordered, decisions: [] as unknown[], questions: [] as unknown[], risks: [] as unknown[] };
  }
}
