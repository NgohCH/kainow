import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import type { Prices } from './cost';
import { formatMicro, parseMicro } from './money';

export type DailyRule = { mode: 'not_applied' } | { mode: 'limit'; limitMicroMyr: bigint | null };

/** The approved settings. A null limit is a blank: zero allowance, the same as an explicit 0. */
export interface SpendSettingsInput {
  modelId: string;
  prices: Prices;
  monthlyLimitMicroMyr: bigint | null;
  daily: DailyRule;
}

export interface SpendSettings extends SpendSettingsInput {
  updatedAt: Date;
}

const COLUMNS = `model_id, input_usd_per_million_micro::text AS p_in, cached_input_usd_per_million_micro::text AS p_cached,
  output_usd_per_million_micro::text AS p_out, myr_per_usd_micro::text AS fx,
  monthly_limit_micro_myr::text AS monthly, daily_mode, daily_limit_micro_myr::text AS daily_limit, updated_at`;

interface SettingsRow {
  model_id: string;
  p_in: string;
  p_cached: string;
  p_out: string;
  fx: string;
  monthly: string | null;
  daily_mode: 'limit' | 'not_applied';
  daily_limit: string | null;
  updated_at: Date;
}

/** Returns the saved settings, or null if an administrator has not approved any yet. */
export async function readSettings(db: Pool | PoolClient): Promise<SpendSettings | null> {
  const { rows } = await db.query<SettingsRow>(`SELECT ${COLUMNS} FROM ai_spend_settings WHERE id = 1`);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    modelId: row.model_id,
    prices: {
      inputMicroUsdPerMillion: BigInt(row.p_in),
      cachedInputMicroUsdPerMillion: BigInt(row.p_cached),
      outputMicroUsdPerMillion: BigInt(row.p_out),
      myrPerUsdMicro: BigInt(row.fx),
    },
    monthlyLimitMicroMyr: row.monthly === null ? null : BigInt(row.monthly),
    daily:
      row.daily_mode === 'not_applied'
        ? { mode: 'not_applied' }
        : { mode: 'limit', limitMicroMyr: row.daily_limit === null ? null : BigInt(row.daily_limit) },
    updatedAt: row.updated_at,
  };
}

/** Settings as plain text for the API and the audit trail. */
export function describeSettings(s: SpendSettingsInput) {
  return {
    modelId: s.modelId,
    inputUsdPerMillion: formatMicro(s.prices.inputMicroUsdPerMillion),
    cachedInputUsdPerMillion: formatMicro(s.prices.cachedInputMicroUsdPerMillion),
    outputUsdPerMillion: formatMicro(s.prices.outputMicroUsdPerMillion),
    myrPerUsd: formatMicro(s.prices.myrPerUsdMicro),
    monthlyLimitMyr: s.monthlyLimitMicroMyr === null ? null : formatMicro(s.monthlyLimitMicroMyr),
    daily:
      s.daily.mode === 'not_applied'
        ? { mode: 'not_applied' as const }
        : { mode: 'limit' as const, limitMyr: s.daily.limitMicroMyr === null ? null : formatMicro(s.daily.limitMicroMyr) },
  };
}

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/** A limit field must be present. null means blank, which is zero allowance. */
function parseLimit(value: unknown, field: string): bigint | null {
  return value === null ? null : parseMicro(value, field);
}

/** Checks and converts an API request body. Nothing is defaulted: an omitted field is an error. */
export function parseSettingsBody(body: unknown): SpendSettingsInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('A settings object is required');
  }
  const b = body as Record<string, unknown>;
  const modelId = typeof b.modelId === 'string' ? b.modelId.trim() : '';
  if (modelId.length < 1 || modelId.length > 200) {
    throw new BadRequestException('modelId is required');
  }
  const myrPerUsdMicro = parseMicro(b.myrPerUsd, 'myrPerUsd');
  if (myrPerUsdMicro === 0n) {
    throw new BadRequestException('myrPerUsd must be more than 0');
  }
  if (!has(b, 'monthlyLimitMyr')) {
    throw new BadRequestException('monthlyLimitMyr is required (send null for no allowance)');
  }
  const daily = b.daily;
  if (!daily || typeof daily !== 'object' || Array.isArray(daily)) {
    throw new BadRequestException('daily is required: { "mode": "not_applied" } or { "mode": "limit", "limitMyr": ... }');
  }
  const d = daily as Record<string, unknown>;
  let dailyRule: DailyRule;
  if (d.mode === 'not_applied') {
    if (has(d, 'limitMyr')) {
      throw new BadRequestException('daily.limitMyr must not be given when daily.mode is not_applied');
    }
    dailyRule = { mode: 'not_applied' };
  } else if (d.mode === 'limit') {
    if (!has(d, 'limitMyr')) {
      throw new BadRequestException('daily.limitMyr is required when daily.mode is limit (send null for no allowance)');
    }
    dailyRule = { mode: 'limit', limitMicroMyr: parseLimit(d.limitMyr, 'daily.limitMyr') };
  } else {
    throw new BadRequestException('daily.mode must be "limit" or "not_applied"');
  }
  return {
    modelId,
    prices: {
      inputMicroUsdPerMillion: parseMicro(b.inputUsdPerMillion, 'inputUsdPerMillion'),
      cachedInputMicroUsdPerMillion: parseMicro(b.cachedInputUsdPerMillion, 'cachedInputUsdPerMillion'),
      outputMicroUsdPerMillion: parseMicro(b.outputUsdPerMillion, 'outputUsdPerMillion'),
      myrPerUsdMicro,
    },
    monthlyLimitMicroMyr: parseLimit(b.monthlyLimitMyr, 'monthlyLimitMyr'),
    daily: dailyRule,
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
   * Saves the approved settings and records the change with the new values.
   * Requests already reserved keep the prices they were reserved at.
   */
  async apply(input: SpendSettingsInput, actorUserId: string | null): Promise<void> {
    const now = this.clock();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ai_spend_settings
           (id, model_id, input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro,
            myr_per_usd_micro, monthly_limit_micro_myr, daily_mode, daily_limit_micro_myr, updated_at, updated_by)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           model_id = EXCLUDED.model_id,
           input_usd_per_million_micro = EXCLUDED.input_usd_per_million_micro,
           cached_input_usd_per_million_micro = EXCLUDED.cached_input_usd_per_million_micro,
           output_usd_per_million_micro = EXCLUDED.output_usd_per_million_micro,
           myr_per_usd_micro = EXCLUDED.myr_per_usd_micro,
           monthly_limit_micro_myr = EXCLUDED.monthly_limit_micro_myr,
           daily_mode = EXCLUDED.daily_mode,
           daily_limit_micro_myr = EXCLUDED.daily_limit_micro_myr,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by`,
        [
          input.modelId,
          input.prices.inputMicroUsdPerMillion.toString(),
          input.prices.cachedInputMicroUsdPerMillion.toString(),
          input.prices.outputMicroUsdPerMillion.toString(),
          input.prices.myrPerUsdMicro.toString(),
          input.monthlyLimitMicroMyr === null ? null : input.monthlyLimitMicroMyr.toString(),
          input.daily.mode,
          input.daily.mode === 'limit' && input.daily.limitMicroMyr !== null ? input.daily.limitMicroMyr.toString() : null,
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
        detail: { settings: describeSettings(input) },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
