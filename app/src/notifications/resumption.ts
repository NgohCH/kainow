// The resumption summary (spec §5): once when a Deferred or Closed project returns to Active, to the PM and each
// assignee with outstanding work. Missed reminders are not replayed; this summary covers what matters.
import type { Pool } from 'pg';
import type { Decided } from './fire';
import { type Holder, routeFor } from './recipients';
import { linkFor, resumptionSummary } from './summaries';

const PAUSED = ['deferred', 'closed'];

/** The latest return to Active from Deferred or Closed; triggers whose time fell before it are skipped as paused. */
export async function latestResumption(pool: Pool, projectId: string): Promise<Date | null> {
  const r = await pool.query(
    `SELECT max(at) AS at FROM project_transitions WHERE project_id = $1 AND to_status = 'active' AND from_status = ANY($2::text[])`,
    [projectId, PAUSED],
  );
  return (r.rows[0]?.at as Date | null) ?? null;
}

/**
 * The summary for the project's latest transition into Active, when that transition was a resumption whose summary
 * is not yet recorded; else null. The caller records it (the unique key still guards a concurrent sweep).
 */
export async function resumptionTrigger(
  pool: Pool,
  project: { id: string; name: string },
  ctx: { today: string; holders: Holder[] },
): Promise<Decided | null> {
  const latest = (
    await pool.query(
      `SELECT id, from_status AS "from", at FROM project_transitions
        WHERE project_id = $1 AND to_status = 'active' ORDER BY at DESC, id DESC LIMIT 1`,
      [project.id],
    )
  ).rows[0] as { id: string; from: string; at: Date } | undefined;
  if (!latest || !PAUSED.includes(latest.from)) return null;
  const key = `project:${project.id}:resumed:${latest.id}`;
  if ((await pool.query(`SELECT 1 FROM notification_triggers WHERE key = $1`, [key])).rows.length > 0) return null;

  const open = (
    await pool.query(
      `SELECT title, assignee_id AS "assigneeId", to_char(due_on, 'YYYY-MM-DD') AS "dueOn", deadline_review_required AS review
         FROM tasks WHERE project_id = $1 AND status NOT IN ('completed', 'cancelled') ORDER BY due_on, title, id`,
      [project.id],
    )
  ).rows as { title: string; assigneeId: string; dueOn: string; review: boolean }[];
  const risks = (
    await pool.query(
      `SELECT description, to_char(review_on, 'YYYY-MM-DD') AS "reviewOn" FROM risks
        WHERE project_id = $1 AND status <> 'resolved' AND review_on < $2::date ORDER BY review_on, description, id`,
      [project.id, ctx.today],
    )
  ).rows as { description: string; reviewOn: string }[];

  // Every project member can read its tasks and risks, so each recipient's list is the same.
  const summary = resumptionSummary(project.name, {
    reviewRequired: open.filter((t) => t.review).map((t) => t.title),
    overdue: open.filter((t) => !t.review && t.dueOn < ctx.today).map((t) => ({ title: t.title, dueOn: t.dueOn })),
    risksPassed: risks,
  });
  const holderIds = new Set(ctx.holders.map((h) => h.userId));
  const pm = routeFor('resumption', { holders: ctx.holders, assigneeId: null, admins: [] }).to;
  const assignees = open.map((t) => t.assigneeId).filter((id) => holderIds.has(id));
  const recipients = [...new Set([...pm, ...assignees])].sort();
  return {
    key,
    kind: 'resumption',
    projectId: project.id,
    recordKind: 'project',
    recordId: project.id,
    fireAt: latest.at,
    outcome: recipients.length > 0 ? 'sent' : 'no_recipient',
    recipients,
    detail: { transitionId: latest.id, from: latest.from },
    summary,
    link: linkFor(project.id, 'project', project.id),
  };
}
