import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason, refuseSecretsIn } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { todayUtc8 } from '../projects/membership';
import { isCatalogueMaintainer } from './settings.service';
import { ITEM_KINDS } from './vocabulary';

const REASON = 'Give a reason for retiring (up to 1,000 characters).';
const DUPLICATE_REFERENCE = 'A current item already uses this reference.';
const DUPLICATE_CATEGORY = 'A current category already uses this name.';
const ITEM_FIELDS = ['kind', 'reference', 'name', 'categoryId', 'description'] as const;
type ItemField = (typeof ITEM_FIELDS)[number];
type ItemValues = { kind: string; reference: string; name: string; categoryId: string; description: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function text(v: unknown, label: string, min: number, max: number): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) {
    throw new BadRequestException(min === 0 ? `${label} must be up to ${max.toLocaleString('en-US')} characters.` : `${label} must be ${min} to ${max.toLocaleString('en-US')} characters.`);
  }
  return s;
}

function readField(field: ItemField, v: unknown): string {
  switch (field) {
    case 'kind':
      if (typeof v !== 'string' || !(ITEM_KINDS as readonly string[]).includes(v)) throw new BadRequestException('Choose Equipment or Facility.');
      return v;
    case 'reference':
      return text(v, 'The reference', 1, 30);
    case 'name':
      return text(v, 'The name', 1, 120);
    case 'description':
      return v === undefined || v === null ? '' : text(v, 'The description', 0, 1000);
    case 'categoryId':
      if (typeof v !== 'string' || !UUID.test(v)) throw new BadRequestException('Choose an active category.');
      return v;
  }
}

const isUnique = (err: unknown, constraint: string) =>
  !!err && typeof err === 'object' && (err as { code?: string }).code === '23505' && (err as { constraint?: string }).constraint === constraint;

@Injectable()
export class CatalogueService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  private async requireMaintainer(user: AuthUser): Promise<void> {
    if (!(await isCatalogueMaintainer(this.pool, user.id))) throw new ForbiddenException('Only catalogue maintainers can change the catalogue.');
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

  private event(c: PoolClient, subjectKind: 'item' | 'category', subjectId: string, kind: string, user: AuthUser, at: Date, reason: string | null, detail: unknown) {
    return c.query(
      `INSERT INTO resource_catalogue_events (id, subject_kind, subject_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(at.getTime()), subjectKind, subjectId, kind, user.id, at, reason, JSON.stringify(detail)],
    );
  }

  /** Active entries for anyone signed in; retired ones and the per-item project count only for maintainers. */
  async list(user: AuthUser, opts: { all: boolean }) {
    const maintainer = await isCatalogueMaintainer(this.pool, user.id);
    if (opts.all && !maintainer) throw new ForbiddenException('Only catalogue maintainers can see retired entries.');
    const today = todayUtc8(this.now());
    const count = maintainer
      ? `, (SELECT count(DISTINCT l.project_id)::int FROM resource_lines l
              WHERE l.item_id = i.id AND l.status <> 'cancelled'
                AND ((l.starts_on IS NULL AND l.status <> 'finished') OR (l.starts_on IS NOT NULL AND (l.ends_on IS NULL OR l.ends_on >= $1::date)))) AS "projectsWithLines"`
      : '';
    const items = await this.pool.query(
      `SELECT i.id, i.kind, i.reference, i.name, i.category_id AS "categoryId", c.name AS "categoryName", i.description, i.status${count}
         FROM resource_items i LEFT JOIN resource_categories c ON c.id = i.category_id
        ${opts.all ? '' : `WHERE i.status = 'active'`}
        ORDER BY i.kind, lower(i.reference), i.created_at, i.id`,
      maintainer ? [today] : [],
    );
    const categories = await this.pool.query(
      `SELECT id, name, status FROM resource_categories ${opts.all ? '' : `WHERE status = 'active'`} ORDER BY lower(name), created_at, id`,
    );
    return { items: items.rows, categories: categories.rows };
  }

  private async loadItem(c: PoolClient, id: string) {
    const { rows } = await c.query(
      `SELECT id, kind, reference, name, category_id AS "categoryId", description, status FROM resource_items WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] as (ItemValues & { id: string; status: string }) | undefined;
  }

  private async requireActiveCategory(c: PoolClient, id: string) {
    const { rows } = await c.query(`SELECT 1 FROM resource_categories WHERE id = $1 AND status = 'active'`, [id]);
    if (rows.length === 0) throw new BadRequestException('Choose an active category.');
  }

