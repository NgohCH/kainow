import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { referenceDay } from '../dashboards/measures';
import { shown } from '../dashboards/project-dashboard.service';
import { loadProjectContexts } from '../dashboards/project-contexts';
import { liveRecordSql } from '../history/deleted-sql';
import { type ProjectContext, canReadContent } from '../projects/access.service';
import type { ProjectStatus } from '../projects/matrix';
import { todayUtc8 } from '../projects/membership';
import type { AnalyticsFilters } from './filters';
import { LinesService, type LineView } from '../resources/lines.service';
import { PROBLEM_KEYS, PanelsService, type ProgressRow } from './panels.service';
import { LINE_MEASURES, type LineMeasure, type LineRow, ResourcesPanelService, lineIdsFor } from './resources-panel';

/**
 * Drill-down (dashboards spec 7.3): organisation, then department, then project, as counts from the same panels. At
 * project level the underlying tasks or risks are listed only to an Administrator who is also a participant there (an
 * Active role or an Active grant, `canReadContent`), rechecked on every request; otherwise the reply says so in words.
 */

export const DRILL_LEVELS = ['org', 'department', 'project'] as const;
export type DrillLevel = (typeof DRILL_LEVELS)[number];

/** The measure keys the panels return: the nine problem counts and the progress measures. */
export const FINANCE_MEASURES = ['financeBudgetNotProvided', 'financeAtFirst', 'financeAtSecond'] as const;
export const DRILL_MEASURES = [...PROBLEM_KEYS, 'completion', 'onTime', 'overdue', 'blocked', ...(Object.keys(LINE_MEASURES) as LineMeasure[]), ...FINANCE_MEASURES] as const;
export type DrillMeasure = (typeof DRILL_MEASURES)[number];

export const LIMITED = 'Only counts are shown: you are not a participant in this project.';

/** A count, or for the two progress measures their parts. */
export type DrillValue = number | Record<string, number>;

export interface DrillRecord {
  id: string;
  title: string;
  assignee: string | null;
  dueOn: string | null;
  link: string;
}

export interface DrillResult {
  level: DrillLevel;
  id: string | null;
  measure: DrillMeasure;
  counts: { total: DrillValue; breakdown?: Array<{ id: string; name: string; value: DrillValue }> };
  records?: DrillRecord[];
  /** Resource line detail (the Resources tab's fields), for a participant only; never any finance detail. */
  lines?: LineView[];
  /** Finance measures: projects in this level whose financial tracking is Not required, counted apart and never as zero. */
  notRequired?: number;
  limited?: string;
  computedAt: string;
}

/** Which records a measure lists; null for the measures that are not about tasks or risks (roles, escalations, invitations). */
type Listing =
  | { kind: 'task'; where: 'overdue' | 'blocked' | 'reviewPending' | 'eligibleLeaf' | 'dueLeaf' }
  | { kind: 'risk'; where: 'significant' | 'overdueReview' }
  | { kind: 'line'; measure: LineMeasure }
  | null;

const LISTING: Record<DrillMeasure, Listing> = {
  overdueTasks: { kind: 'task', where: 'overdue' },
  overdue: { kind: 'task', where: 'overdue' },
  blockedTasks: { kind: 'task', where: 'blocked' },
  blocked: { kind: 'task', where: 'blocked' },
  deadlineReviewsPending: { kind: 'task', where: 'reviewPending' },
  completion: { kind: 'task', where: 'eligibleLeaf' },
  onTime: { kind: 'task', where: 'dueLeaf' },
  openHighCriticalRisks: { kind: 'risk', where: 'significant' },
  overdueRiskReviews: { kind: 'risk', where: 'overdueReview' },
  vacantRequiredRoles: null,
  openEscalations: null,
  noIndependentEscalation: null,
  invitationsExpired: null,
  ...(Object.fromEntries(Object.keys(LINE_MEASURES).map((m) => [m, { kind: 'line', measure: m }])) as Record<LineMeasure, Listing>),
  // Finance gives counts only, to everyone: never entries or amounts.
  financeBudgetNotProvided: null,
  financeAtFirst: null,
  financeAtSecond: null,
};

/** A live leaf: no live subtask (as `loadProjectMeasures` decides it). */
const LEAF = `NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND ${liveRecordSql('c')})`;
const TASK_WHERE: Record<Extract<Listing, { kind: 'task' }>['where'], string> = {
  // The taskIndicators rule: not finished, no deadline review pending, due before today.
  overdue: `t.status NOT IN ('completed', 'cancelled') AND NOT t.deadline_review_required AND t.due_on < :today`,
  blocked: `t.status = 'blocked'`,
  reviewPending: `${LEAF} AND t.status NOT IN ('completed', 'cancelled') AND t.deadline_review_required`,
  eligibleLeaf: `${LEAF} AND t.status <> 'cancelled'`,
  // D88: eligible leaves due before the reference day with no deadline review pending.
  dueLeaf: `${LEAF} AND t.status <> 'cancelled' AND NOT (t.status <> 'completed' AND t.deadline_review_required) AND t.due_on < :ref`,
};
const RISK_WHERE: Record<Extract<Listing, { kind: 'risk' }>['where'], string> = {
  significant: `r.status IN ('open', 'mitigating') AND r.severity IN ('high', 'critical')`,
  overdueReview: `r.status IN ('open', 'mitigating', 'accepted') AND r.review_on < :today`,
};

