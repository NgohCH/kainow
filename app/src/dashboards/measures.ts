/**
 * The shared measures (dashboards spec §3): the one source of every figure the project, personal and leadership
 * dashboards, the analytics panels and their CSV export show. Pure functions plus `loadProjectMeasures`, one batched
 * loader with a fixed number of queries however many projects it is given. Days are 'YYYY-MM-DD' in UTC+8.
 */
import type { Pool, PoolClient } from 'pg';
import { liveRecordSql } from '../history/deleted-sql';
import { escalationFlagsFor } from '../notifications/escalation-flags';
import type { ProjectStatus } from '../projects/matrix';
import { type MembershipRow, requiredRolesCheck } from '../projects/membership';
import { type TaskStatus, taskIndicators } from '../records/tasks';

export const MEASURES_VERSION = '1';

export const COVERAGE_NOTE = 'Counts all authorised records in the project except deleted ones and any under credential review.';

/** One entry per row of the §3 table, word for word: shown in "About these figures" and on the Definitions page. */
export const MEASURE_DEFINITIONS: readonly { key: string; label: string; definition: string }[] = [
  {
    key: 'eligibleLeaf',
    label: 'Eligible leaf task',
    definition:
      'An authorised task (a row in `tasks`) with no live subtasks, not Cancelled, passing the record filter. A parent whose subtasks are all Deleted counts as a leaf.',
  },
  {
    key: 'completion',
    label: 'Task completion',
    definition:
      'Completed eligible leaf tasks ÷ eligible leaf tasks × 100, shown as "62% task completion (31 of 50 tasks)". Cancelled leaf tasks are shown separately ("4 cancelled"). With no eligible leaf tasks: "Progress not yet measurable". An overridden parent completion changes nothing, since only leaves count.',
  },
  {
    key: 'onTime',
    label: 'On-time completion',
    definition:
      'D88. Due so far = eligible leaf tasks with `due_on` before the reference day and no deadline review pending. Done = those Completed. Late = Done whose completion day (UTC+8) is after `due_on`. The reference day is today, or the deferral day for Deferred projects, or the closing day for Closed ones. With nothing due: "Nothing due yet". "Awaiting deadline review: n" is shown beside it when n > 0.',
  },
  {
    key: 'overdue',
    label: 'Overdue',
    definition:
      'The existing `taskIndicators` rule: not Completed or Cancelled, `due_on` before today, no deadline review pending. All tasks (not only leaves) are listed; counts are of tasks.',
  },
  { key: 'blocked', label: 'Blocked', definition: 'Tasks with status Blocked.' },
  { key: 'dueSoon', label: 'Due soon', definition: 'Not finished, due today to today + 7 days.' },
  {
    key: 'stage',
    label: 'Stage and stage duration',
    definition: 'The open `project_stage_periods` row: stage, substage and whole days since `started_at`, as the existing Overview shows (`stageDuration`).',
  },
  {
    key: 'plannedEnd',
    label: 'Planned end',
    definition: 'Days from today to the project\'s planned end date, "Ended n days ago" when past, or "No planned end date".',
  },
  { key: 'questions', label: 'Open questions', definition: 'Questions Open or Answered.' },
  {
    key: 'risks',
    label: 'Risks',
    definition: 'Open or Mitigating risks by severity. "Significant" = High or Critical. Overdue review = Open, Mitigating or Accepted with `review_on` before today.',
  },
  { key: 'vacantRole', label: 'Vacant required role', definition: 'The existing missing-role flag (D03).' },
  {
    key: 'escalations',
    label: 'Escalations',
    definition: 'Open escalation flags (`escalation-flags`), and the "No independent escalation recipient" flag.',
  },
  { key: 'pendingInvitations', label: 'Pending invitations', definition: 'Invitations Invited and not expired.' },
  { key: 'refreshTime', label: 'Refresh time', definition: 'The time the server worked the figures out. Every response carries `computedAt`.' },
];

