import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason, refuseSecretsIn } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { loadProjectContexts } from '../dashboards/project-contexts';
import { liveRecordSql } from '../history/deleted-sql';
import { ProjectAccess, type ProjectContext } from '../projects/access.service';
import { type ProjectRole, membershipState, todayUtc8 } from '../projects/membership';
import { financeSummaryFor } from '../finance/finance.service';
import { neededByPassedSql, overlappingLineSql } from './line-sql';
import { LINE_STATUSES, type LineStatus, ONE_OFF_KINDS, UNITS } from './vocabulary';

type Db = Pool | PoolClient;

export type Overlap = { named: { projectId: string; name: string }[]; others: number };

export type LineView = {
  id: string;
  item: { id: string; kind: string; reference: string; name: string; category: string | null; retired: boolean } | null;
  oneOffKind: string | null;
  description: string;
  /** numeric(14,2) as Postgres writes it: always two decimals ("2.00"). */
  quantity: string | null;
  unit: string | null;
  startsOn: string | null;
  endsOn: string | null;
  neededBy: string | null;
  notes: string;
  status: LineStatus;
  neededByPassed: boolean;
  /** Null for a one-off line or a line with no start (spec 3.3). */
  overlap: Overlap | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PersonRow = { userId: string; name: string; department: string | null; roles: string[]; openTasks: number; overdue: number };

const ITEM = 'Choose an active catalogue item.';
const CHOOSE = 'Choose a catalogue item or describe a one-off resource.';
const ONE_OFF_KIND = 'Choose Equipment, Facility or Other.';
const DESCRIPTION = 'Enter a description of 1 to 200 characters.';
const NOTES = 'Notes can be up to 2,000 characters.';
const QUANTITY = 'Enter a quantity above 0 with at most 2 decimal places.';
const UNIT = 'Choose a unit from the list.';
const BOTH = 'Enter both a quantity and a unit, or neither.';
const DATE = 'Enter dates as YYYY-MM-DD.';
const START_FIRST = 'Enter a start date for the period.';
const END_BEFORE_START = 'The end date cannot be before the start date.';
const CANCELLED = 'This line is cancelled.';
const USE_CANCEL = 'Use Cancel to cancel a line.';
const STATUS = 'Choose a status from the list.';
const NOT_FOUND = 'That line was not found.';
const CANCEL_REASON = 'Give a reason for cancelling (up to 1,000 characters).';
const ROLE_ORDER: ProjectRole[] = ['pm', 'deputy_pm', 'owner', 'sponsor', 'member'];
const OPEN_TASK = `('not_started', 'in_progress', 'blocked')`;

/** The fields a person sets on a line; the event detail carries them under these names. */
export type Values = {
  itemId: string | null;
  oneOffKind: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  startsOn: string | null;
  endsOn: string | null;
  neededBy: string | null;
  notes: string;
};
const FIELDS: (keyof Values)[] = ['itemId', 'oneOffKind', 'description', 'quantity', 'unit', 'startsOn', 'endsOn', 'neededBy', 'notes'];
export const EMPTY: Values = { itemId: null, oneOffKind: null, description: '', quantity: null, unit: null, startsOn: null, endsOn: null, neededBy: null, notes: '' };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const blank = (v: unknown) => v === null || (typeof v === 'string' && v.trim() === '');

function readDate(v: unknown): string | null {
  if (blank(v)) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new BadRequestException(DATE);
  const s = v.trim();
  const d = new Date(`${s}T00:00:00Z`);
  // Year 0000 parses in JavaScript but not in Postgres (no year 0): refused here, not a 500 from the insert.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s || s.startsWith('0000')) throw new BadRequestException(DATE);
  return s;
}

/** "3.5" → "3.50", "007" → "7.00": the form Postgres returns for numeric(14,2), so values compare as stored. */
function readQuantity(raw: string): string {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) throw new BadRequestException(QUANTITY);
  const [whole, frac = ''] = raw.split('.');
  const value = `${whole.replace(/^0+(?=\d)/, '')}.${frac.padEnd(2, '0')}`;
  if (/^0\.00$/.test(value)) throw new BadRequestException(QUANTITY);
  return value;
}

/**
 * The line's values with the given fields replaced (a field left out keeps its value; null or empty clears an optional
 * one), checked against spec 3.2. Choosing a catalogue item makes the line a catalogue line, and a one-off kind a one-off.
 */
