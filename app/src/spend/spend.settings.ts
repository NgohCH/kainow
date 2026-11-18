import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { formatMicro, parseMicro } from './money';

export type DailyRule = { mode: 'not_applied' } | { mode: 'limit'; limitMicroMyr: bigint | null };

/** The optional per-person monthly limit. 'not_applied' is a deliberate choice; with 'limit', null means no allowance. */
export type UserRule = DailyRule;

/** The Administrator's ceiling on a project's monthly AI limit. 'not_applied' is a deliberate choice, not a blank. */
export type ProjectCeiling = { mode: 'not_applied' } | { mode: 'limit'; limitMicroMyr: bigint };

/** Bounds on the policy numbers (D87). A project value may only be lower than or equal to the organisation value. */
export const POLICY_BOUNDS = { maxAttempts: [1, 5], timeoutSeconds: [30, 300], concurrency: [1, 10] } as const;

/** The approved settings. A null limit is a blank: zero allowance, the same as an explicit 0. The model and its prices live in the catalogue. */
export interface SpendSettingsInput {
  prices: { myrPerUsdMicro: bigint };
  monthlyLimitMicroMyr: bigint | null;
  daily: DailyRule;
  /** Left out means no per-person limit. */
  userMonthly?: UserRule;
  projectsMaySetLimits: boolean;
  projectsMayManageConnections: boolean;
  projectCeiling: ProjectCeiling;
  maxAttempts: number;
  timeoutSeconds: number;
  concurrency: number;
}

export interface SpendSettings extends SpendSettingsInput {
  userMonthly: UserRule;
  updatedAt: Date;
}

const COLUMNS = `myr_per_usd_micro::text AS fx,
  monthly_limit_micro_myr::text AS monthly, daily_mode, daily_limit_micro_myr::text AS daily_limit,
  user_monthly_mode, user_monthly_limit_micro_myr::text AS user_limit,
  projects_may_set_limits, projects_may_manage_connections, project_ceiling_mode, project_ceiling_micro_myr::text AS ceiling,
  max_attempts, timeout_seconds, concurrency, updated_at`;

interface SettingsRow {
  fx: string;
  monthly: string | null;
  daily_mode: 'limit' | 'not_applied';
  daily_limit: string | null;
  user_monthly_mode: 'limit' | 'not_applied';
  user_limit: string | null;
  projects_may_set_limits: boolean;
  projects_may_manage_connections: boolean;
  project_ceiling_mode: 'limit' | 'not_applied';
  ceiling: string | null;
  max_attempts: number;
  timeout_seconds: number;
  concurrency: number;
  updated_at: Date;
}

/** Returns the saved settings, or null if an administrator has not approved any yet (all AI is blocked: not_configured). */
export async function readSettings(db: Pool | PoolClient): Promise<SpendSettings | null> {
  const { rows } = await db.query<SettingsRow>(`SELECT ${COLUMNS} FROM ai_spend_settings WHERE id = 1`);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    prices: { myrPerUsdMicro: BigInt(row.fx) },
    monthlyLimitMicroMyr: row.monthly === null ? null : BigInt(row.monthly),
    daily:
      row.daily_mode === 'not_applied'
        ? { mode: 'not_applied' }
        : { mode: 'limit', limitMicroMyr: row.daily_limit === null ? null : BigInt(row.daily_limit) },
    userMonthly:
      row.user_monthly_mode === 'not_applied'
        ? { mode: 'not_applied' }
        : { mode: 'limit', limitMicroMyr: row.user_limit === null ? null : BigInt(row.user_limit) },
    projectsMaySetLimits: row.projects_may_set_limits,
    projectsMayManageConnections: row.projects_may_manage_connections,
    projectCeiling:
      row.project_ceiling_mode === 'not_applied' ? { mode: 'not_applied' } : { mode: 'limit', limitMicroMyr: BigInt(row.ceiling ?? '0') },
    maxAttempts: row.max_attempts,
    timeoutSeconds: row.timeout_seconds,
    concurrency: row.concurrency,
    updatedAt: row.updated_at,
  };
}

