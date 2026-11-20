import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { type Currency, toDecimalString } from '../finance/money';
import { type ProjectFigures, loadFiguresMany } from '../finance/finance.service';
import { neededByPassedSql, overlappingLineSql } from '../resources/line-sql';
import { todayUtc8 } from '../projects/membership';
import { type AnalyticsFilters, addDays } from './filters';
import { type Scoped, selectProjects } from './scope';

/**
 * The Resources and finance panel (resources-budget spec 7). Counts, item references and summary figures only: no line
 * text, notes, entries or supplier details, so an Administrator who is not a participant learns nothing a count does not
 * say. The department, status, ownership and archived filters are the shared analytics scope; the period applies to
 * "Finished in the period" only.
 */

export interface LineRow {
  needed: number;
  arranged: number;
  inUse: number;
  finishedInPeriod: number;
  neededByPassed: number;
  overlapping: number;
}
export const LINE_ROW_KEYS = ['needed', 'arranged', 'inUse', 'finishedInPeriod', 'neededByPassed', 'overlapping'] as const;

export interface ResourcesProject extends LineRow {
  id: string;
  name: string;
  departmentId: string;
  owningDepartment: string;
}
export interface ResourcesDepartment extends LineRow {
  id: string;
  name: string;
  projects: number;
}

export interface SharedItem {
  itemId: string;
  reference: string;
  name: string;
  projects: number;
  earliestOverlap: string;
}

export interface FinanceProject {
  id: string;
  name: string;
  departmentId: string;
  owningDepartment: string;
  /** Approved budget as a decimal string, or null when Not provided. */
  budget: string | null;
  spent: string;
  percentUsed: number | null;
  overBudget: boolean;
  level: 0 | 1 | 2;
  notInTotals: { currency: Currency; amount: string }[];
}
export interface FinanceGroup {
  currency: Currency;
  projectsTracking: number;
  budgetNotProvided: number;
  totalBudget: string;
  totalSpent: string;
  atFirst: number;
  atSecond: number;
  projects: FinanceProject[];
}

export interface ResourcesPanel {
  lines: { organisation: LineRow; departments: ResourcesDepartment[]; projects: ResourcesProject[] };
  sharedItems: SharedItem[];
  finance: FinanceGroup[];
  /** In-scope projects whose financial tracking is Not required: counted apart, never as zero. */
  notRequired: number;
  computedAt: string;
}

export const RESOURCES_TABLES = ['lines', 'sharedItems', 'finance'] as const;
export type ResourcesTable = (typeof RESOURCES_TABLES)[number];

/** The line measures a drill-down can open, and the LineRow field each counts. */
export const LINE_MEASURES = {
  linesNeeded: 'needed',
  linesArranged: 'arranged',
  linesInUse: 'inUse',
  linesFinished: 'finishedInPeriod',
  linesNeededByPassed: 'neededByPassed',
  linesOverlapping: 'overlapping',
} as const satisfies Record<string, keyof LineRow>;
export type LineMeasure = keyof typeof LINE_MEASURES;

/**
 * One predicate per line measure, over `l` (a resource line) and `fin` (its latest move to Finished, lateral). Parameters:
 * `$2` today, `$3` and `$4` the period start and end (end exclusive) as timestamps.
 */
const FINISHED_JOIN = `LEFT JOIN LATERAL (SELECT e.at FROM resource_line_events e
    WHERE e.line_id = l.id AND e.kind = 'status_changed' AND e.detail -> 'next' ->> 'status' = 'finished'
    ORDER BY e.at DESC, e.id DESC LIMIT 1) fin ON true`;
const PREDICATE: Record<keyof LineRow, string> = {
  needed: `l.status = 'needed'`,
  arranged: `l.status = 'arranged'`,
  inUse: `l.status = 'in_use'`,
  finishedInPeriod: `(l.status = 'finished' AND fin.at >= $3 AND fin.at < $4)`,
  neededByPassed: neededByPassedSql('l', '$2'),
  overlapping: `(l.status <> 'cancelled' AND l.starts_on IS NOT NULL AND l.item_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM resource_lines o WHERE ${overlappingLineSql('l', 'o')}))`,
};

