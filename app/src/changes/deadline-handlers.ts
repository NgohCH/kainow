import { BadRequestException, ConflictException } from '@nestjs/common';
import { writeAudit } from '../audit/audit';
import type { AuthUser } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { isCalendarDate } from '../extraction/due';
import { todayUtc8 } from '../projects/membership';
import { type TaskStatus, parentMayComplete } from '../records/tasks';
import type { ChangeHandler, Row } from './handlers';
import { checkReconciliation, checkReplacementDate } from './rules';

export const NOT_A_REVIEWER = 'Only the Project Manager or a Deputy can prepare a deadline review.';
export const NOT_A_RECONCILER = 'Only the assignee, the Project Manager or a Deputy can reconcile this task.';
export const NOT_MARKED = 'This task is not waiting for a deadline review.';
const DATE_FORM = 'Dates must be in the form YYYY-MM-DD.';
const TOO_LONG = 'Keep the evidence to 2000 characters or fewer.';

const isManager = (roles: readonly string[]) => roles.includes('pm') || roles.includes('deputy_pm');
const finished = (target: Row) => target.status === 'completed' || target.status === 'cancelled';

const dateOf = (v: unknown): string => {
  if (typeof v !== 'string' || !isCalendarDate(v)) throw new BadRequestException(DATE_FORM);
  return v;
};

function assertWaiting(target: Row): void {
  if (finished(target) || !target.deadline_review_required) throw new ConflictException(NOT_MARKED);
}

/** A replacement due date for a task marked when its project was deferred or closed, and the actual completion of work finished meanwhile (spec §7). */
export function deadlineHandlers(): ChangeHandler[] {
  const deadlineReview: ChangeHandler = {
    kind: 'deadline_review',
    targetKind: 'task',
    mayPropose: (ctx) => (isManager(ctx.roles) ? null : NOT_A_REVIEWER),
    async validate(_c, ctx, target, terms) {
      assertWaiting(target);
      const dueOn = dateOf(terms.dueOn);
      const refusal = checkReplacementDate({ previous: target.dueOn, proposed: dueOn, today: ctx.today });
      if (refusal) throw new ConflictException(refusal);
      return { dueOn };
    },
    async apply(c, ctx, target, terms, request, at) {
      const by = request.decidedBy as string;
      const dueOn = terms.dueOn as string;
      await c.query(`UPDATE tasks SET due_on = $2, deadline_review_required = false WHERE id = $1`, [target.id, dueOn]);
      await c.query(
        `INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at, detail) VALUES ($1, $2, 'deadline_reviewed', $3, $3, $4, $5, $6)`,
        [uuidv7(at.getTime()), target.id, target.status, by, at, JSON.stringify({ dueOn: { from: target.dueOn, to: dueOn } })],
      );
      await writeAudit(c, {
        at, action: 'task.deadline_reviewed', actorUserId: by, subjectType: 'project', subjectId: ctx.project.id,
        detail: { taskId: target.id, requestId: request.id, from: target.dueOn, to: dueOn },
      });
      return { record: { kind: 'task', id: target.id } };
    },
  };

  const reconcile: ChangeHandler = {
    kind: 'reconcile_completion',
    targetKind: 'task',
    mayPropose: (ctx, target, user: AuthUser) => (target.assignee_id === user.id || isManager(ctx.roles) ? null : NOT_A_RECONCILER),
    async validate(c, ctx, target, terms, _user, at) {
      assertWaiting(target);
      const completedOn = dateOf(terms.completedOn);
      const explanation = typeof terms.explanation === 'string' ? terms.explanation.trim() : '';
      if (explanation === '') throw new BadRequestException('Explain how the work was completed.');
      const evidence = typeof terms.evidence === 'string' ? terms.evidence.trim() : '';
      if (evidence.length > 2000) throw new BadRequestException(TOO_LONG);
      const pause = (
        await c.query(`SELECT at FROM project_transitions WHERE project_id = $1 AND to_status IN ('deferred', 'closed') ORDER BY at DESC, id DESC LIMIT 1`, [ctx.project.id])
      ).rows[0] as { at: Date } | undefined;
      const refusal = checkReconciliation({
        completedOn, today: todayUtc8(at), pausedOn: pause ? todayUtc8(pause.at) : '1970-01-01', explanation,
      });
      if (refusal) throw new ConflictException(refusal);
      // Parent completion rules still apply: unfinished subtasks block it.
      const children = (await c.query(`SELECT status FROM tasks WHERE parent_id = $1`, [target.id])).rows.map((r) => r.status as TaskStatus);
      const parentRule = parentMayComplete(children, null, []);
      if (!parentRule.allowed) throw new ConflictException(parentRule.reason);
      return { completedOn, explanation, ...(evidence === '' ? {} : { evidence }) };
    },
    async apply(c, ctx, target, terms, request, at) {
      const by = request.decidedBy as string;
      const completedOn = terms.completedOn as string;
      // The end of that day in UTC+8.
      const completedAt = new Date(`${completedOn}T23:59:59.999+08:00`);
      await c.query(`UPDATE tasks SET status = 'completed', completed_at = $2, deadline_review_required = false WHERE id = $1`, [target.id, completedAt]);
      await c.query(
        `INSERT INTO task_events (id, task_id, kind, from_status, to_status, note, actor_id, at, detail) VALUES ($1, $2, 'reconciled', $3, 'completed', $4, $5, $6, $7)`,
        [
          uuidv7(at.getTime()), target.id, target.status, terms.explanation, by, at,
          JSON.stringify({ completedOn, ...(terms.evidence ? { evidence: terms.evidence } : {}) }),
        ],
      );
      await writeAudit(c, {
        at, action: 'task.reconciled', actorUserId: by, subjectType: 'project', subjectId: ctx.project.id,
        detail: { taskId: target.id, requestId: request.id, completedOn },
      });
      return { record: { kind: 'task', id: target.id } };
    },
  };

  return [deadlineReview, reconcile];
}
