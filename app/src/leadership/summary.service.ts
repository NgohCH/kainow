import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { loadFiguresMany } from '../finance/finance.service';
import { toDecimalString } from '../finance/money';
import { neededByPassedSql } from '../resources/line-sql';
import { liveRecordSql } from '../history/deleted-sql';
import { type ProjectMeasures, type Severity, loadProjectMeasures } from '../dashboards/measures';
import { archivedAmong, groupBy, loadProjectContexts } from '../dashboards/project-contexts';
import { shown } from '../dashboards/project-dashboard.service';
import { PreferencesService } from '../dashboards/preferences.service';
import { canReadContent } from '../projects/access.service';
import { type ProjectStatus } from '../projects/matrix';
import { membershipState, todayUtc8 } from '../projects/membership';
import { leadershipProjectIds } from './grants';
import { LEADERSHIP_FIELDS } from './leadership-fields';

const STATUSES: readonly ProjectStatus[] = ['draft', 'planned', 'active', 'deferred', 'closed'];
const DEFAULT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'deferred'];
const RISK_CUT = 120;

export interface SignificantRisk {
  description: string;
  severity: Severity;
  reviewOn: string | null;
}

/** A card holds only catalogue fields (the viewer's chosen ones), plus its id and whether the viewer may open the project. */
export type LeadershipCard = { id: string; link: boolean } & Record<string, unknown>;

export interface LeadershipSummary {
  /** The visible fields, in the viewer's order. */
  fields: Array<{ key: string; label: string }>;
  cards: LeadershipCard[];
  departments: Array<{ id: string; name: string }>;
  computedAt: string;
}

export interface ResourcesValue {
  needed: number;
  arranged: number;
  inUse: number;
  neededByPassed: number;
}

/** The budget field: the permitted summary (O14), figures only: no entries, references, notes, item names or reasons. */
function budgetValue(f: Awaited<ReturnType<typeof loadFiguresMany>> extends Map<string, infer V> ? V | undefined : never): unknown {
  if (!f) return { tracking: 'not_required' };
  return {
    tracking: 'enabled',
    currency: f.currency,
    budget: f.budget === null ? null : toDecimalString(f.budget),
    spent: toDecimalString(f.spent),
    percentUsed: f.percentUsed,
    level: f.level,
    overBudget: f.overBudget,
  };
}

/** A description cut to 120 characters, with an ellipsis only when something was cut. */
export function cutDescription(text: string): string {
  const chars = Array.from(text);
  return chars.length <= RISK_CUT ? text : `${chars.slice(0, RISK_CUT).join('')}…`;
}

/**
 * `GET /dashboard/leadership` (dashboards spec 6.2, D89): the projects inside the viewer's leadership grants as summary
 * cards. A grant gives these fields only: no project access, so a card links only when the viewer already reads the project.
 */
