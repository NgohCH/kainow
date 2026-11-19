import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { type ProjectMeasures, loadProjectMeasures } from '../dashboards/measures';
import { archivedAmong } from '../dashboards/project-contexts';
import type { ProjectStatus } from '../projects/matrix';
import { todayUtc8 } from '../projects/membership';
import { type AnalyticsFilters, addDays } from './filters';

/**
 * The two current-state project panels (dashboards spec 7.2 items 1 and 2). Counts and project names only: no record
 * text, so an Administrator who is not a participant learns nothing a count does not say. Always "now": the period
 * filter touches only "in the period" counts (invitations expired).
 */

export interface ProjectRef {
  id: string;
  name: string;
}

interface Scoped {
  id: string;
  name: string;
  status: ProjectStatus;
  departmentId: string;
  department: string;
  contributing: string[];
}

export interface ProgressRow {
  id: string;
  name: string;
  departmentId: string;
  owningDepartment: string;
  status: ProjectStatus;
  stage: ProjectMeasures['stage'];
  completion: ProjectMeasures['completion'];
  onTime: ProjectMeasures['onTime'];
  plannedEnd: ProjectMeasures['plannedEnd'];
  overdue: number;
  blocked: number;
}

export interface Roll {
  id: string;
  name: string;
  /** Projects owned by this department among those shown: each project counts once, here. */
  projects: number;
  tasksDone: number;
  tasksTotal: number;
  /** Floor of done * 100 / total over eligible leaf tasks; null when nothing is measurable. */
  completionPercent: number | null;
  onTimeDue: number;
  onTimeDone: number;
  onTimeLate: number;
  onTimePercent: number | null;
  overdue: number;
  blocked: number;
  /** Other departments' projects shown here as contributed: listed apart, never added to the totals above. */
  alsoContributesTo: Array<ProjectRef & { owningDepartment: string }>;
}

export interface ProgressPanel {
  departments: Roll[];
  projects: ProgressRow[];
  nothingDue: ProjectRef[];
  computedAt: string;
}

export const PROBLEM_KEYS = [
  'overdueTasks',
  'blockedTasks',
  'openHighCriticalRisks',
  'overdueRiskReviews',
  'vacantRequiredRoles',
  'openEscalations',
  'noIndependentEscalation',
  'deadlineReviewsPending',
  'invitationsExpired',
] as const;
export type ProblemCounts = Record<(typeof PROBLEM_KEYS)[number], number>;

export interface ProblemsPanel {
  organisation: ProblemCounts;
  departments: Array<ProjectRef & ProblemCounts & { projects: number }>;
  projects: Array<ProjectRef & ProblemCounts & { departmentId: string; owningDepartment: string }>;
  computedAt: string;
}

const percentOf = (done: number, total: number) => (total === 0 ? null : Math.floor((done * 100) / total));
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