export function mergeLineValues(previous: Values, input: unknown): Values {
  const b = obj(input);
  const v: Values = { ...previous };
  const itemGiven = b.itemId !== undefined && b.itemId !== null;
  const kindGiven = b.oneOffKind !== undefined && b.oneOffKind !== null;
  if (itemGiven && kindGiven) throw new BadRequestException(CHOOSE);
  if (itemGiven) {
    if (typeof b.itemId !== 'string' || !UUID.test(b.itemId)) throw new BadRequestException(ITEM);
    v.itemId = b.itemId;
    v.oneOffKind = null;
    v.description = '';
  }
  if (kindGiven) {
    if (typeof b.oneOffKind !== 'string' || !(ONE_OFF_KINDS as readonly string[]).includes(b.oneOffKind)) throw new BadRequestException(ONE_OFF_KIND);
    v.oneOffKind = b.oneOffKind;
    v.itemId = null;
  }
  if (v.itemId === null && v.oneOffKind === null) throw new BadRequestException(CHOOSE);
  if (v.oneOffKind !== null && b.description !== undefined) {
    if (b.description !== null && typeof b.description !== 'string') throw new BadRequestException(DESCRIPTION);
    v.description = typeof b.description === 'string' ? b.description.trim() : '';
  }
  if (v.oneOffKind !== null && (v.description.length < 1 || v.description.length > 200)) throw new BadRequestException(DESCRIPTION);

  let quantity: string | null = v.quantity;
  if (b.quantity !== undefined) {
    if (blank(b.quantity)) quantity = null;
    else if (typeof b.quantity === 'number' && Number.isFinite(b.quantity)) quantity = String(b.quantity);
    else if (typeof b.quantity === 'string') quantity = b.quantity.trim();
    else throw new BadRequestException(QUANTITY);
  }
  if (b.unit !== undefined) v.unit = blank(b.unit) ? null : (b.unit as string);
  if ((quantity === null) !== (v.unit === null)) throw new BadRequestException(BOTH);
  v.quantity = quantity === null || quantity === previous.quantity ? quantity : readQuantity(quantity);
  if (v.unit !== null && (typeof v.unit !== 'string' || !Object.prototype.hasOwnProperty.call(UNITS, v.unit))) throw new BadRequestException(UNIT);

  if (b.startsOn !== undefined) v.startsOn = readDate(b.startsOn);
  if (b.endsOn !== undefined) v.endsOn = readDate(b.endsOn);
  if (b.neededBy !== undefined) v.neededBy = readDate(b.neededBy);
  if (v.endsOn !== null && v.startsOn === null) throw new BadRequestException(START_FIRST);
  if (v.endsOn !== null && v.startsOn !== null && v.endsOn < v.startsOn) throw new BadRequestException(END_BEFORE_START);

  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== 'string') throw new BadRequestException(NOTES);
    v.notes = typeof b.notes === 'string' ? b.notes.trim() : '';
  }
  if (v.notes.length > 2000) throw new BadRequestException(NOTES);
  return v;
}

/**
 * D91: for each line, the other projects with a non-Cancelled line of the same catalogue item whose period overlaps
 * (the SQL mirrors `spansOverlap`: both starts present, inclusive, a null end runs forever). A project the viewer can
 * open (`ProjectAccess.context` succeeds: participant, grant holder or Administrator) is named; the rest are counted.
 * Each project counts once. Nothing of the other line (quantity, notes, status) leaves this function.
 * Lines with no item or no start get null; a Cancelled line overlaps nothing.
 */
