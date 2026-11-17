import { liveRecordSql, unheldRecordSql } from '../history/deleted-sql';
import type { Db } from './letterhead';

/** What must still be true for a queued email to be worth delivering (checked by the dispatcher before every attempt). */
export type Relevance =
  | { kind: 'task'; taskId: string; dueOn: string; reopenCount: number }
  | { kind: 'risk'; riskId: string; reviewOn: string }
  /** `taskIds`: the tasks a digest lists; it is not delivered once any of them is Deleted or held (history spec 4.3). */
  | { kind: 'project_active'; projectId: string; taskIds?: string[] }
  /** An invitation email: worth sending only while the invitation is still open (not revoked, replaced or answered) and unexpired. */
  | { kind: 'invitation'; invitationId: string }
  | { kind: 'none' };

/**
 * Whose eligibility to check before sending: 'project' = holds an active role in the row's project today,
 * 'admin' = an Active Administrator, 'account' = the account is Active. Absent: 'account' when the row has a recipient user.
 */
export type EligibilityScope = 'project' | 'admin' | 'account';

/** A consolidated email lists several items, each with its own check. */
export type ConsolidatedRelevance = {
  scope?: EligibilityScope;
  projectName: string;
  items: Array<{ triggerId: string; projectId: string; check: Relevance; line: string }>;
};

export type SingleRelevance = Relevance & { scope?: EligibilityScope };

export type EmailRelevance = SingleRelevance | ConsolidatedRelevance;

export const isConsolidated = (r: EmailRelevance): r is ConsolidatedRelevance => 'items' in r;

/**
 * Whether the thing an email is about is still as it was when the email was composed (`now`: the attempt time).
 * Reminders and escalations about a task or risk use the visible form (liveRecordSql): a record cleaned and under
 * review stays in view "so reminders and work continue" (history spec 7.5); one waiting for the protected key, or
 * Deleted, is not. A digest (project_active) uses the strict form: it is not delivered once a task it lists is held at
 * all (final review I4).
 */
export async function stillRelevant(db: Db, r: Relevance, now: Date = new Date()): Promise<boolean> {
  switch (r.kind) {
    case 'none':
      return true;
    case 'task': {
      const t = (
        await db.query(
          `SELECT status, to_char(due_on, 'YYYY-MM-DD') AS due_on, deadline_review_required,
                  (SELECT count(*)::int FROM task_events e WHERE e.task_id = tasks.id AND e.kind = 'reopened') AS reopened
             FROM tasks WHERE id = $1 AND ${liveRecordSql('tasks')}`,
          [r.taskId],
        )
      ).rows[0];
      return !!t && t.status !== 'completed' && t.status !== 'cancelled' && t.due_on === r.dueOn && !t.deadline_review_required && t.reopened === r.reopenCount;
    }
    case 'risk': {
      const k = (await db.query(`SELECT status, to_char(review_on, 'YYYY-MM-DD') AS review_on FROM risks k WHERE k.id = $1 AND ${liveRecordSql('k')}`, [r.riskId])).rows[0];
      return !!k && k.status !== 'resolved' && k.review_on === r.reviewOn;
    }
    case 'project_active': {
      const p = (await db.query(`SELECT status FROM projects WHERE id = $1`, [r.projectId])).rows[0];
      if (p?.status !== 'active') return false;
      if (!r.taskIds || r.taskIds.length === 0) return true;
      const gone = await db.query(`SELECT 1 FROM tasks t WHERE t.id = ANY($1::uuid[]) AND NOT ${unheldRecordSql('t')} LIMIT 1`, [r.taskIds]);
      return gone.rows.length === 0;
    }
    case 'invitation': {
      const i = (await db.query(`SELECT 1 FROM invitations WHERE id = $1 AND status = 'invited' AND expires_at > $2`, [r.invitationId, now])).rows[0];
      return !!i;
    }
  }
}