type Row = { id: string; name: string; departmentId: string; value: DrillValue };

function sum(values: DrillValue[], measure: DrillMeasure): DrillValue {
  if (measure !== 'completion' && measure !== 'onTime') return values.reduce<number>((n, v) => n + (v as number), 0);
  const out: Record<string, number> = {};
  for (const v of values) for (const [k, n] of Object.entries(v as Record<string, number>)) out[k] = (out[k] ?? 0) + n;
  return out;
}

const completionOf = (r: ProgressRow): Record<string, number> =>
  r.completion.state === 'measurable'
    ? { done: r.completion.done, total: r.completion.total, cancelled: r.completion.cancelled }
    : { done: 0, total: 0, cancelled: r.completion.cancelled };
const onTimeOf = (r: ProgressRow): Record<string, number> =>
  r.onTime.state === 'measured'
    ? { due: r.onTime.due, done: r.onTime.done, late: r.onTime.late, awaitingReview: r.onTime.awaitingReview }
    : { due: 0, done: 0, late: 0, awaitingReview: r.onTime.awaitingReview };

@Injectable()
export class DrillService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly panels: PanelsService,
    private readonly resources: ResourcesPanelService,
    private readonly lines: LinesService,
  ) {}

  async drill(user: AuthUser, query: { level: unknown; id: unknown; measure: unknown }, f: AnalyticsFilters): Promise<DrillResult> {
    const { level, measure } = query;
    if (typeof level !== 'string' || !(DRILL_LEVELS as readonly string[]).includes(level)) throw new BadRequestException('Choose organisation, department or project.');
    if (typeof measure !== 'string' || !(DRILL_MEASURES as readonly string[]).includes(measure)) throw new BadRequestException('Choose a measure from the panel.');
    const m = measure as DrillMeasure;
    let id: string | null = null;
    if (level !== 'org') {
      if (typeof query.id !== 'string' || !UUID.test(query.id)) throw new BadRequestException(`Choose a ${level} from the panel.`);
      id = query.id.toLowerCase();
    }

    // The same panel the Administrator is looking at, so every count here equals one there.
    const { rows, departments, computedAt, notRequired } = await this.rows(m, f);
    const nr = (pred: (r: { departmentId: string; id: string }) => boolean): { notRequired?: number } => (notRequired ? { notRequired: notRequired.filter(pred).length } : {});
    const breakdownOf = (list: Row[]) => list.map((r) => ({ id: r.id, name: r.name, value: r.value }));

    if (level === 'org') {
      const breakdown = departments.map((d) => ({ id: d.id, name: d.name, value: sum(rows.filter((r) => r.departmentId === d.id).map((r) => r.value), m) }));
      return { level, id, measure: m, counts: { total: sum(rows.map((r) => r.value), m), breakdown }, ...nr(() => true), computedAt };
    }
    if (level === 'department') {
      if (!departments.some((d) => d.id === id)) throw new NotFoundException();
      const own = rows.filter((r) => r.departmentId === id);
      return { level, id, measure: m, counts: { total: sum(own.map((r) => r.value), m), breakdown: breakdownOf(own) }, ...nr((r) => r.departmentId === id), computedAt };
    }

    const row = rows.find((r) => r.id === id);
    // A project whose financial tracking is Not required is in scope but has no finance figure: say so, never 0.
    if (!row && notRequired?.some((r) => r.id === id)) return { level: 'project', id, measure: m, counts: { total: 0 }, notRequired: 1, computedAt };
    if (!row) throw new NotFoundException();
    const out: DrillResult = { level: 'project', id, measure: m, counts: { total: row.value }, computedAt };
    const listing = LISTING[m];
    if (!listing) return out;
    // Rechecked now, from the memberships and grants as they stand.
    const today = todayUtc8(this.clock());
    const ctx = (await loadProjectContexts(this.pool, user, [row.id], today)).get(row.id)?.ctx ?? null;
    if (!this.participates(ctx)) return { ...out, limited: LIMITED };
    if (listing.kind === 'line') {
      const ids = await lineIdsFor(this.pool, row.id, LINE_MEASURES[listing.measure], today, f);
      return { ...out, lines: await this.lines.viewsFor(user, row.id, ids) };
    }
    return { ...out, records: await this.records(row.id, listing, today) };
  }

  /** canReadContent as a plain boolean: an Active role or an Active grant here. */
  private participates(ctx: ProjectContext | null): boolean {
    return canReadContent(ctx);
  }

  private async rows(m: DrillMeasure, f: AnalyticsFilters): Promise<{
    rows: Row[];
    departments: Array<{ id: string; name: string }>;
    computedAt: string;
    notRequired?: Array<{ id: string; departmentId: string }>;
  }> {
    if (m === 'completion' || m === 'onTime') {
      const p = await this.panels.progress(f);
      return {
        rows: p.projects.map((r) => ({ id: r.id, name: r.name, departmentId: r.departmentId, value: m === 'completion' ? completionOf(r) : onTimeOf(r) })),
        departments: p.departments.map((d) => ({ id: d.id, name: d.name })),
        computedAt: p.computedAt,
      };
    }
    if (m in LINE_MEASURES || (FINANCE_MEASURES as readonly string[]).includes(m)) {
      const p = await this.resources.resources(f);
      const field = (LINE_MEASURES as Record<string, keyof LineRow>)[m];
      const fin = new Map(p.finance.flatMap((g) => g.projects).map((r) => [r.id, r]));
      const finance = (id: string): number => {
        const r = fin.get(id);
        if (!r) return 0;
        return m === 'financeBudgetNotProvided' ? (r.budget === null ? 1 : 0) : m === 'financeAtFirst' ? (r.level >= 1 ? 1 : 0) : r.level === 2 ? 1 : 0;
      };
      // Finance rows are the tracked projects only; the others are returned apart as Not required.
      const projects = field ? p.lines.projects : p.lines.projects.filter((r) => fin.has(r.id));
      return {
        rows: projects.map((r) => ({ id: r.id, name: r.name, departmentId: r.departmentId, value: field ? r[field] : finance(r.id) })),
        departments: p.lines.departments.map((d) => ({ id: d.id, name: d.name })),
        computedAt: p.computedAt,
        ...(field ? {} : { notRequired: p.lines.projects.filter((r) => !fin.has(r.id)).map((r) => ({ id: r.id, departmentId: r.departmentId })) }),
      };
    }
    const key = (m === 'overdue' ? 'overdueTasks' : m === 'blocked' ? 'blockedTasks' : m) as (typeof PROBLEM_KEYS)[number];
    const p = await this.panels.problems(f);
    return {
      rows: p.projects.map((r) => ({ id: r.id, name: r.name, departmentId: r.departmentId, value: r[key] })),
      departments: p.departments.map((d) => ({ id: d.id, name: d.name })),
      computedAt: p.computedAt,
    };
  }

  /** The live tasks or risks behind a count, as the Work tab shows them (a cleaned held record shows its label). */
  private async records(projectId: string, listing: Exclude<NonNullable<Listing>, { kind: 'line' }>, today: string): Promise<DrillRecord[]> {
    const params: unknown[] = [projectId];
    // Binds the :today and :ref days a condition uses (an unused parameter would have no type).
    const bind = async (where: string): Promise<string> => {
      let out = where;
      if (out.includes(':today')) {
        params.push(today);
        out = out.replace(/:today/g, `$${params.length}::date`);
      }
      if (out.includes(':ref')) {
        params.push(await this.referenceDay(projectId, today));
        out = out.replace(/:ref/g, `$${params.length}::date`);
      }
      return out;
    };
    const sql =
      listing.kind === 'task'
        ? `SELECT t.id, ${shown('t', 'task', 'title')} AS title, u.display_name AS assignee, to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn"
             FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
            WHERE t.project_id = $1 AND ${liveRecordSql('t')} AND ${await bind(TASK_WHERE[listing.where])}
            ORDER BY t.due_on, t.id`
        : `SELECT r.id, ${shown('r', 'risk', 'description')} AS title, u.display_name AS assignee, to_char(r.review_on, 'YYYY-MM-DD') AS "dueOn"
             FROM risks r LEFT JOIN users u ON u.id = r.responsible_id
            WHERE r.project_id = $1 AND ${liveRecordSql('r')} AND ${await bind(RISK_WHERE[listing.where])}
            ORDER BY r.review_on NULLS LAST, r.id`;
    const rows = (await this.pool.query(sql, params)).rows as Array<Omit<DrillRecord, 'link'>>;
    return rows.map((r) => ({ ...r, link: `#/projects/${projectId}/work/${r.id}` }));
  }

  /** The On-time reference day (today, or the deferral or closing day), as the measures work it out. */
  private async referenceDay(projectId: string, today: string): Promise<string> {
    const day = (to: string) => `(SELECT to_char(tr.at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') FROM project_transitions tr WHERE tr.project_id = p.id AND tr.to_status = '${to}' ORDER BY tr.at DESC, tr.id DESC LIMIT 1)`;
    const p = (await this.pool.query(`SELECT p.status, ${day('deferred')} AS "deferredOn", ${day('closed')} AS "closedOn" FROM projects p WHERE p.id = $1`, [projectId])).rows[0] as {
      status: ProjectStatus; deferredOn: string | null; closedOn: string | null;
    };
    return referenceDay({ status: p.status, today, deferredOn: p.deferredOn, closedOn: p.closedOn });
  }
}
