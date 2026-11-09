/**
 * Closure accounting and delegated closure, as plain functions over a database client so the project lifecycle and
 * membership code can use them inside their own transactions without depending on the changes module (spec §6, §6.1).
 */
import { ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { closureReadiness } from './rules';

type Db = Pool | PoolClient;

export const closeMissing = (n: number) => `Closing needs a disposition for every open item: ${n} remain.`;
export const DELIVERED_NEEDS = 'Delivered needs every task finished or cancelled and the objectives confirmed as met.';

export interface DispositionRow {
  id: string;
  recordKind: 'task' | 'question' | 'risk';
  recordId: string;
  disposition: string;
  reason: string;
  affectsDelivery: boolean;
  handoverProjectId: string | null;
  chosenById: string;
  chosenBy: string;
  chosenAt: Date;
}

export interface DelegationRow {
  id: string;
  pmUserId: string;
  pm: string;
  by: string;
  reason: string;
  at: Date;
}

export const openTask = (t: { status: string }) => t.status !== 'completed' && t.status !== 'cancelled';
export const openQuestion = (q: { status: string }) => q.status === 'open' || q.status === 'answered';
export const openRisk = (r: { status: string; reviewOn: string | null }) => r.status !== 'resolved' && !(r.status === 'accepted' && r.reviewOn === null);

/** The project's records, its current dispositions and the hand-over requests for its risks. */
export async function loadClosure(db: Db, projectId: string) {
  const tasks = (
    await db.query(
      `SELECT id, parent_id AS "parentId", depth, title, status, to_char(due_on, 'YYYY-MM-DD') AS "dueOn"
         FROM tasks WHERE project_id = $1 ORDER BY authorised_at, id`,
      [projectId],
    )
  ).rows as Array<{ id: string; parentId: string | null; depth: number; title: string; status: string; dueOn: string }>;
  const questions = (await db.query(`SELECT id, text, status FROM questions WHERE project_id = $1 ORDER BY authorised_at, id`, [projectId])).rows as Array<{
    id: string;
    text: string;
    status: string;
  }>;
  const risks = (
    await db.query(
      `SELECT id, description, severity, status, to_char(review_on, 'YYYY-MM-DD') AS "reviewOn" FROM risks WHERE project_id = $1 ORDER BY authorised_at, id`,
      [projectId],
    )
  ).rows as Array<{ id: string; description: string; severity: string; status: string; reviewOn: string | null }>;
  const dispositions = (
    await db.query(
      `SELECT d.id, d.record_kind AS "recordKind", d.record_id AS "recordId", d.disposition, d.reason, d.affects_delivery AS "affectsDelivery",
              d.handover_project_id AS "handoverProjectId", d.chosen_by AS "chosenById", u.display_name AS "chosenBy", d.chosen_at AS "chosenAt"
         FROM closure_dispositions d JOIN users u ON u.id = d.chosen_by
        WHERE d.project_id = $1 AND d.replaced_at IS NULL AND NOT d.final`,
      [projectId],
    )
  ).rows as DispositionRow[];
  const riskIds = risks.map((r) => r.id);
  const handovers = (
    await db.query(
      `SELECT kind, target_id AS "targetId", status, reason FROM change_requests
        WHERE kind = 'risk_handover' AND target_kind = 'risk' AND target_id = ANY($1::uuid[]) ORDER BY submitted_at, id`,
      [riskIds],
    )
  ).rows as Array<{ kind: string; targetId: string; status: string; reason: string | null }>;
  // The closure batch's cancellations (the batch is named by the project's own id).
  const cancellations = (
    await db.query(
      `SELECT kind, target_id AS "targetId", status, reason FROM change_requests
        WHERE kind = 'cancel_task' AND target_kind = 'task' AND project_id = $1 AND batch_id = $1 ORDER BY submitted_at, id`,
      [projectId],
    )
  ).rows as Array<{ kind: string; targetId: string; status: string; reason: string | null }>;
  return { tasks, questions, risks, dispositions, handovers, cancellations };
}

/** closureReadiness over what is open now; dispositions of records finished since they were chosen do not count. */
export function readinessOf(loaded: Awaited<ReturnType<typeof loadClosure>>) {
  // A risk already handed over (accepted by the receiving project) needs nothing more from this project.
  const handedOver = new Set(loaded.handovers.filter((h) => h.status === 'authorised').map((h) => h.targetId));
  const risks = loaded.risks.filter((r) => !handedOver.has(r.id));
  const open = new Set([
    ...loaded.tasks.filter(openTask).map((t) => `task:${t.id}`),
    ...loaded.questions.filter(openQuestion).map((q) => `question:${q.id}`),
    ...risks.filter(openRisk).map((r) => `risk:${r.id}`),
  ]);
  return closureReadiness({
    tasks: loaded.tasks,
    questions: loaded.questions,
    risks,
    dispositions: loaded.dispositions.filter((d) => open.has(`${d.recordKind}:${d.recordId}`)),
    pendingRequests: [...loaded.handovers, ...loaded.cancellations],
  });
}

/** Refuses Close (409) until every open item has a disposition that is in effect, and Delivered unless it is allowed. */
export async function assertClosureReady(c: PoolClient, projectId: string, input: { outcome: string | null; objectivesMet: boolean }) {
  const readiness = readinessOf(await loadClosure(c, projectId));
  if (!readiness.ready) {
    throw new ConflictException({ statusCode: 409, error: 'Conflict', message: closeMissing(readiness.missing.length), missing: readiness.missing });
  }
  if (input.outcome === 'delivered' && !(readiness.deliveredAllowed && input.objectivesMet)) throw new ConflictException(DELIVERED_NEEDS);
  return readiness;
}

/** The open delegation, if any. */
export async function openDelegation(db: Db, projectId: string): Promise<DelegationRow | null> {
  const row = (
    await db.query(
      `SELECT d.id, d.pm_user_id AS "pmUserId", p.display_name AS pm, b.display_name AS by, d.reason, d.at
         FROM closure_delegations d JOIN users p ON p.id = d.pm_user_id JOIN users b ON b.id = d.delegated_by
        WHERE d.project_id = $1 AND d.revoked_at IS NULL`,
      [projectId],
    )
  ).rows[0];
  return (row as DelegationRow) ?? null;
}

/** Ends the open delegation (on revocation, a change of Project Manager, or Close). True when there was one. */
export async function endDelegation(c: PoolClient, projectId: string, actorId: string, at: Date, why: string): Promise<boolean> {
  const ended = await c.query(
    `UPDATE closure_delegations SET revoked_by = $2, revoked_at = $3 WHERE project_id = $1 AND revoked_at IS NULL RETURNING id`,
    [projectId, actorId, at],
  );
  if (!ended.rowCount) return false;
  await writeAudit(c, { at, action: 'closure.delegation_ended', actorUserId: actorId, subjectType: 'project', subjectId: projectId, detail: { delegationId: ended.rows[0].id, why } });
  return true;
}

/**
 * At Close, inside its transaction: questions resolved or withdrawn and risks finally accepted as their dispositions
 * say, the current dispositions marked final, and any delegation ended.
 */
export async function finaliseClosure(c: PoolClient, projectId: string, actorId: string, at: Date): Promise<void> {
  const loaded = await loadClosure(c, projectId);
  const event = (kind: 'question' | 'risk', id: string, ev: string, from: string, to: string, note: string, detail: Record<string, unknown> | null) =>
    c.query(
      `INSERT INTO record_events (id, record_kind, record_id, kind, from_status, to_status, note, actor_id, at, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [uuidv7(at.getTime()), kind, id, ev, from, to, note, actorId, at, detail === null ? null : JSON.stringify(detail)],
    );
  const applied: string[] = [];
  for (const d of loaded.dispositions) {
    if (d.recordKind === 'question' && (d.disposition === 'resolve' || d.disposition === 'withdraw')) {
      const q = loaded.questions.find((x) => x.id === d.recordId);
      if (!q || !openQuestion(q)) continue;
      const to = d.disposition === 'resolve' ? 'resolved' : 'withdrawn';
      await c.query(`UPDATE questions SET status = $2 WHERE id = $1`, [q.id, to]);
      await event('question', q.id, to, q.status, to, d.reason, null);
      applied.push(q.id);
    } else if (d.recordKind === 'risk' && d.disposition === 'final_accept') {
      const r = loaded.risks.find((x) => x.id === d.recordId);
      if (!r || !openRisk(r)) continue;
      await c.query(`UPDATE risks SET status = 'accepted', review_on = NULL WHERE id = $1`, [r.id]);
      await event('risk', r.id, 'accepted', r.status, 'accepted', 'No further review required', r.reviewOn === null ? null : { reviewOn: { from: r.reviewOn, to: null } });
      applied.push(r.id);
    }
  }
  await c.query(`UPDATE closure_dispositions SET final = true WHERE project_id = $1 AND replaced_at IS NULL AND NOT final`, [projectId]);
  await writeAudit(c, { at, action: 'closure.finalised', actorUserId: actorId, subjectType: 'project', subjectId: projectId, detail: { applied } });
  await endDelegation(c, projectId, actorId, at, 'closed');
}
