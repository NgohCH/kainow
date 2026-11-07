import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { costMicroMyr, type Prices, type Usage } from './cost';
import { dayPeriod, monthPeriod, type Period } from './periods';
import { readSettings } from './spend.settings';

/** Serialises reservations so parallel requests cannot each see the same headroom. */
const SPEND_LOCK_KEY = 7201108;

export type Scope = 'monthly' | 'daily';
export type BlockReason = 'not_configured' | 'no_allowance' | 'cap_would_be_exceeded';

export type ReserveResult =
  | { status: 'reserved'; entryId: string }
  | { status: 'blocked'; reason: BlockReason; scope?: Scope; remainingMicroMyr?: bigint };

export interface ReserveInput {
  /** One logical request. Each retry or fallback is a further attempt of the same request. */
  requestId: string;
  attemptNo: number;
  /** From estimateMaxCostMicroMyr. Must be positive: an unknown cost is never zero. */
  estimateMicroMyr: bigint;
  purpose: string;
  actorUserId?: string | null;
}

export type EntryStatus = 'reserved' | 'uncertain' | 'confirmed' | 'released';

export interface SpendEntry {
  id: string;
  status: EntryStatus;
  estimateMicroMyr: bigint;
  amountMicroMyr: bigint;
  exceededEstimate: boolean;
  modelId: string;
}

export interface PeriodSummary {
  period: Period;
  /** null is a blank limit: zero allowance. */
  limitMicroMyr: bigint | null;
  usedMicroMyr: bigint;
  /** Of the used amount: held for requests still running, and held because the real charge is unknown. */
  reservedMicroMyr: bigint;
  uncertainMicroMyr: bigint;
  remainingMicroMyr: bigint;
}

export interface SpendSummary {
  configured: boolean;
  monthly: PeriodSummary | null;
  /** null when no daily limit applies (mode not_applied) or nothing is configured. */
  daily: PeriodSummary | null;
}

export class SpendStateError extends Error {}

interface EntryRow {
  id: string;
  status: EntryStatus;
  estimate: string;
  amount: string;
  exceeded_estimate: boolean;
  model_id: string;
  p_in: string;
  p_cached: string;
  p_out: string;
  fx: string;
}

const ENTRY_COLUMNS = `id, status, estimate_micro_myr::text AS estimate, amount_micro_myr::text AS amount, exceeded_estimate, model_id,
  input_usd_per_million_micro::text AS p_in, cached_input_usd_per_million_micro::text AS p_cached,
  output_usd_per_million_micro::text AS p_out, myr_per_usd_micro::text AS fx`;

function snapshotPrices(row: EntryRow): Prices {
  return {
    inputMicroUsdPerMillion: BigInt(row.p_in),
    cachedInputMicroUsdPerMillion: BigInt(row.p_cached),
    outputMicroUsdPerMillion: BigInt(row.p_out),
    myrPerUsdMicro: BigInt(row.fx),
  };
}