/** Settings as plain text for the API and the audit trail. */
export function describeSettings(s: SpendSettingsInput) {
  return {
    myrPerUsd: formatMicro(s.prices.myrPerUsdMicro),
    monthlyLimitMyr: s.monthlyLimitMicroMyr === null ? null : formatMicro(s.monthlyLimitMicroMyr),
    daily:
      s.daily.mode === 'not_applied'
        ? { mode: 'not_applied' as const }
        : { mode: 'limit' as const, limitMyr: s.daily.limitMicroMyr === null ? null : formatMicro(s.daily.limitMicroMyr) },
    userMonthly:
      !s.userMonthly || s.userMonthly.mode === 'not_applied'
        ? { mode: 'not_applied' as const }
        : { mode: 'limit' as const, limitMyr: s.userMonthly.limitMicroMyr === null ? null : formatMicro(s.userMonthly.limitMicroMyr) },
    projectsMaySetLimits: s.projectsMaySetLimits,
    projectsMayManageConnections: s.projectsMayManageConnections,
    projectCeiling:
      s.projectCeiling.mode === 'not_applied'
        ? { mode: 'not_applied' as const }
        : { mode: 'limit' as const, limitMyr: formatMicro(s.projectCeiling.limitMicroMyr) },
    maxAttempts: s.maxAttempts,
    timeoutSeconds: s.timeoutSeconds,
    concurrency: s.concurrency,
  };
}

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/** A whole number within the bounds; a missing field is an error. */
export function boundedInt(v: unknown, field: string, [min, max]: readonly [number, number]): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new BadRequestException(`${field} is required and must be a whole number from ${min} to ${max}`);
  }
  return v;
}

/** A limit field must be present. null means blank, which is zero allowance. */
export function parseLimit(value: unknown, field: string): bigint | null {
  return value === null ? null : parseMicro(value, field);
}