@Injectable()
export class LeadershipSummaryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly preferences: PreferencesService,
  ) {}

  async hasGrant(user: AuthUser): Promise<boolean> {
    return (await leadershipProjectIds(this.pool, user.id, todayUtc8(this.clock()))) !== null;
  }

  async get(user: AuthUser, query: { status?: string; department?: string; includeArchived?: boolean }): Promise<LeadershipSummary> {
    const now = this.clock();
    const today = todayUtc8(now);
    const scope = await leadershipProjectIds(this.pool, user.id, today);
    if (scope === null) throw new NotFoundException();

    const statuses = parseStatuses(query.status);
    if (query.department !== undefined && !UUID.test(query.department)) throw new BadRequestException('Choose a department from the list.');

    const prefs = await this.preferences.get(user);
    const shownKeys = prefs.leadership.fields.order.filter((k) => !prefs.leadership.fields.hidden.includes(k));
    const fields = shownKeys.map((key) => LEADERSHIP_FIELDS.find((f) => f.key === key)).filter((f): f is (typeof LEADERSHIP_FIELDS)[number] => f !== undefined);

    const empty: LeadershipSummary = { fields: fields.map(({ key, label }) => ({ key, label })), cards: [], departments: [], computedAt: now.toISOString() };
    if (scope.length === 0) return empty;

    const projects = (
      await this.pool.query(
        `SELECT p.id, p.name, p.status, p.owning_department_id AS "owningDepartmentId", d.name AS "owningDepartment",
                COALESCE((SELECT array_agg(cd.name ORDER BY lower(cd.name), cd.id) FROM project_departments pd JOIN departments cd ON cd.id = pd.department_id
                           WHERE pd.project_id = p.id), '{}') AS contributing
           FROM projects p JOIN departments d ON d.id = p.owning_department_id WHERE p.id = ANY($1::uuid[])`,
        [scope],
      )
    ).rows as Array<{ id: string; name: string; status: ProjectStatus; owningDepartmentId: string; owningDepartment: string; contributing: string[] }>;

    // The department filter offers only departments that own a project in scope.
    const departments = [...new Map(projects.map((p) => [p.owningDepartmentId, p.owningDepartment])).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    let picked = projects.filter((p) => statuses.includes(p.status) && (query.department === undefined || p.owningDepartmentId === query.department));
    if (statuses.includes('closed') && !query.includeArchived) {
      const archived = await archivedAmong(this.pool, picked.filter((p) => p.status === 'closed').map((p) => p.id), today);
      picked = picked.filter((p) => !archived.has(p.id));
    }
    picked.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (picked.length === 0) return { ...empty, departments };

    const ids = picked.map((p) => p.id);
    const measures = await loadProjectMeasures(this.pool, ids, today, now);
    const contexts = await loadProjectContexts(this.pool, user, ids, today);
    const risks = groupBy(await this.significantRisks(ids), (r) => r.projectId);

    const wants = (k: string) => shownKeys.includes(k);
    const lineCounts = wants('resources') ? await this.lineCounts(ids, today) : new Map<string, ResourcesValue>();
    const figs = wants('budget') ? await loadFiguresMany(this.pool, ids) : new Map();

    const cards = picked.map((p) => {
      const m = measures.get(p.id) as ProjectMeasures;
      const ctx = contexts.get(p.id)?.ctx;
      const pm = ctx?.rows.find((r) => r.role === 'pm' && membershipState(r, today) === 'active');
      const values: Record<string, unknown> = {
        name: p.name,
        owningDepartment: p.owningDepartment,
        contributingDepartments: p.contributing,
        projectManager: pm?.displayName ?? null,
        status: p.status,
        stage: m.stage,
        taskCompletion: m.completion,
        onTime: m.onTime,
        plannedEnd: m.plannedEnd,
        overdue: m.overdue,
        blocked: m.blocked,
        significantRisks: {
          count: m.risks.significant,
          items: (risks.get(p.id) ?? []).map((r) => ({ description: cutDescription(r.description), severity: r.severity, reviewOn: r.reviewOn })),
        },
        resources: lineCounts.get(p.id) ?? { needed: 0, arranged: 0, inUse: 0, neededByPassed: 0 },
        budget: budgetValue(figs.get(p.id)),
        nextDates: { nextTaskDue: m.nextTaskDue, nextRiskReview: m.nextRiskReview },
        attentionFlags: { missingRole: m.flags.missingRole, noIndependentEscalation: m.flags.noIndependentEscalation, deadlineReview: m.flags.deadlineReview },
        refresh: now.toISOString(),
      };
      const card: LeadershipCard = { id: p.id, link: ctx ? canReadContent(ctx) : false };
      for (const f of fields) card[f.key] = values[f.key];
      return card;
    });

    return { fields: empty.fields, cards, departments, computedAt: now.toISOString() };
  }

  /** Per project counts of Needed, Arranged and In use lines, and Needed lines past their needed-by date. No line detail. */
  private async lineCounts(ids: string[], today: string): Promise<Map<string, ResourcesValue>> {
    const rows = (
      await this.pool.query(
        `SELECT l.project_id AS "projectId",
                (count(*) FILTER (WHERE l.status = 'needed'))::int AS needed,
                (count(*) FILTER (WHERE l.status = 'arranged'))::int AS arranged,
                (count(*) FILTER (WHERE l.status = 'in_use'))::int AS "inUse",
                (count(*) FILTER (WHERE ${neededByPassedSql('l', '$2')}))::int AS "neededByPassed"
           FROM resource_lines l WHERE l.project_id = ANY($1::uuid[]) GROUP BY l.project_id`,
        [ids, today],
      )
    ).rows as Array<ResourcesValue & { projectId: string }>;
    return new Map(rows.map(({ projectId, ...v }) => [projectId, v]));
  }

  /** Open High and Critical risks, live records only (a cleaned held one shows its label), most severe first. */
  private async significantRisks(ids: string[]) {
    return (
      await this.pool.query(
        `SELECT r.project_id AS "projectId", ${shown('r', 'risk', 'description')} AS description, r.severity,
                to_char(r.review_on, 'YYYY-MM-DD') AS "reviewOn"
           FROM risks r
          WHERE r.project_id = ANY($1::uuid[]) AND r.status IN ('open', 'mitigating') AND r.severity IN ('high', 'critical') AND ${liveRecordSql('r')}
          ORDER BY CASE r.severity WHEN 'critical' THEN 0 ELSE 1 END, r.review_on NULLS LAST, r.id`,
        [ids],
      )
    ).rows as Array<{ projectId: string; description: string; severity: Severity; reviewOn: string | null }>;
  }
}

/** `?status=` is a comma list of project statuses; absent or empty gives the default (Planned, Active, Deferred). */
function parseStatuses(raw: string | undefined): readonly ProjectStatus[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_STATUSES;
  const list = raw.split(',').map((s) => s.trim());
  if (!list.every((s): s is ProjectStatus => (STATUSES as readonly string[]).includes(s))) throw new BadRequestException('Choose project statuses from the list.');
  return [...new Set(list)] as ProjectStatus[];
}