@Injectable()
export class PanelsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The projects the filters select (status, department with owned/contributed, archived), ordered by name. */
  private async scope(f: AnalyticsFilters, today: string): Promise<Scoped[]> {
    const params: unknown[] = [f.statuses];
    let dept = '';
    if (f.departmentId) {
      params.push(f.departmentId);
      const owned = 'p.owning_department_id = $2';
      const contributed = 'EXISTS (SELECT 1 FROM project_departments pd WHERE pd.project_id = p.id AND pd.department_id = $2 AND p.owning_department_id <> $2)';
      dept = ` AND (${f.ownership === 'owned' ? owned : f.ownership === 'contributed' ? contributed : `${owned} OR ${contributed}`})`;
    }
    let rows = (
      await this.pool.query(
        `SELECT p.id, p.name, p.status, p.owning_department_id AS "departmentId", d.name AS department,
                COALESCE((SELECT array_agg(pd.department_id::text) FROM project_departments pd WHERE pd.project_id = p.id AND pd.department_id <> p.owning_department_id), '{}') AS contributing
           FROM projects p JOIN departments d ON d.id = p.owning_department_id
          WHERE p.status = ANY($1::text[])${dept}`,
        params,
      )
    ).rows as Scoped[];
    if (!f.includeArchived && f.statuses.includes('closed')) {
      const archived = await archivedAmong(this.pool, rows.filter((r) => r.status === 'closed').map((r) => r.id), today);
      rows = rows.filter((r) => !archived.has(r.id));
    }
    return rows.sort(byName);
  }

  /** The owning departments of the projects shown (plus the filtered one), in name order. */
  private async deptList(projects: Scoped[], f: AnalyticsFilters): Promise<ProjectRef[]> {
    const ids = new Set(projects.map((p) => p.departmentId));
    if (f.departmentId) ids.add(f.departmentId);
    if (ids.size === 0) return [];
    const rows = (await this.pool.query(`SELECT id, name FROM departments WHERE id = ANY($1::uuid[])`, [[...ids]])).rows as ProjectRef[];
    return rows.sort(byName);
  }

  async progress(f: AnalyticsFilters): Promise<ProgressPanel> {
    const now = this.clock();
    const today = todayUtc8(now);
    const projects = await this.scope(f, today);
    const measures = await loadProjectMeasures(this.pool, projects.map((p) => p.id), today, now);
    const rows: ProgressRow[] = projects.map((p) => {
      const m = measures.get(p.id) as ProjectMeasures;
      return {
        id: p.id, name: p.name, departmentId: p.departmentId, owningDepartment: p.department, status: p.status,
        stage: m.stage, completion: m.completion, onTime: m.onTime, plannedEnd: m.plannedEnd, overdue: m.overdue, blocked: m.blocked,
      };
    });
    const depts = await this.deptList(projects, f);
    const names = new Map(depts.map((d) => [d.id, d.name]));
    const departments: Roll[] = depts.map((d) => {
      const own = rows.filter((r) => r.departmentId === d.id);
      const done = own.reduce((n, r) => n + (r.completion.state === 'measurable' ? r.completion.done : 0), 0);
      const total = own.reduce((n, r) => n + (r.completion.state === 'measurable' ? r.completion.total : 0), 0);
      const due = own.reduce((n, r) => n + (r.onTime.state === 'measured' ? r.onTime.due : 0), 0);
      const dueDone = own.reduce((n, r) => n + (r.onTime.state === 'measured' ? r.onTime.done : 0), 0);
      return {
        id: d.id, name: d.name, projects: own.length,
        tasksDone: done, tasksTotal: total, completionPercent: percentOf(done, total),
        onTimeDue: due, onTimeDone: dueDone, onTimeLate: own.reduce((n, r) => n + (r.onTime.state === 'measured' ? r.onTime.late : 0), 0),
        onTimePercent: percentOf(dueDone, due),
        overdue: own.reduce((n, r) => n + r.overdue, 0),
        blocked: own.reduce((n, r) => n + r.blocked, 0),
        alsoContributesTo: projects
          .filter((p) => p.departmentId !== d.id && p.contributing.includes(d.id))
          .map((p) => ({ id: p.id, name: p.name, owningDepartment: names.get(p.departmentId) ?? p.department })),
      };
    });
    return {
      departments,
      projects: rows,
      nothingDue: rows.filter((r) => r.onTime.state === 'nothing_due').map((r) => ({ id: r.id, name: r.name })),
      computedAt: now.toISOString(),
    };
  }

  async problems(f: AnalyticsFilters): Promise<ProblemsPanel> {
    const now = this.clock();
    const today = todayUtc8(now);
    const projects = await this.scope(f, today);
    const ids = projects.map((p) => p.id);
    const measures = await loadProjectMeasures(this.pool, ids, today, now);
    // Invitations that expired inside the period: still unanswered, expiring from 00:00 on the first day to the end of the last day (or now).
    const periodEnd = new Date(Math.min(Date.parse(`${addDays(f.to, 1)}T00:00:00+08:00`), now.getTime()));
    const expired = new Map<string, number>(
      (
        await this.pool.query(
          `SELECT project_id AS "projectId", count(*)::int AS n FROM invitations
            WHERE project_id = ANY($1::uuid[]) AND status = 'invited' AND expires_at >= $2 AND expires_at < $3 GROUP BY project_id`,
          [ids, new Date(`${f.from}T00:00:00+08:00`), periodEnd],
        )
      ).rows.map((r) => [r.projectId as string, r.n as number]),
    );
    const zero = (): ProblemCounts => Object.fromEntries(PROBLEM_KEYS.map((k) => [k, 0])) as ProblemCounts;
    const add = (into: ProblemCounts, c: ProblemCounts) => {
      for (const k of PROBLEM_KEYS) into[k] += c[k];
    };
    const rows = projects.map((p) => {
      const m = measures.get(p.id) as ProjectMeasures;
      const counts: ProblemCounts = {
        overdueTasks: m.overdue,
        blockedTasks: m.blocked,
        openHighCriticalRisks: m.risks.bySeverity.high + m.risks.bySeverity.critical,
        overdueRiskReviews: m.risks.overdueReviews,
        // The missing-role and no-independent-escalation flags are yes/no for a project: 1 or 0, so a roll-up counts projects.
        vacantRequiredRoles: m.flags.missingRole ? 1 : 0,
        openEscalations: m.flags.escalationsOpen,
        noIndependentEscalation: m.flags.noIndependentEscalation ? 1 : 0,
        deadlineReviewsPending: m.onTime.awaitingReview,
        invitationsExpired: expired.get(p.id) ?? 0,
      };
      return { id: p.id, name: p.name, departmentId: p.departmentId, owningDepartment: p.department, ...counts };
    });
    const organisation = zero();
    for (const r of rows) add(organisation, r);
    const departments = (await this.deptList(projects, f)).map((d) => {
      const counts = zero();
      const own = rows.filter((r) => r.departmentId === d.id);
      for (const r of own) add(counts, r);
      return { ...d, projects: own.length, ...counts };
    });
    return { organisation, departments, projects: rows, computedAt: now.toISOString() };
  }
}
