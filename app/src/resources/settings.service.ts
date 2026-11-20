import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason, refuseSecretsIn } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { CURRENCIES, type Currency } from '../finance/money';

export type ResourceSettings = {
  projectsMayManageFinance: boolean;
  defaultCurrency: Currency;
  enabledCurrencies: Currency[];
  warnFirstPct: number;
  warnSecondPct: number;
};

const KEYS = ['projectsMayManageFinance', 'defaultCurrency', 'enabledCurrencies', 'warnFirstPct', 'warnSecondPct'] as const;
const REASON = 'Give a reason for the change (up to 1,000 characters).';
const CURRENCY_ORDER = Object.keys(CURRENCIES) as Currency[];
const isCurrency = (v: unknown): v is Currency => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, v);

export async function loadResourceSettings(db: Pool | PoolClient, lock = false): Promise<ResourceSettings> {
  const { rows } = await db.query(
    `SELECT projects_may_manage_finance AS "projectsMayManageFinance", default_currency AS "defaultCurrency",
            enabled_currencies AS "enabledCurrencies", warn_first_pct AS "warnFirstPct", warn_second_pct AS "warnSecondPct"
       FROM resource_settings WHERE id${lock ? ' FOR UPDATE' : ''}`,
  );
  return rows[0] as ResourceSettings;
}

/** Checks the merged values (D93, D94) and returns them with the currencies in their fixed order. */
export function validateResourceSettings(v: Record<string, unknown>): { ok: true; value: ResourceSettings } | { ok: false; message: string } {
  if (typeof v.projectsMayManageFinance !== 'boolean') return { ok: false, message: 'Projects may manage finance must be yes or no.' };
  if (!Array.isArray(v.enabledCurrencies) || !v.enabledCurrencies.every(isCurrency)) {
    return { ok: false, message: `Enabled currencies must be from ${CURRENCY_ORDER.join(', ')}.` };
  }
  const listed = v.enabledCurrencies as Currency[];
  const enabled = CURRENCY_ORDER.filter((c) => listed.includes(c));
  if (enabled.length === 0) return { ok: false, message: 'Enable at least one currency.' };
  if (!isCurrency(v.defaultCurrency)) return { ok: false, message: `The default currency must be one of ${CURRENCY_ORDER.join(', ')}.` };
  if (!enabled.includes(v.defaultCurrency)) return { ok: false, message: 'The default currency must be enabled.' };
  const { warnFirstPct: a, warnSecondPct: b } = v;
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 200;
  if (!whole(a) || !whole(b) || a >= b) return { ok: false, message: 'Warning thresholds must be whole percentages from 1 to 200, the first below the second.' };
  return { ok: true, value: { projectsMayManageFinance: v.projectsMayManageFinance, defaultCurrency: v.defaultCurrency, enabledCurrencies: enabled, warnFirstPct: a, warnSecondPct: b } };
}

/** Keeps only the known keys of a request body. */
function pick(next: unknown): Record<string, unknown> {
  const src = next && typeof next === 'object' ? (next as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of KEYS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

@Injectable()
export class ResourceSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async get() {
    const { rows } = await this.pool.query(
      `SELECT h.id, h.at, h.reason, h.actor_id AS "actorId", u.display_name AS actor, h.previous, h.next
         FROM resource_settings_changes h JOIN users u ON u.id = h.actor_id
        ORDER BY h.at DESC, h.id DESC`,
    );
    return { settings: await loadResourceSettings(this.pool), changes: rows };
  }

  /** Writes the row, one history row and the audit event together. */
  async update(user: AuthUser, next: unknown, reasonInput: unknown): Promise<ResourceSettings> {
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    refuseSecretsIn(next);
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await loadResourceSettings(client, true);
      const check = validateResourceSettings({ ...previous, ...pick(next) });
      if (!check.ok) throw new BadRequestException(check.message);
      const value = check.value;
      const fields = KEYS.filter((k) => JSON.stringify(previous[k]) !== JSON.stringify(value[k]));
      if (fields.length === 0) throw new BadRequestException('Nothing to change.');
      await client.query(
        `UPDATE resource_settings SET projects_may_manage_finance = $1, default_currency = $2, enabled_currencies = $3, warn_first_pct = $4, warn_second_pct = $5 WHERE id`,
        [value.projectsMayManageFinance, value.defaultCurrency, value.enabledCurrencies, value.warnFirstPct, value.warnSecondPct],
      );
      await client.query(`INSERT INTO resource_settings_changes (id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, $4, $5, $6)`, [
        uuidv7(at.getTime()), user.id, at, reason, JSON.stringify(previous), JSON.stringify(value),
      ]);
      await writeAudit(client, { at, action: 'resources.settings_changed', actorUserId: user.id, subjectType: 'organisation', detail: { fields } });
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/** True for an active Administrator or an active listed maintainer. */
export async function isCatalogueMaintainer(db: Pool | PoolClient, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM users u WHERE u.id = $1 AND u.status = 'active'
        AND (u.role = 'enterprise_administrator' OR EXISTS (SELECT 1 FROM resource_catalogue_maintainers m WHERE m.user_id = u.id))`,
    [userId],
  );
  return rows.length > 0;
}

@Injectable()
export class MaintainersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async list() {
    const { rows } = await this.pool.query(
      `SELECT m.user_id AS "userId", u.display_name AS name, u.email, m.added_at AS "addedAt", m.reason, a.display_name AS "addedBy"
         FROM resource_catalogue_maintainers m JOIN users u ON u.id = m.user_id JOIN users a ON a.id = m.added_by
        ORDER BY m.added_at, u.email, m.user_id`,
    );
    return rows;
  }

  private target(userId: unknown): string {
    if (typeof userId !== 'string' || !UUID.test(userId)) throw new BadRequestException('Choose the person.');
    return userId;
  }

  async add(user: AuthUser, userIdInput: unknown, reasonInput: unknown): Promise<void> {
    const userId = this.target(userIdInput);
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT role, status FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      if (!rows[0]) throw new NotFoundException('That person was not found.');
      if (rows[0].role === 'enterprise_administrator') throw new BadRequestException('Administrators can already maintain the catalogue.');
      if (rows[0].status !== 'active') throw new BadRequestException('Only an active user can maintain the catalogue.');
      const inserted = await client.query(
        `INSERT INTO resource_catalogue_maintainers (user_id, added_by, added_at, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [userId, user.id, at, reason],
      );
      if (inserted.rowCount === 0) throw new ConflictException('That person is already a catalogue maintainer.');
      await client.query(
        `INSERT INTO resource_catalogue_events (id, subject_kind, subject_id, kind, actor_id, at, reason, detail) VALUES ($1, 'maintainer', $2, 'maintainer_added', $3, $4, $5, '{}')`,
        [uuidv7(at.getTime()), userId, user.id, at, reason],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async remove(user: AuthUser, userIdInput: unknown, reasonInput: unknown): Promise<void> {
    const userId = this.target(userIdInput);
    const reason = readReason(reasonInput, 'a reason', { refusal: REASON });
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query(`DELETE FROM resource_catalogue_maintainers WHERE user_id = $1`, [userId]);
      if (deleted.rowCount === 0) throw new NotFoundException('That person is not a catalogue maintainer.');
      await client.query(
        `INSERT INTO resource_catalogue_events (id, subject_kind, subject_id, kind, actor_id, at, reason, detail) VALUES ($1, 'maintainer', $2, 'maintainer_removed', $3, $4, $5, '{}')`,
        [uuidv7(at.getTime()), userId, user.id, at, reason],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
