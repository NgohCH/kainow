import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { ChangesService, changeMayApprove, eligibleApprovers, listedRequestSql } from '../changes/changes.service';
import { isManager as preparesDeadlineReview } from '../changes/deadline-handlers';
import type { RequestRow } from '../changes/handlers';
import type { ChangeKind } from '../changes/rules';
import { PG_POOL } from '../db/database.module';
import { liveRecordSql, liveSourceSql, unheldRecordSql } from '../history/deleted-sql';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { archiveState } from '../projects/archive';
import type { GrantRow } from '../projects/grants';
import { type ProjectStatus, decide } from '../projects/matrix';
import { type Effective, loadEffectiveMany } from '../notifications/settings';
import { dueSoonEnd } from './due-soon';
import { neededByPassedSql } from '../resources/line-sql';
import { membershipState, todayUtc8 } from '../projects/membership';
import { loadAccessSettings } from '../organisation/access-settings';
import { POSSIBLE_COPY_TEXT, possibleCopySql } from '../quarantine/labels';
import { type TaskStatus, taskIndicators } from '../records/tasks';
import { taskLink } from '../records/task-link';
import { isDueSoon, latestBlockNotes } from '../records/board-fields';
import { type ProjectMeasures, loadProjectMeasures } from './measures';
import { archivedAmong, groupBy, loadProjectContexts } from './project-contexts';
import { shown } from './project-dashboard.service';

export type NeedsYouKind =
  | 'approval' | 'minutes' | 'question' | 'copies' | 'deadline_review' | 'resources'
  | 'overdue' | 'blocked' | 'due_soon' | 'risk_review';

export interface NeedsYouItem {
  kind: NeedsYouKind;
  projectId: string;
  projectName: string;
  /** What it is. Record text follows the dashboard rule (a cleaned held record shows its label); copies give a count only. */
  label: string;
  /** Since when it has been waiting (ISO instant), or null when nothing records it. */
  since: string | null;
  link: string;
  /** Possible credential copies only: how many places await a decision. */
  count?: number;
}

export interface MyTask {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  dueOn: string;
  status: TaskStatus;
  overdueDays?: number;
  /** The UTC+8 day it was finished, or null. */
  completedOn: string | null;
  /** The latest block's note while Blocked; null when it is not Blocked or the task is held or under review. */
  blockedReason: string | null;
  /** The parent task, left out (null) when it is held, under review or Deleted. */
  parent: { id: string; title: string } | null;
  /** Direct subtasks that are live and not cancelled or held. */
  subtasks: { done: number; total: number };
}

export interface PersonalProject {
  id: string;
  name: string;
  /** The viewer's own membership is On Hold: the name only, no figures. */
  onHold: boolean;
  archived?: boolean;
  header?: {
    status: ProjectStatus;
    stage: ProjectMeasures['stage'];
    completion: ProjectMeasures['completion'];
    flags: { overdue: number; blocked: number; missingRole: boolean; noIndependentEscalation: boolean; deadlineReview: boolean };
  };
  expanded?: {
    roles: string[];
    grant: string | null;
    owningDepartment: string;
    onTime: ProjectMeasures['onTime'];
    plannedEnd: ProjectMeasures['plannedEnd'];
    openQuestions: number;
    significantRisks: number;
    nextTaskDue: string | null;
    link: string;
  };
}

export interface PersonalDashboard {
  needsYou: NeedsYouItem[];
  myTasks: { overdue: MyTask[]; dueSoon: MyTask[]; later: MyTask[]; awaitingReview: MyTask[]; completed?: MyTask[] };
  projects: PersonalProject[];
  computedAt: string;
}

/** The change kinds as the web names them (web/src/changes.ts). */
const KIND_LABEL: Record<ChangeKind, string> = {
  authorise_proposal: 'Authorise a proposal',
  amend_task: 'Change a task',
  cancel_task: 'Cancel a task',
  supersede_decision: 'Replace a decision',
  withdraw_decision: 'Withdraw a decision',
  deadline_review: 'Review a deadline',
  reconcile_completion: 'Confirm work finished during a pause',
  risk_handover: 'Take over a risk',
  approve_output: 'Approve an output',
  set_budget: 'Set the budget',
  finance_adjustment: 'Adjust a spending entry',
};

