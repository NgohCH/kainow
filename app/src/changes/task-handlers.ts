import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import type { AuthUser } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { isCalendarDate } from '../extraction/due';
import type { ProjectContext } from '../projects/access.service';
import { RecordsService } from '../records/records.service';
import { type ChangeHandler, type Row, dryRun } from './handlers';
import { checkReplacementDate } from './rules';

export const NOTHING_CHANGED = 'Change at least one of the wording, the assignee or the due date.';
export const TASK_FINISHED = 'A completed or cancelled task cannot be changed; propose a follow-up task instead.';
export const NOT_A_PROPOSER = 'Only the assignee, the Project Manager, a Deputy, an Owner or a Sponsor can propose changes to this task.';
export const CHOOSE_FOR_SUBTASKS = 'Choose cancel or keep for each unfinished subtask.';
const REASON_NEEDED = 'A reason is required.';
const TOO_DEEP = 'Subtasks go at most two levels deep.';

const isBlank = (v: unknown) => v === undefined || v === null || v === '';
const objectOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const reasonOf = (terms: Record<string, unknown>): string => {
  const r = typeof terms.reason === 'string' ? terms.reason.trim() : '';
  if (r === '') throw new BadRequestException(REASON_NEEDED);
  return r;
};
const finished = (target: Row) => target.status === 'completed' || target.status === 'cancelled';
const ASSIGNEE_KEYS = ['assigneeId', 'inviteEmail'] as const;

function mayProposeChange(ctx: ProjectContext, target: Row, user: AuthUser): string | null {
  if (target.assignee_id === user.id) return null;
  if (ctx.roles.some((r) => r === 'pm' || r === 'deputy_pm' || r === 'owner' || r === 'sponsor')) return null;
  return NOT_A_PROPOSER;
}