/** An eligible-leaf candidate: a live leaf task, Cancelled ones included (they are counted apart). */
export type LeafRow = { status: TaskStatus; dueOn: string; completedOn: string | null; deadlineReviewRequired: boolean };

export type Completion =
  | { state: 'measurable'; done: number; total: number; cancelled: number; percent: number }
  | { state: 'not_measurable'; cancelled: number };

export type OnTime =
  | { state: 'measured'; due: number; done: number; late: number; percent: number; awaitingReview: number }
  | { state: 'nothing_due'; awaitingReview: number };

export type PlannedEnd = { state: 'none' } | { state: 'ahead'; days: number } | { state: 'ended'; daysAgo: number };

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface ProjectMeasures {
  projectId: string;
  completion: Completion;
  onTime: OnTime;
  /** Tasks at any level (not only leaves). */
  overdue: number;
  blocked: number;
  dueSoon: number;
  /** The open stage period; null only for a project without one. */
  stage: { stage: string; substage: string | null; days: number } | null;
  plannedEnd: PlannedEnd;
  questions: { open: number; answered: number };
  risks: { bySeverity: Record<Severity, number>; significant: number; overdueReviews: number };
  flags: { missingRole: boolean; noIndependentEscalation: boolean; deadlineReview: boolean; escalationsOpen: number };
  pendingInvitations: number;
  nextTaskDue: string | null;
  nextRiskReview: string | null;
}

/** Whole percent, rounded down: 100 only when all are done and 0 only when none is. 0 for an empty total. */
export function percent(done: number, total: number): number {
  return total === 0 ? 0 : Math.floor((done * 100) / total);
}

/** Whole days from `from` to `to` (both 'YYYY-MM-DD'). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A deadline review is pending on a task that is not finished (the `taskIndicators` rule). */
const reviewPending = (l: LeafRow): boolean =>
  taskIndicators({ status: l.status, dueOn: l.dueOn, parentDueOn: null, assigneeActive: true, invitationStatus: null, today: l.dueOn, deadlineReviewRequired: l.deadlineReviewRequired })
    .deadlineReviewRequired;

export function taskCompletion(leaves: LeafRow[]): Completion {
  const cancelled = leaves.filter((l) => l.status === 'cancelled').length;
  const eligible = leaves.filter((l) => l.status !== 'cancelled');
  if (eligible.length === 0) return { state: 'not_measurable', cancelled };
  const done = eligible.filter((l) => l.status === 'completed').length;
  return { state: 'measurable', done, total: eligible.length, cancelled, percent: percent(done, eligible.length) };
}

/** D88: of the eligible leaves due before the reference day (no deadline review pending), how many are done. */
export function onTimeCompletion(leaves: LeafRow[], referenceDay: string): OnTime {
  const eligible = leaves.filter((l) => l.status !== 'cancelled');
  const awaitingReview = eligible.filter(reviewPending).length;
  const due = eligible.filter((l) => !reviewPending(l) && l.dueOn < referenceDay);
  if (due.length === 0) return { state: 'nothing_due', awaitingReview };
  const done = due.filter((l) => l.status === 'completed');
  const late = done.filter((l) => l.completedOn !== null && l.completedOn > l.dueOn).length;
  return { state: 'measured', due: due.length, done: done.length, late, percent: percent(done.length, due.length), awaitingReview };
}

/** Today, or the deferral day of a Deferred project, or the closing day of a Closed one. */
export function referenceDay(input: { status: ProjectStatus; today: string; deferredOn: string | null; closedOn: string | null }): string {
  if (input.status === 'deferred') return input.deferredOn ?? input.today;
  if (input.status === 'closed') return input.closedOn ?? input.today;
  return input.today;
}

export function plannedEnd(planned: string | null, today: string): PlannedEnd {
  if (planned === null) return { state: 'none' };
  const days = daysBetween(today, planned);
  return days >= 0 ? { state: 'ahead', days } : { state: 'ended', daysAgo: -days };
}