const COMPLETED_DAYS = 30;

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A due or review date as the instant it begins, 00:00 UTC+8. */
const dayStart = (day: string): string => new Date(`${day}T00:00:00+08:00`).toISOString();
const recordLink = (projectId: string, id: string) => `#/projects/${projectId}/work/${id}`;


/** Where an approval is acted on in the web app. */
function approvalLink(r: RequestRow & { runId: string | null }): string {
  const base = `#/projects/${r.projectId}`;
  if (r.kind === 'deadline_review') return `${base}/deadline-review`;
  if (r.kind === 'risk_handover') return `${base}/work`;
  if (r.targetKind === 'extraction_item') return r.runId ? `#/runs/${r.runId}` : `${base}/notes`;
  if (r.targetKind === 'human_proposal') return `${base}/notes/${r.targetId}`;
  if (r.targetKind === 'task') return taskLink(r.projectId, r.targetId);
  return `${base}/work/${r.targetId}`;
}

/**
 * `GET /dashboard/me` (dashboards spec §4): what needs the viewer, their tasks and their projects. A fixed number of
 * queries however many projects the viewer has: contexts, archive state and measures are loaded in batches.
 */
@Injectable()
export class PersonalDashboardService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: ProjectAccess,
    private readonly changes: ChangesService,
  ) {}

  async get(user: AuthUser, opts: { includeArchived: boolean; showCompleted: boolean }): Promise<PersonalDashboard> {
    const now = this.clock();
    const today = todayUtc8(now);
    const myTasks: PersonalDashboard['myTasks'] = { overdue: [], dueSoon: [], later: [], awaitingReview: [], ...(opts.showCompleted ? { completed: [] } : {}) };
    const empty: PersonalDashboard = { needsYou: [], myTasks, projects: [], computedAt: now.toISOString() };

    // Candidates as `GET /projects` finds them (Active-dated memberships, held ones included, and current grants).
    const ids = await this.access.visibleProjectIds(user.id);
    if (ids.length === 0) return empty;
    const contexts = await loadProjectContexts(this.pool, user, ids, today);

    // canReadContent as a plain boolean (its type guard would narrow the negative case to never).
    const reads = (ctx: ProjectContext): boolean => canReadContent(ctx);
    const readable = [...contexts.values()].filter((c) => reads(c.ctx));
    const heldOnly = [...contexts.values()].filter(
      (c) => !reads(c.ctx) && c.ctx.rows.some((r) => r.userId === user.id && membershipState(r, today) === 'on_hold'),
    );
    const readableIds = readable.map((c) => c.ctx.project.id);
    const nameOf = (id: string) => contexts.get(id)?.name as string;

    const archived = await archivedAmong(this.pool, [...readable, ...heldOnly].filter((c) => c.ctx.project.status === 'closed').map((c) => c.ctx.project.id), today);
    const measures = await loadProjectMeasures(this.pool, readableIds, today, now);

    // My projects (§4.3).
    const projects: PersonalProject[] = [];
    for (const c of heldOnly) {
      if (archived.has(c.ctx.project.id) && !opts.includeArchived) continue;
      projects.push({ id: c.ctx.project.id, name: c.name, onHold: true });
    }
    for (const c of readable) {
      const id = c.ctx.project.id;
      if (archived.has(id) && !opts.includeArchived) continue;
      const m = measures.get(id) as ProjectMeasures;
      projects.push({
        id,
        name: c.name,
        onHold: false,
        archived: archived.has(id),
        header: {
          status: c.ctx.project.status,
          stage: m.stage,
          completion: m.completion,
          flags: {
            overdue: m.overdue,
            blocked: m.blocked,
            missingRole: m.flags.missingRole,
            noIndependentEscalation: m.flags.noIndependentEscalation,
            deadlineReview: m.flags.deadlineReview,
          },
        },
        expanded: {
          roles: c.ctx.roles,
          grant: c.ctx.roles.length === 0 ? (c.ctx.grantKinds[0] ?? null) : null,
          owningDepartment: c.owningDepartment,
          onTime: m.onTime,
          plannedEnd: m.plannedEnd,
          openQuestions: m.questions.open + m.questions.answered,
          significantRisks: m.risks.significant,
          nextTaskDue: m.nextTaskDue,
          link: `#/projects/${id}`,
        },
      });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    if (readableIds.length === 0) return { ...empty, projects };

    // My tasks (§4.2): projects whose content the viewer may read today.
    const taskRows = (
      await this.pool.query(
        `SELECT t.id, ${shown('t', 'task', 'title')} AS title, t.project_id AS "projectId", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn", t.status,
                t.deadline_review_required AS "deadlineReviewRequired", to_char(t.completed_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS "completedOn",
                (t.held_case_id IS NOT NULL OR ${possibleCopySql('task', 't.id')}) AS "underReview",
                pt.id AS "parentId", pt.title AS "parentTitle",
                (SELECT count(*)::int FROM tasks s WHERE s.parent_id = t.id AND ${unheldRecordSql('s')} AND s.status <> 'cancelled' AND NOT ${possibleCopySql('task', 's.id')}) AS "subtaskTotal",
                (SELECT count(*)::int FROM tasks s WHERE s.parent_id = t.id AND ${unheldRecordSql('s')} AND s.status = 'completed' AND NOT ${possibleCopySql('task', 's.id')}) AS "subtaskDone"
           FROM tasks t
           LEFT JOIN tasks pt ON pt.id = t.parent_id AND ${unheldRecordSql('pt')} AND NOT ${possibleCopySql('task', 'pt.id')}
          WHERE t.project_id = ANY($1::uuid[]) AND t.assignee_id = $2 AND ${liveRecordSql('t')}
            AND (t.status NOT IN ('completed', 'cancelled')
                 OR ($3::boolean AND t.status = 'completed' AND (t.completed_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= $4::date))
          ORDER BY t.due_on, t.id`,
        [readableIds, user.id, opts.showCompleted, addDays(today, -COMPLETED_DAYS)],
      )
    ).rows as Array<{ id: string; title: string; projectId: string; dueOn: string; status: TaskStatus; deadlineReviewRequired: boolean; completedOn: string | null; underReview: boolean; parentId: string | null; parentTitle: string | null; subtaskTotal: number; subtaskDone: number }>;
    const blockNotes = await latestBlockNotes(this.pool, taskRows.filter((r) => r.status === 'blocked' && !r.underReview).map((r) => r.id));
    // The last day of "due soon" in each project: seven days on by the project's calendar (working or calendar days).
    const calendars = await loadEffectiveMany(this.pool, readableIds);
    const soonEnds = new Map(readableIds.map((id) => [id, dueSoonEnd(today, (calendars.get(id) as Effective).cal)]));
    const taskNeeds: NeedsYouItem[] = [];
    const taskItem = (kind: 'overdue' | 'due_soon' | 'blocked', r: { id: string; title: string; projectId: string; dueOn: string }): NeedsYouItem => ({
      kind,
      projectId: r.projectId,
      projectName: nameOf(r.projectId),
      label: r.title,
      since: dayStart(r.dueOn),
      link: taskLink(r.projectId, r.id),
    });
    for (const r of taskRows) {
      const row: MyTask = {
        id: r.id,
        title: r.title,
        projectId: r.projectId,
        projectName: nameOf(r.projectId),
        dueOn: r.dueOn,
        status: r.status,
        completedOn: r.status === 'completed' ? r.completedOn : null,
        blockedReason: r.status === 'blocked' && !r.underReview ? (blockNotes.get(r.id) ?? null) : null,
        parent: r.parentId && r.parentTitle !== null ? { id: r.parentId, title: r.parentTitle } : null,
        subtasks: { done: r.subtaskDone, total: r.subtaskTotal },
      };
      if (r.status === 'completed') {
        myTasks.completed?.push(row);
        continue;
      }
      const ind = taskIndicators({ status: r.status, dueOn: r.dueOn, parentDueOn: null, assigneeActive: true, invitationStatus: null, today, deadlineReviewRequired: r.deadlineReviewRequired });
      if (ind.overdue) taskNeeds.push(taskItem('overdue', r));
      else if (isDueSoon(r, today, soonEnds.get(r.projectId) as string)) taskNeeds.push(taskItem('due_soon', r));
      if (ind.deadlineReviewRequired) myTasks.awaitingReview.push(row);
      else if (ind.overdue) myTasks.overdue.push({ ...row, overdueDays: daysBetween(r.dueOn, today) });
      else if (r.dueOn <= (soonEnds.get(r.projectId) as string)) myTasks.dueSoon.push(row);
      else myTasks.later.push(row);
    }
    if (myTasks.completed) {
      const completedOn = new Map(taskRows.map((r) => [r.id, r.completedOn ?? '']));
      myTasks.completed.sort((a, b) => (completedOn.get(b.id) as string).localeCompare(completedOn.get(a.id) as string) || a.id.localeCompare(b.id));
    }

    const needsYou = [
      ...(await this.approvals(user, readable.map((c) => c.ctx), today, nameOf)),
      ...(await this.minutes(readable.map((c) => c.ctx), nameOf)),
      ...(await this.questions(user, readableIds, nameOf)),
      ...(await this.copies(readable.map((c) => c.ctx), nameOf)),
      ...(await this.deadlineReviews(readable.map((c) => c.ctx), nameOf)),
      ...(await this.resourcesPastNeededBy(readable.map((c) => c.ctx), today, nameOf)),
      ...taskNeeds,
      ...(await this.blocked(user, readable.map((c) => c.ctx))).map((r) => taskItem('blocked', r)),
      ...(await this.riskReviews(user, readableIds, soonEnds, nameOf)),
    ];
    needsYou.sort((a, b) => {
      if (a.since !== b.since) return a.since === null ? 1 : b.since === null ? -1 : a.since.localeCompare(b.since);
      return a.projectName.localeCompare(b.projectName) || a.kind.localeCompare(b.kind) || a.link.localeCompare(b.link);
    });

    return { needsYou, myTasks, projects, computedAt: now.toISOString() };
  }

  /**
   * Pending requests the viewer may approve now and has not approved: the list view's filter (`listedRequestSql`, which
   * keeps finance requests to finance readers) and its check (`changeMayApprove` with the kind's handler block, so a
   * finance request while tracking is off is not offered).
   */
  private async approvals(user: AuthUser, ctxs: ProjectContext[], today: string, nameOf: (id: string) => string): Promise<NeedsYouItem[]> {
    const mine = ctxs.filter((c) => eligibleApprovers(c).includes(user.id));
    if (mine.length === 0) return [];
    const byId = new Map(mine.map((c) => [c.project.id, c]));
    const rows = (
      await this.pool.query(
        `SELECT id, project_id AS "projectId", kind, target_kind AS "targetKind", target_id AS "targetId", batch_id AS "batchId", version,
                required_approvals AS "requiredApprovals", status, submitted_by AS "submittedBy", submitted_at AS "submittedAt",
                decided_by AS "decidedBy", decided_at AS "decidedAt", reason,
                (SELECT xi.run_id FROM extraction_items xi WHERE xi.id = change_requests.target_id) AS "runId"
           FROM change_requests
          WHERE project_id = ANY($1::uuid[]) AND status = 'pending'
            AND ${listedRequestSql(true, '$2', '$3')}
          ORDER BY submitted_at, id`,
        [[...byId.keys()], user.id, today],
      )
    ).rows as Array<RequestRow & { runId: string | null }>;
    if (rows.length === 0) return [];
    const given = groupBy(
      (
        await this.pool.query(
          `SELECT a.request_id AS "requestId", a.approver_id AS "approverId"
             FROM approvals a JOIN change_requests r ON r.id = a.request_id AND r.version = a.version
            WHERE a.request_id = ANY($1::uuid[])`,
          [rows.map((r) => r.id)],
        )
      ).rows as Array<{ requestId: string; approverId: string }>,
      (a) => a.requestId,
    );
    // What each kind's handler says about each project, asked once per project and kind.
    const blocks = new Map<string, string | null>();
    for (const r of rows) {
      const key = `${r.projectId}:${r.kind}`;
      if (!blocks.has(key)) blocks.set(key, await this.changes.handlerBlock(this.pool, byId.get(r.projectId) as ProjectContext, r.kind));
    }
    return rows
      .filter((r) =>
        changeMayApprove(byId.get(r.projectId) as ProjectContext, r, (given.get(r.id) ?? []).map((a) => a.approverId), user.id, blocks.get(`${r.projectId}:${r.kind}`) ?? null),
      )
      .map((r) => ({
        kind: 'approval' as const,
        projectId: r.projectId,
        projectName: nameOf(r.projectId),
        label: KIND_LABEL[r.kind] ?? r.kind,
        since: iso(r.submittedAt),
        link: approvalLink(r),
      }));
  }

  /** Submissions waiting for review where the viewer may publish (the `minutes.publish` check publishing uses). */
  private async minutes(ctxs: ProjectContext[], nameOf: (id: string) => string): Promise<NeedsYouItem[]> {
    const ids = ctxs.filter((c) => decide({ action: 'minutes.publish', roles: c.roles, status: c.project.status }).allowed).map((c) => c.project.id);
    if (ids.length === 0) return [];
    const rows = (
      await this.pool.query(
        `SELECT s.id, s.project_id AS "projectId",
                CASE WHEN ${possibleCopySql('source', 's.id')} THEN '${POSSIBLE_COPY_TEXT}' ELSE s.title END AS title,
                (SELECT max(v.created_at) FROM source_versions v WHERE v.source_id = s.id) AS since
           FROM sources s
          WHERE s.project_id = ANY($1::uuid[]) AND s.publication = 'submitted' AND ${liveSourceSql('s')}`,
        [ids],
      )
    ).rows as Array<{ id: string; projectId: string; title: string; since: Date | null }>;
    return rows.map((r) => ({ kind: 'minutes' as const, projectId: r.projectId, projectName: nameOf(r.projectId), label: r.title, since: iso(r.since), link: `#/notes/${r.id}` }));
  }

  /** Questions the viewer asked that are Answered, waiting for them to resolve. */
  private async questions(user: AuthUser, ids: string[], nameOf: (id: string) => string): Promise<NeedsYouItem[]> {
    const rows = (
      await this.pool.query(
        `SELECT q.id, q.project_id AS "projectId", ${shown('q', 'question', 'text')} AS text,
                COALESCE((SELECT max(a.at) FROM question_answers a WHERE a.question_id = q.id), q.authorised_at) AS since
           FROM questions q
          WHERE q.project_id = ANY($1::uuid[]) AND q.requester_id = $2 AND q.status = 'answered' AND ${liveRecordSql('q')}`,
        [ids, user.id],
      )
    ).rows as Array<{ id: string; projectId: string; text: string; since: Date }>;
    return rows.map((r) => ({
      kind: 'question' as const,
      projectId: r.projectId,
      projectName: nameOf(r.projectId),
      label: r.text,
      since: iso(r.since),
      link: `#/projects/${r.projectId}/work/${r.id}`,
    }));
  }

  /** Possible credential copies awaiting a decision, as a count per project (PM or Deputy: `quarantine.copies`). Never text. */
  private async copies(ctxs: ProjectContext[], nameOf: (id: string) => string): Promise<NeedsYouItem[]> {
    const ids = ctxs.filter((c) => decide({ action: 'quarantine.copies', roles: c.roles, status: c.project.status }).allowed).map((c) => c.project.id);
    if (ids.length === 0) return [];
    const rows = (
      await this.pool.query(
        `SELECT c.project_id AS "projectId", count(*)::int AS n, min(pc.found_at) AS since,
                (array_agg(c.id ORDER BY c.reported_at, c.id))[1] AS "caseId"
           FROM quarantine_cases c JOIN quarantine_possible_copies pc ON pc.case_id = c.id AND pc.decision IS NULL
          WHERE c.project_id = ANY($1::uuid[]) AND c.state IN ('held', 'cleaned')
          GROUP BY c.project_id`,
        [ids],
      )
    ).rows as Array<{ projectId: string; n: number; since: Date; caseId: string }>;
    return rows.map((r) => ({
      kind: 'copies' as const,
      projectId: r.projectId,
      projectName: nameOf(r.projectId),
      label: `${plural(r.n, 'possible credential copy', 'possible credential copies')} to check`,
      count: r.n,
      since: iso(r.since),
      link: `#/quarantine/cases/${r.caseId}/copies`,
    }));
  }

  /** An open deadline review (marked tasks not finished, as the review screen lists them) for the PM or a Deputy. */
  private async deadlineReviews(ctxs: ProjectContext[], nameOf: (id: string) => string): Promise<NeedsYouItem[]> {
    const ids = ctxs.filter((c) => preparesDeadlineReview(c.roles)).map((c) => c.project.id);
    if (ids.length === 0) return [];
    const rows = (
      await this.pool.query(
        `SELECT t.project_id AS "projectId", count(*)::int AS n,
                min((SELECT max(e.at) FROM task_events e WHERE e.task_id = t.id AND e.kind = 'review_required')) AS since
           FROM tasks t
          WHERE t.project_id = ANY($1::uuid[]) AND t.deadline_review_required AND t.status NOT IN ('completed', 'cancelled') AND ${liveRecordSql('t')}
          GROUP BY t.project_id`,
        [ids],
      )
    ).rows as Array<{ projectId: string; n: number; since: Date | null }>;
    return rows.map((r) => ({
      kind: 'deadline_review' as const,
      projectId: r.projectId,
      projectName: nameOf(r.projectId),
      label: `Deadline review to prepare: ${plural(r.n, 'task', 'tasks')}`,
      since: iso(r.since),
      link: `#/projects/${r.projectId}/deadline-review`,
    }));
  }

  /** Blocked tasks: the viewer's own, and every Blocked task where they are PM or a Deputy. */
  private async blocked(user: AuthUser, ctxs: ProjectContext[]): Promise<Array<{ id: string; title: string; projectId: string; dueOn: string }>> {
    const managed = ctxs.filter((c) => preparesDeadlineReview(c.roles)).map((c) => c.project.id);
    return (
      await this.pool.query(
        `SELECT t.id, ${shown('t', 'task', 'title')} AS title, t.project_id AS "projectId", to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn"
           FROM tasks t
          WHERE t.project_id = ANY($1::uuid[]) AND t.status = 'blocked' AND ${liveRecordSql('t')}
            AND (t.assignee_id = $2 OR t.project_id = ANY($3::uuid[]))
          ORDER BY t.due_on, t.id`,
        [ctxs.map((c) => c.project.id), user.id, managed],
      )
    ).rows;
  }

  /** Reviews of the viewer's unresolved risks due by the end of the project's "due soon" days, missed reviews included. */
  private async riskReviews(user: AuthUser, ids: string[], soonEnds: Map<string, string>, nameOf: (id: string) => string): Promise<NeedsYouItem[]> {
    const latest = [...soonEnds.values()].reduce((a, b) => (a > b ? a : b));
    const rows = (
      await this.pool.query(
        `SELECT r.id, ${shown('r', 'risk', 'description')} AS description, r.project_id AS "projectId", to_char(r.review_on, 'YYYY-MM-DD') AS "reviewOn"
           FROM risks r
          WHERE r.project_id = ANY($1::uuid[]) AND r.responsible_id = $2 AND r.status <> 'resolved' AND r.review_on IS NOT NULL
            AND r.review_on <= $3::date AND ${liveRecordSql('r')}
          ORDER BY r.review_on, r.id`,
        [ids, user.id, latest],
      )
    ).rows as Array<{ id: string; description: string; projectId: string; reviewOn: string }>;
    return rows
      .filter((r) => r.reviewOn <= (soonEnds.get(r.projectId) as string))
      .map((r) => ({
        kind: 'risk_review' as const,
        projectId: r.projectId,
        projectName: nameOf(r.projectId),
        label: r.description,
        since: dayStart(r.reviewOn),
        link: recordLink(r.projectId, r.id),
      }));
  }

  /** Needed lines past their needed-by date, as a count per project (PM or Deputy). */
  private async resourcesPastNeededBy(ctxs: ProjectContext[], today: string, nameOf: (id: string) => string): Promise<NeedsYouItem[]> {
    const ids = ctxs.filter((c) => preparesDeadlineReview(c.roles)).map((c) => c.project.id);
    if (ids.length === 0) return [];
    const rows = (
      await this.pool.query(
        `SELECT l.project_id AS "projectId", count(*)::int AS n, (min(l.needed_by)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') AS since
           FROM resource_lines l
          WHERE l.project_id = ANY($1::uuid[]) AND ${neededByPassedSql('l', '$2')}
          GROUP BY l.project_id`,
        [ids, today],
      )
    ).rows as Array<{ projectId: string; n: number; since: Date }>;
    return rows.map((r) => ({
      kind: 'resources' as const,
      projectId: r.projectId,
      projectName: nameOf(r.projectId),
      label: `Resources past needed-by date: ${r.n}`,
      count: r.n,
      since: iso(r.since),
      link: `#/projects/${r.projectId}/resources`,
    }));
  }
}
