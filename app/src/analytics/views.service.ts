import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import type { ProjectStatus } from '../projects/matrix';
import { DEFAULT_STATUSES, PERIODS, type Period, STATUSES } from './filters';
import { PROBLEM_KEYS } from './panels.service';
import { TREND_KEYS } from './trends.service';

/**
 * Saved analytics views (dashboards spec 7.4): an Administrator's own named filters and layout, in `analytics_views`.
 * The stored `config` is classified NO_USER_TEXT: every string that survives `normaliseViewConfig` is from a fixed list
 * below or is a UUID, so nothing a person typed is kept there. A view holds only filters and presentation; the server
 * rechecks every request, so a view can never widen what is shown. The name is the only typed text (1 to 100
 * characters, credential-checked like a reason).
 */

export const VIEW_PANELS = ['progress', 'problems', 'system', 'trends', 'resources', 'aiUsage'] as const;
type ViewPanel = (typeof VIEW_PANELS)[number];

/** The columns of the two project tables. */
export const VIEW_COLUMNS = {
  progress: ['name', 'owningDepartment', 'status', 'stage', 'completion', 'onTime', 'plannedEnd', 'overdue', 'blocked'],
  problems: ['name', 'owningDepartment', ...PROBLEM_KEYS],
} as const;
type ColumnPanel = keyof typeof VIEW_COLUMNS;

/** Each chart, switchable between chart and table. */
export const VIEW_CHARTS = ['progress.onTime', ...TREND_KEYS.map((k) => `trends.${k}`)] as readonly string[];
const CHART_MODES = ['chart', 'table'] as const;
const OWNERSHIPS = ['owned', 'contributed', 'both'] as const;

export type ViewConfig = {
  filters: { period: Period; department: string | null; status: ProjectStatus[]; ownership: (typeof OWNERSHIPS)[number]; includeArchived: boolean };
  panels: { order: ViewPanel[]; hidden: ViewPanel[] };
  columns: Record<ColumnPanel, { order: string[]; hidden: string[] }>;
  charts: Record<string, (typeof CHART_MODES)[number]>;
};

const NAME_RULE = { max: 100, refusal: 'Give the view a name (up to 100 characters).' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);

/** The known, distinct members of a list, in the order given. */
function known<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) if (typeof x === 'string' && (allowed as readonly string[]).includes(x) && !out.includes(x as T)) out.push(x as T);
  return out;
}

/** A known order first, then the rest of the defaults, so every item stays reachable. */
function ordered<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  const out = known(v, allowed);
  for (const x of allowed) if (!out.includes(x)) out.push(x);
  return out;
}

/** Validates a submitted config into a complete one: unknown keys and values are dropped (or defaulted), never kept. */
export function normaliseViewConfig(input: unknown): ViewConfig {
  const src = isObject(input) ? input : {};
  const f = isObject(src.filters) ? src.filters : {};
  const panels = isObject(src.panels) ? src.panels : {};
  const columns = isObject(src.columns) ? src.columns : {};
  const charts = isObject(src.charts) ? src.charts : {};
  const status = known(f.status, STATUSES);

  const cols = {} as ViewConfig['columns'];
  for (const p of Object.keys(VIEW_COLUMNS) as ColumnPanel[]) {
    const c = isObject(columns[p]) ? columns[p] : {};
    const allowed = VIEW_COLUMNS[p] as readonly string[];
    // The project name always shows: it is what a row is.
    cols[p] = { order: ordered(c.order, allowed), hidden: known(c.hidden, allowed).filter((k) => k !== 'name') };
  }
  const chartModes: ViewConfig['charts'] = {};
  for (const k of VIEW_CHARTS) chartModes[k] = oneOf(charts[k], CHART_MODES, 'chart');

  return {
    filters: {
      period: oneOf(f.period, PERIODS, 'last_12w'),
      department: typeof f.department === 'string' && UUID.test(f.department) ? f.department.toLowerCase() : null,
      status: status.length > 0 ? status : [...DEFAULT_STATUSES],
      ownership: oneOf(f.ownership, OWNERSHIPS, 'both'),
      includeArchived: f.includeArchived === true,
    },
    panels: { order: ordered(panels.order, VIEW_PANELS), hidden: known(panels.hidden, VIEW_PANELS) },
    columns: cols,
    charts: chartModes,
  };
}

export interface SavedView {
  id: string;
  name: string;
  config: ViewConfig;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, name, config, created_at AS "createdAt", updated_at AS "updatedAt"`;
const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === '23505';
const DUPLICATE = 'You already have a view with this name.';

@Injectable()
export class ViewsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(user: AuthUser): Promise<{ views: SavedView[] }> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM analytics_views WHERE user_id = $1 ORDER BY name, id`, [user.id]);
    return { views: rows.map(this.shape) };
  }

  async get(user: AuthUser, id: string): Promise<{ view: SavedView }> {
    if (!UUID.test(id)) throw new NotFoundException();
    const row = (await this.pool.query(`SELECT ${COLUMNS} FROM analytics_views WHERE id = $1 AND user_id = $2`, [id, user.id])).rows[0];
    if (!row) throw new NotFoundException();
    return { view: this.shape(row) };
  }

  async create(user: AuthUser, input: Record<string, unknown>): Promise<{ view: SavedView }> {
    const name = readReason(input.name, 'the view a name', NAME_RULE);
    const config = normaliseViewConfig(input.config);
    const now = this.clock();
    try {
      const row = (
        await this.pool.query(
          `INSERT INTO analytics_views (id, user_id, name, config, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING ${COLUMNS}`,
          [uuidv7(now.getTime()), user.id, name, JSON.stringify(config), now],
        )
      ).rows[0];
      return { view: this.shape(row) };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(DUPLICATE);
      throw err;
    }
  }

  async update(user: AuthUser, id: string, input: Record<string, unknown>): Promise<{ view: SavedView }> {
    if (!UUID.test(id)) throw new NotFoundException();
    const name = readReason(input.name, 'the view a name', NAME_RULE);
    const config = normaliseViewConfig(input.config);
    try {
      const row = (
        await this.pool.query(`UPDATE analytics_views SET name = $3, config = $4, updated_at = $5 WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`, [
          id, user.id, name, JSON.stringify(config), this.clock(),
        ])
      ).rows[0];
      if (!row) throw new NotFoundException();
      return { view: this.shape(row) };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(DUPLICATE);
      throw err;
    }
  }

  async remove(user: AuthUser, id: string): Promise<{ id: string }> {
    if (!UUID.test(id)) throw new NotFoundException();
    const r = await this.pool.query(`DELETE FROM analytics_views WHERE id = $1 AND user_id = $2`, [id, user.id]);
    if (r.rowCount === 0) throw new NotFoundException();
    return { id };
  }

  /** What is read back is normalised again, so a row changed outside the API still shows only known values. */
  private shape = (r: { id: string; name: string; config: unknown; createdAt: Date; updatedAt: Date }): SavedView => ({
    id: r.id,
    name: r.name,
    config: normaliseViewConfig(r.config),
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  });
}