/** A daily or per-person rule: { mode: 'not_applied' } or { mode: 'limit', limitMyr } (null = no allowance). */
export function parseRule(value: unknown, field: string): DailyRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be { "mode": "not_applied" } or { "mode": "limit", "limitMyr": ... }`);
  }
  const r = value as Record<string, unknown>;
  if (r.mode === 'not_applied') {
    if (has(r, 'limitMyr')) throw new BadRequestException(`${field}.limitMyr must not be given when ${field}.mode is not_applied`);
    return { mode: 'not_applied' };
  }
  if (r.mode === 'limit') {
    if (!has(r, 'limitMyr')) {
      throw new BadRequestException(`${field}.limitMyr is required when ${field}.mode is limit (send null for no allowance)`);
    }
    return { mode: 'limit', limitMicroMyr: parseLimit(r.limitMyr, `${field}.limitMyr`) };
  }
  throw new BadRequestException(`${field}.mode must be "limit" or "not_applied"`);
}

/** Checks and converts an API request body. Nothing is defaulted: an omitted field is an error. */
export function parseSettingsBody(body: unknown): SpendSettingsInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('A settings object is required');
  }
  const b = body as Record<string, unknown>;
  const myrPerUsdMicro = parseMicro(b.myrPerUsd, 'myrPerUsd');
  if (myrPerUsdMicro === 0n) {
    throw new BadRequestException('myrPerUsd must be more than 0');
  }
  if (!has(b, 'monthlyLimitMyr')) {
    throw new BadRequestException('monthlyLimitMyr is required (send null for no allowance)');
  }
  if (!b.daily) {
    throw new BadRequestException('daily is required: { "mode": "not_applied" } or { "mode": "limit", "limitMyr": ... }');
  }
  const dailyRule = parseRule(b.daily, 'daily');
  // Optional: leaving it out means no per-person limit (it is not a blank required limit).
  const userRule: UserRule = has(b, 'userMonthly') ? parseRule(b.userMonthly, 'userMonthly') : { mode: 'not_applied' };
  const flag = (field: 'projectsMaySetLimits' | 'projectsMayManageConnections'): boolean => {
    if (typeof b[field] !== 'boolean') throw new BadRequestException(`${field} is required (true or false)`);
    return b[field] as boolean;
  };
  const projectsMaySetLimits = flag('projectsMaySetLimits');
  const projectsMayManageConnections = flag('projectsMayManageConnections');
  const ceiling = b.projectCeiling;
  if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling)) {
    throw new BadRequestException('projectCeiling is required: { "mode": "not_applied" } or { "mode": "limit", "limitMyr": ... }');
  }
  const c = ceiling as Record<string, unknown>;
  let projectCeiling: ProjectCeiling;
  if (c.mode === 'not_applied') {
    if (has(c, 'limitMyr')) throw new BadRequestException('projectCeiling.limitMyr must not be given when projectCeiling.mode is not_applied');
    projectCeiling = { mode: 'not_applied' };
  } else if (c.mode === 'limit') {
    if (!has(c, 'limitMyr') || c.limitMyr === null) throw new BadRequestException('projectCeiling.limitMyr is required when projectCeiling.mode is limit');
    projectCeiling = { mode: 'limit', limitMicroMyr: parseMicro(c.limitMyr, 'projectCeiling.limitMyr') };
  } else {
    throw new BadRequestException('projectCeiling.mode must be "limit" or "not_applied"');
  }
  return {
    prices: { myrPerUsdMicro },
    monthlyLimitMicroMyr: parseLimit(b.monthlyLimitMyr, 'monthlyLimitMyr'),
    daily: dailyRule,
    userMonthly: userRule,
    projectsMaySetLimits,
    projectsMayManageConnections,
    projectCeiling,
    maxAttempts: boundedInt(b.maxAttempts, 'maxAttempts', POLICY_BOUNDS.maxAttempts),
    timeoutSeconds: boundedInt(b.timeoutSeconds, 'timeoutSeconds', POLICY_BOUNDS.timeoutSeconds),
    concurrency: boundedInt(b.concurrency, 'concurrency', POLICY_BOUNDS.concurrency),
  };
}

@Injectable()
export class SpendSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  get(): Promise<SpendSettings | null> {
    return readSettings(this.pool);
  }

  /**
   * Saves the approved settings and records the change with the previous and new values and the reason (spec 7.1, Q01).
   * The HTTP route requires the reason; internal callers that seed settings may leave it null.
   * Requests already reserved keep the prices they were reserved at.
   */
  async apply(input: SpendSettingsInput, actorUserId: string | null, reason: string | null = null): Promise<void> {
    await this.write(input, actorUserId, reason, 'replace');
  }

  /**
   * Saves the settings only when none are saved yet; otherwise changes nothing and returns false. For the install command,
   * so running it again never resets what an Administrator has since changed (delegation, ceiling, policy).
   */
  insertIfAbsent(input: SpendSettingsInput, actorUserId: string | null, reason: string): Promise<boolean> {
    return this.write(input, actorUserId, reason, 'insert_only');
  }

  private async write(input: SpendSettingsInput, actorUserId: string | null, reason: string | null, how: 'replace' | 'insert_only'): Promise<boolean> {
    const now = this.clock();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The row is locked (when it exists) so the previous values recorded are the ones this change replaces.
      await client.query(`SELECT 1 FROM ai_spend_settings WHERE id = 1 FOR UPDATE`);
      const previous = await readSettings(client);
      if (previous && how === 'insert_only') {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO ai_spend_settings
           (id, myr_per_usd_micro, monthly_limit_micro_myr, daily_mode, daily_limit_micro_myr,
            user_monthly_mode, user_monthly_limit_micro_myr,
            projects_may_set_limits, projects_may_manage_connections, project_ceiling_mode, project_ceiling_micro_myr,
            max_attempts, timeout_seconds, concurrency, updated_at, updated_by)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           myr_per_usd_micro = EXCLUDED.myr_per_usd_micro,
           monthly_limit_micro_myr = EXCLUDED.monthly_limit_micro_myr,
           daily_mode = EXCLUDED.daily_mode,
           daily_limit_micro_myr = EXCLUDED.daily_limit_micro_myr,
           user_monthly_mode = EXCLUDED.user_monthly_mode,
           user_monthly_limit_micro_myr = EXCLUDED.user_monthly_limit_micro_myr,
           projects_may_set_limits = EXCLUDED.projects_may_set_limits,
           projects_may_manage_connections = EXCLUDED.projects_may_manage_connections,
           project_ceiling_mode = EXCLUDED.project_ceiling_mode,
           project_ceiling_micro_myr = EXCLUDED.project_ceiling_micro_myr,
           max_attempts = EXCLUDED.max_attempts,
           timeout_seconds = EXCLUDED.timeout_seconds,
           concurrency = EXCLUDED.concurrency,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by`,
        [
          input.prices.myrPerUsdMicro.toString(),
          input.monthlyLimitMicroMyr === null ? null : input.monthlyLimitMicroMyr.toString(),
          input.daily.mode,
          input.daily.mode === 'limit' && input.daily.limitMicroMyr !== null ? input.daily.limitMicroMyr.toString() : null,
          input.userMonthly?.mode ?? 'not_applied',
          input.userMonthly?.mode === 'limit' && input.userMonthly.limitMicroMyr !== null ? input.userMonthly.limitMicroMyr.toString() : null,
          input.projectsMaySetLimits,
          input.projectsMayManageConnections,
          input.projectCeiling.mode,
          input.projectCeiling.mode === 'limit' ? input.projectCeiling.limitMicroMyr.toString() : null,
          input.maxAttempts,
          input.timeoutSeconds,
          input.concurrency,
          now,
          actorUserId,
        ],
      );
      await writeAudit(client, {
        at: now,
        action: 'ai.spend_settings_changed',
        actorUserId,
        subjectType: 'ai_spend_settings',
        subjectId: '1',
        detail: { previous: previous ? describeSettings(previous) : null, new: describeSettings(input), reason },
      });
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