/** Amending a task (wording, assignee, due date, or adding a subtask) and cancelling it, through authorisation (spec §4). */
export function taskHandlers(deps: { records: RecordsService }): ChangeHandler[] {
  const { records } = deps;

  /** The assignee the terms name, worked out as authorising would but with nothing kept (no invitation, no account). */
  const resolve = async (c: PoolClient, ctx: ProjectContext, input: Record<string, unknown>, by: AuthUser, at: Date): Promise<string> =>
    dryRun(c, async () => (await records.assignee(c, ctx, by, input, at)).userId);

  const dueOf = (v: unknown): string => {
    if (typeof v !== 'string' || !isCalendarDate(v)) throw new BadRequestException('Dates must be in the form YYYY-MM-DD.');
    return v;
  };
  const titleOf = (v: unknown): string => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t === '' || t.length > 2000) throw new BadRequestException('Write the task wording (up to 2000 characters).');
    return t;
  };
  const assigneePart = (v: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!isBlank(v.assigneeId)) out.assigneeId = v.assigneeId;
    else if (!isBlank(v.inviteEmail)) out.inviteEmail = typeof v.inviteEmail === 'string' ? v.inviteEmail.trim().toLowerCase() : v.inviteEmail;
    return out;
  };

  const amend: ChangeHandler = {
    kind: 'amend_task',
    targetKind: 'task',
    mayPropose: mayProposeChange,
    async validate(c, ctx, target, terms, user, at) {
      const reason = reasonOf(terms);
      if (finished(target)) RecordsService.refusal(TASK_FINISHED);
      const add = objectOf(terms.addSubtask);
      if (terms.addSubtask !== undefined && !add) throw new BadRequestException('Describe the subtask to add.');
      if (add) {
        if (['title', 'assigneeId', 'inviteEmail', 'dueOn'].some((k) => !isBlank(terms[k]))) {
          throw new BadRequestException('Propose either a change to this task or a new subtask, not both.');
        }
        if (target.depth >= 2) throw new ConflictException(TOO_DEEP);
        const who = assigneePart(add);
        if (Object.keys(who).length === 0) throw new BadRequestException('Name the assignee of the subtask.');
        const sub = { title: titleOf(add.title), ...who, dueOn: dueOf(add.dueOn) };
        await resolve(c, ctx, sub, user, at);
        return { addSubtask: sub, reason };
      }
      const out: Record<string, unknown> = {};
      if (!isBlank(terms.title)) {
        const title = titleOf(terms.title);
        if (title !== target.title) out.title = title;
      }
      const who = assigneePart(terms);
      if (Object.keys(who).length > 0) {
        const id = await resolve(c, ctx, who, user, at);
        if (id !== target.assignee_id) Object.assign(out, who);
      }
      if (!isBlank(terms.dueOn)) {
        const dueOn = dueOf(terms.dueOn);
        // A date already past is allowed (the task is then overdue at once), except on a task waiting for a deadline
        // review: its new date must satisfy the review's rules.
        if (dueOn !== target.dueOn) {
          if (target.deadline_review_required) {
            const refusal = checkReplacementDate({ previous: target.dueOn, proposed: dueOn, today: ctx.today });
            if (refusal) throw new ConflictException(refusal);
          }
          out.dueOn = dueOn;
        }
      }
      if (Object.keys(out).length === 0) RecordsService.refusal(NOTHING_CHANGED);
      return { ...out, reason };
    },
    async apply(c, ctx, target, terms, request, at) {
      const by = { id: request.decidedBy as string } as AuthUser;
      const add = objectOf(terms.addSubtask);
      if (add) {
        const who = await records.assignee(c, ctx, by, add, at);
        const id = await records.insertTask(
          c, ctx,
          { parentId: target.id, depth: target.depth + 1, title: add.title as string, assigneeId: who.userId, ownerAsWritten: null, dueOn: add.dueOn as string, invitationId: who.invitationId, origin: null },
          by, at, 'Added by amendment',
        );
        await writeAudit(c, { at, action: 'task.subtask_added', actorUserId: by.id, subjectType: 'project', subjectId: ctx.project.id, detail: { taskId: id, parentId: target.id, requestId: request.id } });
        return { record: { kind: 'task', id: target.id, subtaskIds: [id] }, ...(who.deliver ? { deliver: who.deliver } : {}) };
      }
      const detail: Record<string, { from: unknown; to: unknown }> = {};
      let assigneeId: string = target.assignee_id;
      let invitationId: string | null = target.invitation_id ?? null;
      let deliver: (() => Promise<boolean>) | undefined;
      if (ASSIGNEE_KEYS.some((k) => !isBlank(terms[k]))) {
        const who = await records.assignee(c, ctx, by, terms, at);
        if (who.userId !== target.assignee_id) detail.assigneeId = { from: target.assignee_id, to: who.userId };
        assigneeId = who.userId;
        invitationId = who.invitationId;
        if (who.deliver) deliver = who.deliver;
      }
      const title = typeof terms.title === 'string' ? terms.title : (target.title as string);
      if (title !== target.title) detail.title = { from: target.title, to: title };
      const dueOn = typeof terms.dueOn === 'string' ? terms.dueOn : (target.dueOn as string);
      if (dueOn !== target.dueOn) detail.dueOn = { from: target.dueOn, to: dueOn };
      // An authorised new due date is what a task waiting for a deadline review needs.
      const reviewed = !!target.deadline_review_required && dueOn !== target.dueOn;
      await c.query(`UPDATE tasks SET title = $2, assignee_id = $3, invitation_id = $4, due_on = $5, deadline_review_required = deadline_review_required AND NOT $6 WHERE id = $1`, [
        target.id, title, assigneeId, invitationId, dueOn, reviewed,
      ]);
      await c.query(
        `INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at, detail) VALUES ($1, $2, 'amended', $3, $3, $4, $5, $6, $7)`,
        [uuidv7(at.getTime()), target.id, target.status, terms.reason, by.id, at, JSON.stringify(detail)],
      );
      await writeAudit(c, { at, action: 'task.amended', actorUserId: by.id, subjectType: 'project', subjectId: ctx.project.id, detail: { taskId: target.id, requestId: request.id, fields: Object.keys(detail) } });
      return { record: { kind: 'task', id: target.id }, ...(deliver ? { deliver } : {}) };
    },
  };

  /** Every unfinished subtask below a task, at any depth. */
  const unfinishedBelow = async (c: PoolClient, taskId: string): Promise<Array<{ id: string; status: string }>> =>
    (
      await c.query(
        `WITH RECURSIVE below AS (
           SELECT id, status FROM tasks WHERE parent_id = $1
           UNION ALL SELECT t.id, t.status FROM tasks t JOIN below b ON t.parent_id = b.id
         ) SELECT id, status FROM below WHERE status NOT IN ('completed', 'cancelled')`,
        [taskId],
      )
    ).rows;

  const cancel: ChangeHandler = {
    kind: 'cancel_task',
    targetKind: 'task',
    mayPropose: mayProposeChange,
    async validate(c, _ctx, target, terms) {
      const reason = reasonOf(terms);
      if (finished(target)) RecordsService.refusal(TASK_FINISHED);
      const chosen = objectOf(terms.subtasks) ?? {};
      const subtasks: Record<string, 'cancel' | 'keep'> = {};
      for (const sub of await unfinishedBelow(c, target.id)) {
        const choice = chosen[sub.id];
        if (choice !== 'cancel' && choice !== 'keep') throw new BadRequestException(CHOOSE_FOR_SUBTASKS);
        subtasks[sub.id] = choice;
      }
      return { reason, subtasks };
    },
    async apply(c, ctx, target, terms, request, at) {
      const by = request.decidedBy as string;
      const subtasks = terms.subtasks as Record<string, 'cancel' | 'keep'>;
      const ids = [target.id as string, ...Object.keys(subtasks).filter((id) => subtasks[id] === 'cancel')];
      for (const id of ids) {
        const from = (await c.query(`SELECT status FROM tasks WHERE id = $1 FOR UPDATE`, [id])).rows[0].status as string;
        await c.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [id]);
        await c.query(
          `INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at) VALUES ($1, $2, 'cancelled', $3, 'cancelled', $4, $5, $6)`,
          [uuidv7(at.getTime()), id, from, terms.reason, by, at],
        );
      }
      await writeAudit(c, { at, action: 'task.cancelled', actorUserId: by, subjectType: 'project', subjectId: ctx.project.id, detail: { taskId: target.id, requestId: request.id, cancelled: ids } });
      return { record: { kind: 'task', id: target.id } };
    },
  };

  return [amend, cancel];
}