/** The UTC+8 calendar day of a timestamptz column, as 'YYYY-MM-DD'. */
const dayUtc8 = (column: string): string => `to_char(${column} AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD')`;

/** Today + n days. */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const DUE_SOON_DAYS = 7;

/**
 * The measures of each project, keyed by id. A fixed number of queries whatever the number of projects. Pending
 * invitations compare their expiry instant with `now` (the caller's clock; the real time by default).
 */
export async function loadProjectMeasures(
  db: Pool | PoolClient,
  projectIds: string[],
  today: string,
  now: Date = new Date(),
): Promise<Map<string, ProjectMeasures>> {
  const out = new Map<string, ProjectMeasures>();
  if (projectIds.length === 0) return out;
  const ids = [...new Set(projectIds)];

  const projects = (
    await db.query(
      `SELECT p.id, p.status, to_char(p.planned_end, 'YYYY-MM-DD') AS "plannedEnd",
              (SELECT ${dayUtc8('tr.at')} FROM project_transitions tr WHERE tr.project_id = p.id AND tr.to_status = 'deferred' ORDER BY tr.at DESC, tr.id DESC LIMIT 1) AS "deferredOn",
              (SELECT ${dayUtc8('tr.at')} FROM project_transitions tr WHERE tr.project_id = p.id AND tr.to_status = 'closed' ORDER BY tr.at DESC, tr.id DESC LIMIT 1) AS "closedOn",
              s.stage, s.substage, ${dayUtc8('s.started_at')} AS "stageStartedOn"
         FROM projects p LEFT JOIN project_stage_periods s ON s.project_id = p.id AND s.ended_at IS NULL
        WHERE p.id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows as Array<{
    id: string; status: ProjectStatus; plannedEnd: string | null; deferredOn: string | null; closedOn: string | null;
    stage: string | null; substage: string | null; stageStartedOn: string | null;
  }>;

  // Every live task; a leaf has no subtask that is not Deleted.
  const tasks = (
    await db.query(
      `SELECT t.project_id AS "projectId", t.status, to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn",
              ${dayUtc8('t.completed_at')} AS "completedOn", t.deadline_review_required AS "deadlineReviewRequired",
              NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL) AS leaf
         FROM tasks t
        WHERE t.project_id = ANY($1::uuid[]) AND ${liveRecordSql('t')}`,
      [ids],
    )
  ).rows as Array<LeafRow & { projectId: string; leaf: boolean }>;

  const questions = (
    await db.query(
      `SELECT q.project_id AS "projectId", count(*) FILTER (WHERE q.status = 'open')::int AS open,
              count(*) FILTER (WHERE q.status = 'answered')::int AS answered
         FROM questions q WHERE q.project_id = ANY($1::uuid[]) AND ${liveRecordSql('q')} GROUP BY q.project_id`,
      [ids],
    )
  ).rows as Array<{ projectId: string; open: number; answered: number }>;

  const risks = (
    await db.query(
      `SELECT r.project_id AS "projectId",
              count(*) FILTER (WHERE r.status IN ('open', 'mitigating') AND r.severity = 'low')::int AS low,
              count(*) FILTER (WHERE r.status IN ('open', 'mitigating') AND r.severity = 'medium')::int AS medium,
              count(*) FILTER (WHERE r.status IN ('open', 'mitigating') AND r.severity = 'high')::int AS high,
              count(*) FILTER (WHERE r.status IN ('open', 'mitigating') AND r.severity = 'critical')::int AS critical,
              count(*) FILTER (WHERE r.status IN ('open', 'mitigating', 'accepted') AND r.review_on < $2::date)::int AS "overdueReviews",
              to_char(min(r.review_on) FILTER (WHERE r.status IN ('open', 'mitigating', 'accepted') AND r.review_on >= $2::date), 'YYYY-MM-DD') AS "nextReview"
         FROM risks r WHERE r.project_id = ANY($1::uuid[]) AND ${liveRecordSql('r')} GROUP BY r.project_id`,
      [ids, today],
    )
  ).rows as Array<{ projectId: string; overdueReviews: number; nextReview: string | null } & Record<Severity, number>>;

  const memberships = (
    await db.query(
      `SELECT m.project_id AS "projectId", m.user_id AS "userId", m.role, to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn",
              to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn", m.revoked_at AS "revokedAt", m.held_at AS "heldAt", m.restored_at AS "restoredAt"
         FROM memberships m WHERE m.project_id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows as Array<MembershipRow & { projectId: string }>;

  const invitations = (
    await db.query(
      `SELECT project_id AS "projectId", count(*)::int AS n FROM invitations
        WHERE project_id = ANY($1::uuid[]) AND status = 'invited' AND expires_at > $2 GROUP BY project_id`,
      [ids, now],
    )
  ).rows as Array<{ projectId: string; n: number }>;

  const escalations = await escalationFlagsFor(db, ids, today);

  const group = <T extends { projectId: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.projectId, [...(m.get(r.projectId) ?? []), r]);
    return m;
  };
  const tasksBy = group(tasks);
  const membersBy = group(memberships);
  const escalationsBy = group(escalations);
  const questionsBy = new Map(questions.map((q) => [q.projectId, q]));
  const risksBy = new Map(risks.map((r) => [r.projectId, r]));
  const invitationsBy = new Map(invitations.map((i) => [i.projectId, i.n]));
  const soonEnd = addDays(today, DUE_SOON_DAYS);

  for (const p of projects) {
    const all = tasksBy.get(p.id) ?? [];
    const leaves = all.filter((t) => t.leaf);
    const unfinished = all.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
    const indicators = all.map((t) =>
      taskIndicators({ status: t.status, dueOn: t.dueOn, parentDueOn: null, assigneeActive: true, invitationStatus: null, today, deadlineReviewRequired: t.deadlineReviewRequired }),
    );
    const r = risksBy.get(p.id);
    const bySeverity: Record<Severity, number> = { low: r?.low ?? 0, medium: r?.medium ?? 0, high: r?.high ?? 0, critical: r?.critical ?? 0 };
    const escalationsOpen = escalationsBy.get(p.id)?.length ?? 0;
    const nextDue = unfinished.map((t) => t.dueOn).filter((d) => d >= today).sort()[0] ?? null;
    out.set(p.id, {
      projectId: p.id,
      completion: taskCompletion(leaves),
      onTime: onTimeCompletion(leaves, referenceDay({ status: p.status, today, deferredOn: p.deferredOn, closedOn: p.closedOn })),
      overdue: indicators.filter((i) => i.overdue).length,
      blocked: all.filter((t) => t.status === 'blocked').length,
      dueSoon: unfinished.filter((t) => t.dueOn >= today && t.dueOn <= soonEnd).length,
      stage: p.stage === null ? null : { stage: p.stage, substage: p.substage, days: Math.max(0, daysBetween(p.stageStartedOn as string, today)) },
      plannedEnd: plannedEnd(p.plannedEnd, today),
      questions: { open: questionsBy.get(p.id)?.open ?? 0, answered: questionsBy.get(p.id)?.answered ?? 0 },
      risks: { bySeverity, significant: bySeverity.high + bySeverity.critical, overdueReviews: r?.overdueReviews ?? 0 },
      flags: {
        // As the project context decides it: an Active project whose required roles are not all Active today.
        missingRole: p.status === 'active' && !requiredRolesCheck(membersBy.get(p.id) ?? [], today, 'active').ok,
        noIndependentEscalation: escalationsOpen > 0,
        deadlineReview: indicators.some((i) => i.deadlineReviewRequired),
        escalationsOpen,
      },
      pendingInvitations: invitationsBy.get(p.id) ?? 0,
      nextTaskDue: nextDue,
      nextRiskReview: r?.nextReview ?? null,
    });
  }
  return out;
}