const periodBounds = (f: AnalyticsFilters): [Date, Date] => [new Date(`${f.from}T00:00:00+08:00`), new Date(`${addDays(f.to, 1)}T00:00:00+08:00`)];

/** The ids of one project's lines behind a count, in a stable order (the drill-down lists them). */
export async function lineIdsFor(pool: Pool, projectId: string, field: keyof LineRow, today: string, f: AnalyticsFilters): Promise<string[]> {
  const [from, to] = periodBounds(f);
  const { rows } = await pool.query(
    `SELECT l.id FROM resource_lines l ${FINISHED_JOIN} WHERE l.project_id = $1 AND ${PREDICATE[field]}
        AND $2::date IS NOT NULL AND $3::timestamptz IS NOT NULL AND $4::timestamptz IS NOT NULL -- types for parameters a predicate leaves unused
      ORDER BY l.created_at, l.id`,
    [projectId, today, from, to],
  );
  return rows.map((r) => r.id as string);
}

const zeroRow = (): LineRow => ({ needed: 0, arranged: 0, inUse: 0, finishedInPeriod: 0, neededByPassed: 0, overlapping: 0 });
const addRow = (into: LineRow, r: LineRow) => {
  for (const k of LINE_ROW_KEYS) into[k] += r[k];
};
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