export async function overlapsFor(
  db: Db,
  access: ProjectAccess,
  user: AuthUser,
  lines: { id: string; itemId: string | null; startsOn: string | null }[],
  visible: Map<string, boolean> = new Map(),
): Promise<Map<string, Overlap | null>> {
  const out = new Map<string, Overlap | null>();
  const eligible = lines.filter((l) => l.itemId !== null && l.startsOn !== null);
  for (const l of lines) out.set(l.id, null);
  for (const l of eligible) out.set(l.id, { named: [], others: 0 });
  if (eligible.length === 0) return out;
  const { rows } = await db.query(
    `SELECT DISTINCT mine.id AS "lineId", o.project_id AS "projectId", p.name, p.created_at
       FROM resource_lines mine
       JOIN resource_lines o ON ${overlappingLineSql('mine', 'o')}
       JOIN projects p ON p.id = o.project_id
      WHERE mine.id = ANY($1::uuid[]) AND mine.status <> 'cancelled' AND mine.starts_on IS NOT NULL
      ORDER BY p.name, p.created_at, o.project_id, mine.id`,
    [eligible.map((l) => l.id)],
  );
  // Which of the overlapping projects the viewer may open, by the rule `ProjectAccess.context` applies (an Active role, a
  // grant giving access or the Administrator), from three batched queries however many projects overlap (a line can
  // overlap dozens; one check per project fanned out across the pool).
  const unseen = [...new Set((rows as { projectId: string }[]).map((r) => r.projectId))].filter((id) => !visible.has(id));
  if (unseen.length > 0) {
    const contexts = await loadProjectContexts(db, user, unseen, access.today());
    for (const id of unseen) {
      const ctx = contexts.get(id)?.ctx;
      visible.set(id, !!ctx && (ctx.roles.length > 0 || ctx.isAdmin || ctx.grantKinds.length > 0));
    }
  }
  for (const r of rows as { lineId: string; projectId: string; name: string }[]) {
    const canSee = visible.get(r.projectId);
    const overlap = out.get(r.lineId) as Overlap;
    if (canSee) overlap.named.push({ projectId: r.projectId, name: r.name });
    else overlap.others += 1;
  }
  return out;
}

const LINE_SELECT = `
  SELECT l.id, l.item_id AS "itemId", i.kind AS "itemKind", i.reference AS "itemReference", i.name AS "itemName",
         c.name AS "itemCategory", i.status AS "itemStatus", l.one_off_kind AS "oneOffKind", l.description,
         l.quantity::text AS quantity, l.unit, to_char(l.starts_on, 'YYYY-MM-DD') AS "startsOn",
         to_char(l.ends_on, 'YYYY-MM-DD') AS "endsOn", to_char(l.needed_by, 'YYYY-MM-DD') AS "neededBy", l.notes, l.status,
         ${neededByPassedSql('l', '$2')} AS "neededByPassed",
         l.created_at AS "createdAt", l.updated_at AS "updatedAt"
    FROM resource_lines l
    LEFT JOIN resource_items i ON i.id = l.item_id
    LEFT JOIN resource_categories c ON c.id = i.category_id
   WHERE l.project_id = $1`;
const LINE_ORDER = `ORDER BY l.needed_by NULLS LAST, l.starts_on NULLS LAST, coalesce(i.reference, l.description), l.created_at, l.id`;