  async addItem(user: AuthUser, input: unknown) {
    await this.requireMaintainer(user);
    const b = obj(input);
    refuseSecretsIn([b.reference, b.name, b.description]);
    const v = {} as ItemValues;
    for (const f of ITEM_FIELDS) v[f] = readField(f, b[f]);
    const at = this.now();
    const id = uuidv7(at.getTime());
    try {
      await this.tx(async (c) => {
        await this.requireActiveCategory(c, v.categoryId);
        await c.query(
          `INSERT INTO resource_items (id, kind, reference, name, category_id, description, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, v.kind, v.reference, v.name, v.categoryId, v.description, user.id, at],
        );
        await this.event(c, 'item', id, 'added', user, at, null, { previous: null, next: v });
      });
    } catch (err) {
      if (isUnique(err, 'resource_items_active_reference_key')) throw new ConflictException(DUPLICATE_REFERENCE);
      throw err;
    }
    return { id, ...v, status: 'active' };
  }

  async editItem(user: AuthUser, id: string, input: unknown) {
    await this.requireMaintainer(user);
    const b = obj(input);
    refuseSecretsIn([b.reference, b.name, b.description]);
    const given = ITEM_FIELDS.filter((f) => b[f] !== undefined);
    const at = this.now();
    try {
      return await this.tx(async (c) => {
        const item = await this.loadItem(c, id);
        if (!item) throw new NotFoundException('That item was not found.');
        if (item.status === 'retired') throw new ConflictException('This item is retired.');
        const next: ItemValues = { kind: item.kind, reference: item.reference, name: item.name, categoryId: item.categoryId, description: item.description };
        for (const f of given) next[f] = readField(f, b[f]);
        const changed = ITEM_FIELDS.filter((f) => next[f] !== item[f]);
        if (changed.length === 0) return { id, ...next, status: 'active' };
        if (changed.includes('categoryId')) await this.requireActiveCategory(c, next.categoryId);
        await c.query(
          `UPDATE resource_items SET kind = $2, reference = $3, name = $4, category_id = $5, description = $6, updated_by = $7, updated_at = $8 WHERE id = $1`,
          [id, next.kind, next.reference, next.name, next.categoryId, next.description, user.id, at],
        );
        const previous: Record<string, string> = {};
        const after: Record<string, string> = {};
        for (const f of changed) {
          previous[f] = item[f];
          after[f] = next[f];
        }
        const kind = changed.includes('name') || changed.includes('reference') ? 'renamed' : 'edited';
        await this.event(c, 'item', id, kind, user, at, null, { previous, next: after });
        return { id, ...next, status: 'active' };
      });
    } catch (err) {
      if (isUnique(err, 'resource_items_active_reference_key')) throw new ConflictException(DUPLICATE_REFERENCE);
      throw err;
    }
  }

  async retireItem(user: AuthUser, id: string, reasonInput: unknown): Promise<void> {
    await this.requireMaintainer(user);
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    const at = this.now();
    await this.tx(async (c) => {
      const item = await this.loadItem(c, id);
      if (!item) throw new NotFoundException('That item was not found.');
      if (item.status === 'retired') throw new ConflictException('This item is retired.');
      await c.query(`UPDATE resource_items SET status = 'retired', updated_by = $2, updated_at = $3 WHERE id = $1`, [id, user.id, at]);
      await this.event(c, 'item', id, 'retired', user, at, reason, { previous: { status: 'active' }, next: { status: 'retired' } });
    });
  }

  async addCategory(user: AuthUser, input: unknown) {
    await this.requireMaintainer(user);
    const raw = obj(input).name;
    refuseSecretsIn(raw);
    const name = text(raw, 'The category name', 1, 80);
    const at = this.now();
    const id = uuidv7(at.getTime());
    try {
      await this.tx(async (c) => {
        await c.query(`INSERT INTO resource_categories (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)`, [id, name, user.id, at]);
        await this.event(c, 'category', id, 'added', user, at, null, { previous: null, next: { name } });
      });
    } catch (err) {
      if (isUnique(err, 'resource_categories_active_name_key')) throw new ConflictException(DUPLICATE_CATEGORY);
      throw err;
    }
    return { id, name, status: 'active' };
  }

  async renameCategory(user: AuthUser, id: string, input: unknown) {
    await this.requireMaintainer(user);
    const raw = obj(input).name;
    refuseSecretsIn(raw);
    const name = text(raw, 'The category name', 1, 80);
    const at = this.now();
    try {
      return await this.tx(async (c) => {
        const { rows } = await c.query(`SELECT name, status FROM resource_categories WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows[0]) throw new NotFoundException('That category was not found.');
        if (rows[0].status === 'retired') throw new ConflictException('This category is retired.');
        if (rows[0].name !== name) {
          await c.query(`UPDATE resource_categories SET name = $2, updated_by = $3, updated_at = $4 WHERE id = $1`, [id, name, user.id, at]);
          await this.event(c, 'category', id, 'renamed', user, at, null, { previous: { name: rows[0].name }, next: { name } });
        }
        return { id, name, status: 'active' };
      });
    } catch (err) {
      if (isUnique(err, 'resource_categories_active_name_key')) throw new ConflictException(DUPLICATE_CATEGORY);
      throw err;
    }
  }

  async retireCategory(user: AuthUser, id: string, reasonInput: unknown): Promise<void> {
    await this.requireMaintainer(user);
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    const at = this.now();
    await this.tx(async (c) => {
      const { rows } = await c.query(`SELECT status FROM resource_categories WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new NotFoundException('That category was not found.');
      if (rows[0].status === 'retired') throw new ConflictException('This category is retired.');
      await c.query(`UPDATE resource_categories SET status = 'retired', updated_by = $2, updated_at = $3 WHERE id = $1`, [id, user.id, at]);
      await this.event(c, 'category', id, 'retired', user, at, reason, { previous: { status: 'active' }, next: { status: 'retired' } });
    });
  }
}