@Injectable()
export class ResourcesPanelService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resources(f: AnalyticsFilters): Promise<ResourcesPanel> {
    const now = this.clock();
    const today = todayUtc8(now);
    const projects = await selectProjects(this.pool, f, today);
    const ids = projects.map((p) => p.id);
    const lines = await this.lines(projects, f, today);
    const { finance, notRequired } = await this.finance(projects);
    return { lines, sharedItems: await this.sharedItems(ids, today), finance, notRequired, computedAt: now.toISOString() };
  }

  private async lines(projects: Scoped[], f: AnalyticsFilters, today: string): Promise<ResourcesPanel['lines']> {
    const ids = projects.map((p) => p.id);
    const [from, to] = periodBounds(f);
    const counted = new Map<string, LineRow>();
    if (ids.length > 0) {
      const select = LINE_ROW_KEYS.map((k) => `count(*) FILTER (WHERE ${PREDICATE[k]})::int AS "${k}"`).join(', ');
      const { rows } = await this.pool.query(
        `SELECT l.project_id AS "projectId", ${select} FROM resource_lines l ${FINISHED_JOIN} WHERE l.project_id = ANY($1::uuid[]) GROUP BY l.project_id`,
        [ids, today, from, to],
      );
      for (const r of rows) counted.set(r.projectId as string, Object.fromEntries(LINE_ROW_KEYS.map((k) => [k, r[k] as number])) as unknown as LineRow);
    }
    const rows: ResourcesProject[] = projects.map((p) => ({
      id: p.id, name: p.name, departmentId: p.departmentId, owningDepartment: p.department, ...(counted.get(p.id) ?? zeroRow()),
    }));
    const organisation = zeroRow();
    for (const r of rows) addRow(organisation, r);
    const deptIds = new Set(projects.map((p) => p.departmentId));
    if (f.departmentId) deptIds.add(f.departmentId);
    const depts =
      deptIds.size === 0
        ? []
        : ((await this.pool.query(`SELECT id, name FROM departments WHERE id = ANY($1::uuid[])`, [[...deptIds]])).rows as { id: string; name: string }[]).sort(byName);
    const departments = depts.map((d) => {
      const own = rows.filter((r) => r.departmentId === d.id);
      const total = zeroRow();
      for (const r of own) addRow(total, r);
      return { id: d.id, name: d.name, projects: own.length, ...total };
    });
    return { organisation, departments, projects: rows };
  }

  /**
   * A catalogue item is shared when at least two projects in scope have current-or-future (not ended, not Cancelled) dated
   * lines of it whose periods overlap. `projects` counts the distinct projects in such a pair. `earliestOverlap` is the
   * later of the two start dates of the earliest overlapping pair (the first day both lines run).
   */
  private async sharedItems(ids: string[], today: string): Promise<SharedItem[]> {
    if (ids.length === 0) return [];
    const live = (a: string) => `${a}.status <> 'cancelled' AND ${a}.starts_on IS NOT NULL AND (${a}.ends_on IS NULL OR ${a}.ends_on >= $2::date)`;
    const { rows } = await this.pool.query(
      `SELECT i.id AS "itemId", i.reference, i.name, count(DISTINCT x.project_id)::int AS projects, to_char(min(x.since), 'YYYY-MM-DD') AS "earliestOverlap"
         FROM (SELECT a.item_id, a.project_id, greatest(a.starts_on, b.starts_on) AS since
                 FROM resource_lines a JOIN resource_lines b ON ${overlappingLineSql('a', 'b')}
                WHERE a.project_id = ANY($1::uuid[]) AND b.project_id = ANY($1::uuid[]) AND a.item_id IS NOT NULL
                  AND ${live('a')} AND ${live('b')}) x
         JOIN resource_items i ON i.id = x.item_id
        GROUP BY i.id, i.reference, i.name
        ORDER BY projects DESC, i.reference, i.id`,
      [ids, today],
    );
    return rows as SharedItem[];
  }

  /** Per reporting currency, never mixed; a project with tracking not Enabled is counted in `notRequired`, not as zero. */
  private async finance(projects: Scoped[]): Promise<{ finance: FinanceGroup[]; notRequired: number }> {
    const figures = await loadFiguresMany(this.pool, projects.map((p) => p.id));
    const created = new Map<string, number>();
    if (figures.size > 0) {
      const { rows } = await this.pool.query(`SELECT id, created_at AS "createdAt" FROM projects WHERE id = ANY($1::uuid[])`, [[...figures.keys()]]);
      for (const r of rows) created.set(r.id as string, new Date(r.createdAt).getTime());
    }
    const groups = new Map<Currency, Array<{ p: Scoped; f: ProjectFigures }>>();
    for (const p of projects) {
      const f = figures.get(p.id);
      if (!f) continue;
      const list = groups.get(f.currency) ?? [];
      list.push({ p, f });
      groups.set(f.currency, list);
    }
    const finance: FinanceGroup[] = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, list]) => {
        list.sort((x, y) => x.p.name.localeCompare(y.p.name) || (created.get(x.p.id) ?? 0) - (created.get(y.p.id) ?? 0) || x.p.id.localeCompare(y.p.id));
        let budget = 0n;
        let spent = 0n;
        for (const { f } of list) {
          if (f.budget !== null) budget += f.budget;
          spent += f.spent;
        }
        return {
          currency,
          projectsTracking: list.length,
          budgetNotProvided: list.filter(({ f }) => f.budget === null).length,
          totalBudget: toDecimalString(budget),
          totalSpent: toDecimalString(spent),
          atFirst: list.filter(({ f }) => f.level >= 1).length,
          atSecond: list.filter(({ f }) => f.level === 2).length,
          projects: list.map(({ p, f }) => ({
            id: p.id, name: p.name, departmentId: p.departmentId, owningDepartment: p.department,
            budget: f.budget === null ? null : toDecimalString(f.budget),
            spent: toDecimalString(f.spent),
            percentUsed: f.percentUsed,
            overBudget: f.overBudget,
            level: f.level,
            notInTotals: f.notInTotals.map((n) => ({ currency: n.currency, amount: toDecimalString(n.amount) })),
          })),
        };
      });
    return { finance, notRequired: projects.length - figures.size };
  }
}