function lineEvent(c: PoolClient, lineId: string, kind: string, user: AuthUser, at: Date, reason: string | null, detail: unknown) {
  return c.query(`INSERT INTO resource_line_events (id, line_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    uuidv7(at.getTime()), lineId, kind, user.id, at, reason, JSON.stringify(detail),
  ]);
}

/** Writes a new Needed line from checked values, with its first event. */
export async function insertLine(c: PoolClient, id: string, projectId: string, v: Values, user: AuthUser, at: Date): Promise<void> {
  await c.query(
    `INSERT INTO resource_lines (id, project_id, item_id, one_off_kind, description, quantity, unit, starts_on, ends_on, needed_by, notes, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
    [id, projectId, v.itemId, v.oneOffKind, v.description, v.quantity, v.unit, v.startsOn, v.endsOn, v.neededBy, v.notes, user.id, at],
  );
  await lineEvent(c, id, 'created', user, at, null, { previous: null, next: { ...v, status: 'needed' } });
}

type LineRow = Omit<LineView, 'item' | 'overlap'> & {
  itemId: string | null;
  itemKind: string | null;
  itemReference: string | null;
  itemName: string | null;
  itemCategory: string | null;
  itemStatus: string | null;
};

@Injectable()
export class LinesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  private today(): string {
    return todayUtc8(this.now());
  }

  private async views(db: Db, user: AuthUser, projectId: string, lineId: string | null, visible = new Map<string, boolean>()): Promise<LineView[]> {
    const { rows } = await db.query(`${LINE_SELECT} ${lineId ? 'AND l.id = $3' : ''} ${LINE_ORDER}`, lineId ? [projectId, this.today(), lineId] : [projectId, this.today()]);
    const lines = rows as LineRow[];
    const overlaps = await overlapsFor(db, this.access, user, lines, visible);
    return lines.map(({ itemId, itemKind, itemReference, itemName, itemCategory, itemStatus, ...l }) => ({
      id: l.id,
      item: itemId
        ? { id: itemId, kind: itemKind as string, reference: itemReference as string, name: itemName as string, category: itemCategory, retired: itemStatus === 'retired' }
        : null,
      oneOffKind: l.oneOffKind,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      startsOn: l.startsOn,
      endsOn: l.endsOn,
      neededBy: l.neededBy,
      notes: l.notes,
      status: l.status,
      neededByPassed: l.neededByPassed,
      overlap: overlaps.get(l.id) ?? null,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    }));
  }

  /** A project's lines by id, as the Resources tab shows them (overlap names only for projects `user` can open). For analytics drill-down. */
  async viewsFor(user: AuthUser, projectId: string, ids: string[]): Promise<LineView[]> {
    const wanted = new Set(ids);
    return (await this.views(this.pool, user, projectId, null)).filter((l) => wanted.has(l.id));
  }

  private async one(db: Db, user: AuthUser, projectId: string, lineId: string): Promise<LineView> {
    const [line] = await this.views(db, user, projectId, lineId);
    if (!line) throw new NotFoundException(NOT_FOUND);
    return line;
  }

  /** Active participants: roles, department (not recorded per person in V1.0, so null), open live assigned tasks and overdue among them. */
  private async people(ctx: ProjectContext): Promise<PersonRow[]> {
    const today = this.today();
    const roles = new Map<string, Set<ProjectRole>>();
    for (const r of ctx.rows) {
      if (membershipState(r, today) !== 'active') continue;
      if (!roles.has(r.userId)) roles.set(r.userId, new Set());
      roles.get(r.userId)?.add(r.role);
    }
    if (roles.size === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT u.id AS "userId", u.display_name AS name,
              count(t.id)::int AS "openTasks", (count(t.id) FILTER (WHERE t.due_on < $3::date))::int AS overdue
         FROM users u
         LEFT JOIN tasks t ON t.assignee_id = u.id AND t.project_id = $2 AND t.status IN ${OPEN_TASK} AND ${liveRecordSql('t')}
        WHERE u.id = ANY($1::uuid[])
        GROUP BY u.id
        ORDER BY u.display_name, u.created_at, u.id`,
      [[...roles.keys()], ctx.project.id, today],
    );
    return rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      department: null,
      roles: ROLE_ORDER.filter((role) => roles.get(r.userId)?.has(role)),
      openTasks: r.openTasks,
      overdue: r.overdue,
    }));
  }

  async list(user: AuthUser, projectId: string) {
    const ctx = await this.access.authorize(user, 'resource.view', projectId);
    const computedAt = this.now();
    const lines = await this.views(this.pool, user, projectId, null);
    const counts = Object.fromEntries(Object.keys(LINE_STATUSES).map((s) => [s, 0])) as Record<LineStatus, number>;
    for (const l of lines) counts[l.status] += 1;
    return { lines, counts, people: await this.people(ctx), finance: await this.finance(ctx, projectId), computedAt };
  }

  /** The finance block (one code path with the project dashboard). */
  private finance(ctx: ProjectContext, projectId: string) {
    return financeSummaryFor(this.pool, ctx, projectId);
  }

  async history(user: AuthUser, projectId: string, lineId: string) {
    await this.access.authorize(user, 'resource.view', projectId);
    const found = await this.pool.query(`SELECT 1 FROM resource_lines WHERE id = $1 AND project_id = $2`, [lineId, projectId]);
    if (found.rows.length === 0) throw new NotFoundException(NOT_FOUND);
    const { rows } = await this.pool.query(
      `SELECT e.id, e.kind, e.at, e.actor_id AS "actorId", u.display_name AS actor, e.reason, e.detail
         FROM resource_line_events e JOIN users u ON u.id = e.actor_id
        WHERE e.line_id = $1
        ORDER BY e.at, e.id`,
      [lineId],
    );
    return { events: rows };
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private event(c: PoolClient, lineId: string, kind: string, user: AuthUser, at: Date, reason: string | null, detail: unknown) {
    return lineEvent(c, lineId, kind, user, at, reason, detail);
  }

  private async requireActiveItem(c: PoolClient, itemId: string): Promise<void> {
    const { rows } = await c.query(`SELECT 1 FROM resource_items WHERE id = $1 AND status = 'active'`, [itemId]);
    if (rows.length === 0) throw new BadRequestException(ITEM);
  }

  /** The line's values and status, locked for the rest of the transaction; 404 outside this project. */
  private async lockLine(c: PoolClient, projectId: string, lineId: string): Promise<Values & { status: LineStatus }> {
    const { rows } = await c.query(
      `SELECT item_id AS "itemId", one_off_kind AS "oneOffKind", description, quantity::text AS quantity, unit,
              to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn",
              to_char(needed_by, 'YYYY-MM-DD') AS "neededBy", notes, status
         FROM resource_lines WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [lineId, projectId],
    );
    if (!rows[0]) throw new NotFoundException(NOT_FOUND);
    return rows[0];
  }

  async create(user: AuthUser, projectId: string, body: unknown): Promise<LineView> {
    const b = obj(body);
    const at = this.now();
    const id = uuidv7(at.getTime());
    await this.tx(async (c) => {
      await this.access.authorize(user, 'resource.edit', projectId, c, true);
      refuseSecretsIn([b.description, b.notes]);
      const v = mergeLineValues(EMPTY, b);
      if (v.itemId !== null) await this.requireActiveItem(c, v.itemId);
      await insertLine(c, id, projectId, v, user, at);
    });
    return this.one(this.pool, user, projectId, id);
  }

  /** Item, one-off kind, description, quantity, unit, period, needed-by and notes; no reason needed (spec 3.2). */
  async edit(user: AuthUser, projectId: string, lineId: string, body: unknown): Promise<LineView> {
    const b = obj(body);
    const at = this.now();
    await this.tx(async (c) => {
      await this.access.authorize(user, 'resource.edit', projectId, c, true);
      const { status, ...previous } = await this.lockLine(c, projectId, lineId);
      if (status === 'cancelled') throw new ConflictException(CANCELLED);
      refuseSecretsIn([b.description, b.notes]);
      const next = mergeLineValues(previous, b);
      const changed = FIELDS.filter((f) => next[f] !== previous[f]);
      if (changed.length === 0) return;
      if (changed.includes('itemId') && next.itemId !== null) await this.requireActiveItem(c, next.itemId);
      await c.query(
        `UPDATE resource_lines SET item_id = $2, one_off_kind = $3, description = $4, quantity = $5, unit = $6, starts_on = $7, ends_on = $8,
                needed_by = $9, notes = $10, updated_at = $11
          WHERE id = $1`,
        [lineId, next.itemId, next.oneOffKind, next.description, next.quantity, next.unit, next.startsOn, next.endsOn, next.neededBy, next.notes, at],
      );
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const f of changed) {
        before[f] = previous[f];
        after[f] = next[f];
      }
      await this.event(c, lineId, 'edited', user, at, null, { previous: before, next: after });
    });
    return this.one(this.pool, user, projectId, lineId);
  }

  /** Moves freely among Needed, Arranged, In use and Finished; Cancelled only through `cancel`. */
  async setStatus(user: AuthUser, projectId: string, lineId: string, statusInput: unknown): Promise<LineView> {
    const at = this.now();
    await this.tx(async (c) => {
      await this.access.authorize(user, 'resource.edit', projectId, c, true);
      const line = await this.lockLine(c, projectId, lineId);
      if (line.status === 'cancelled') throw new ConflictException(CANCELLED);
      if (statusInput === 'cancelled') throw new BadRequestException(USE_CANCEL);
      if (typeof statusInput !== 'string' || !Object.prototype.hasOwnProperty.call(LINE_STATUSES, statusInput)) throw new BadRequestException(STATUS);
      if (statusInput === line.status) return;
      await c.query(`UPDATE resource_lines SET status = $2, updated_at = $3 WHERE id = $1`, [lineId, statusInput, at]);
      await this.event(c, lineId, 'status_changed', user, at, null, { previous: { status: line.status }, next: { status: statusInput } });
    });
    return this.one(this.pool, user, projectId, lineId);
  }

  /** Final, with a reason; renewed need is a new line (spec 3.2). */
  async cancel(user: AuthUser, projectId: string, lineId: string, reasonInput: unknown): Promise<LineView> {
    const at = this.now();
    await this.tx(async (c) => {
      await this.access.authorize(user, 'resource.edit', projectId, c, true);
      const line = await this.lockLine(c, projectId, lineId);
      if (line.status === 'cancelled') throw new ConflictException(CANCELLED);
      const reason = readReason(reasonInput, 'a reason', { refusal: CANCEL_REASON });
      await c.query(`UPDATE resource_lines SET status = 'cancelled', updated_at = $2 WHERE id = $1`, [lineId, at]);
      await this.event(c, lineId, 'cancelled', user, at, reason, { previous: { status: line.status }, next: { status: 'cancelled' } });
    });
    return this.one(this.pool, user, projectId, lineId);
  }
}