@Injectable()
export class SpendService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Holds the estimated cost before a request is sent, or refuses. Allowed when the estimate fits
   * within what is left (an estimate equal to what is left is allowed). Every applicable limit must
   * allow it. A blank or zero limit allows nothing, and so does having no approved settings.
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    if (input.estimateMicroMyr <= 0n) {
      throw new RangeError('estimateMicroMyr must be positive');
    }
    if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1) {
      throw new RangeError('attemptNo must be a whole number of at least 1');
    }
    const now = this.clock();
    return this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [SPEND_LOCK_KEY]);
      const settings = await readSettings(c);
      if (!settings) {
        return this.block(c, now, input, 'not_configured');
      }

      const limits: { scope: Scope; limit: bigint | null; period: Period }[] = [
        { scope: 'monthly', limit: settings.monthlyLimitMicroMyr, period: monthPeriod(now) },
      ];
      if (settings.daily.mode === 'limit') {
        limits.push({ scope: 'daily', limit: settings.daily.limitMicroMyr, period: dayPeriod(now) });
      }
      for (const { scope, limit, period } of limits) {
        if (limit === null || limit === 0n) {
          return this.block(c, now, input, 'no_allowance', scope, 0n);
        }
        const { used } = await this.totals(c, period);
        const remaining = limit - used;
        if (input.estimateMicroMyr > remaining) {
          return this.block(c, now, input, 'cap_would_be_exceeded', scope, remaining > 0n ? remaining : 0n);
        }
      }

      const entryId = uuidv7(now.getTime());
      const p = settings.prices;
      await c.query(
        `INSERT INTO ai_spend_entries
           (id, request_id, attempt_no, created_at, updated_at, status, purpose, actor_user_id, model_id,
            input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro,
            myr_per_usd_micro, estimate_micro_myr, amount_micro_myr)
         VALUES ($1, $2, $3, $4, $4, 'reserved', $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
        [
          entryId,
          input.requestId,
          input.attemptNo,
          now,
          input.purpose,
          input.actorUserId ?? null,
          settings.modelId,
          p.inputMicroUsdPerMillion.toString(),
          p.cachedInputMicroUsdPerMillion.toString(),
          p.outputMicroUsdPerMillion.toString(),
          p.myrPerUsdMicro.toString(),
          input.estimateMicroMyr.toString(),
        ],
      );
      return { status: 'reserved', entryId };
    });
  }

  /**
   * Replaces the held estimate with the cost of the usage the provider reported, priced at the
   * rates in force when the request was reserved. Also settles an uncertain entry once the real
   * usage is known. Doing it again changes nothing, so a cost is never counted twice. If the
   * real cost is higher than the estimate, the real cost is recorded and the entry is flagged.
   */
  async settle(entryId: string, usage: Usage): Promise<void> {
    const now = this.clock();
    await this.withEntry(entryId, async (c, e) => {
      if (e.status === 'confirmed') return;
      if (e.status === 'released') throw new SpendStateError('A released entry cannot be settled');
      const amount = costMicroMyr(usage, snapshotPrices(e));
      await c.query(
        `UPDATE ai_spend_entries
            SET status = 'confirmed', amount_micro_myr = $2, input_tokens = $3, cached_input_tokens = $4,
                output_tokens = $5, exceeded_estimate = $6, updated_at = $7
          WHERE id = $1`,
        [entryId, amount.toString(), usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, amount > BigInt(e.estimate), now],
      );
    });
  }

  /**
   * The outcome is unknown (a timeout, a lost connection, a crash). The full estimate stays counted
   * until it is reconciled: a local timeout does not show the provider did not charge.
   */
  async markUncertain(entryId: string, note: string): Promise<void> {
    const now = this.clock();
    await this.withEntry(entryId, async (c, e) => {
      if (e.status === 'confirmed' || e.status === 'uncertain') return;
      if (e.status === 'released') throw new SpendStateError('A released entry cannot become uncertain');
      await c.query(`UPDATE ai_spend_entries SET status = 'uncertain', note = $2, updated_at = $3 WHERE id = $1`, [entryId, note, now]);
    });
  }

  /**
   * Gives the reservation back. Only for a request that was never sent. Once a request has gone to
   * the provider, use markUncertain or settle instead.
   */
  async releaseUnsent(entryId: string): Promise<void> {
    const now = this.clock();
    await this.withEntry(entryId, async (c, e) => {
      if (e.status === 'released') return;
      if (e.status !== 'reserved') throw new SpendStateError(`A ${e.status} entry cannot be released as unsent`);
      await c.query(
        `UPDATE ai_spend_entries SET status = 'released', amount_micro_myr = 0, note = 'never sent', updated_at = $2 WHERE id = $1`,
        [entryId, now],
      );
    });
  }

  /** The provider has shown that an uncertain request was not charged. The evidence is kept in the note. */
  async reconcileNotCharged(entryId: string, evidence: string): Promise<void> {
    const now = this.clock();
    await this.withEntry(entryId, async (c, e) => {
      if (e.status === 'released') return;
      if (e.status !== 'uncertain') throw new SpendStateError(`A ${e.status} entry is not waiting to be reconciled`);
      await c.query(
        `UPDATE ai_spend_entries SET status = 'released', amount_micro_myr = 0, note = $2, updated_at = $3 WHERE id = $1`,
        [entryId, evidence, now],
      );
    });
  }

  async getEntry(entryId: string): Promise<SpendEntry | null> {
    const { rows } = await this.pool.query<EntryRow>(`SELECT ${ENTRY_COLUMNS} FROM ai_spend_entries WHERE id = $1`, [entryId]);
    const e = rows[0];
    return e
      ? {
          id: e.id,
          status: e.status,
          estimateMicroMyr: BigInt(e.estimate),
          amountMicroMyr: BigInt(e.amount),
          exceededEstimate: e.exceeded_estimate,
          modelId: e.model_id,
        }
      : null;
  }

  /** Where the allowance stands now, for the administrator's view and for display. */
  async summary(): Promise<SpendSummary> {
    const now = this.clock();
    const settings = await readSettings(this.pool);
    if (!settings) {
      return { configured: false, monthly: null, daily: null };
    }
    const build = async (limit: bigint | null, period: Period): Promise<PeriodSummary> => {
      const totals = await this.totals(this.pool, period);
      const remaining = limit === null ? 0n : limit - totals.used;
      return {
        period,
        limitMicroMyr: limit,
        usedMicroMyr: totals.used,
        reservedMicroMyr: totals.reserved,
        uncertainMicroMyr: totals.uncertain,
        remainingMicroMyr: remaining > 0n ? remaining : 0n,
      };
    };
    return {
      configured: true,
      monthly: await build(settings.monthlyLimitMicroMyr, monthPeriod(now)),
      daily: settings.daily.mode === 'limit' ? await build(settings.daily.limitMicroMyr, dayPeriod(now)) : null,
    };
  }

  private async totals(db: Pool | PoolClient, period: Period): Promise<{ used: bigint; reserved: bigint; uncertain: bigint }> {
    const { rows } = await db.query<{ used: string; reserved: string; uncertain: string }>(
      `SELECT COALESCE(SUM(amount_micro_myr), 0)::text AS used,
              COALESCE(SUM(amount_micro_myr) FILTER (WHERE status = 'reserved'), 0)::text AS reserved,
              COALESCE(SUM(amount_micro_myr) FILTER (WHERE status = 'uncertain'), 0)::text AS uncertain
         FROM ai_spend_entries
        WHERE status <> 'released' AND created_at >= $1 AND created_at < $2`,
      [period.start, period.end],
    );
    return { used: BigInt(rows[0].used), reserved: BigInt(rows[0].reserved), uncertain: BigInt(rows[0].uncertain) };
  }

  private async block(
    c: PoolClient,
    at: Date,
    input: ReserveInput,
    reason: BlockReason,
    scope?: Scope,
    remainingMicroMyr?: bigint,
  ): Promise<ReserveResult> {
    await writeAudit(c, {
      at,
      action: 'ai.request_blocked',
      actorUserId: input.actorUserId ?? null,
      detail: { reason, scope: scope ?? null, purpose: input.purpose, requestId: input.requestId, attemptNo: input.attemptNo },
    });
    return { status: 'blocked', reason, scope, remainingMicroMyr };
  }

  private async withEntry<T>(entryId: string, work: (c: PoolClient, entry: EntryRow) => Promise<T>): Promise<T> {
    return this.tx(async (c) => {
      const { rows } = await c.query<EntryRow>(`SELECT ${ENTRY_COLUMNS} FROM ai_spend_entries WHERE id = $1 FOR UPDATE`, [entryId]);
      if (!rows[0]) {
        throw new SpendStateError(`No spend entry ${entryId}`);
      }
      return work(c, rows[0]);
    });
  }

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
