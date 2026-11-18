import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import type { Provider } from '../ai/keys';
import { readProjectLimits } from '../ai/limits.service';
import { costMicroMyr, type Prices, type Usage } from './cost';
import { dayPeriod, monthPeriod, type Period } from './periods';
import { readSettings, type SpendSettings } from './spend.settings';

/** Serialises reservations so parallel requests cannot each see the same headroom. */
const SPEND_LOCK_KEY = 7201108;

export type Scope = 'monthly' | 'daily' | 'user_monthly' | 'project_monthly' | 'project_daily' | 'project_user_monthly';
export type BlockReason = 'not_configured' | 'no_allowance' | 'cap_would_be_exceeded' | 'project_not_configured';

/** The failure code for a refusal. The one place a code is composed from (scope, reason). */
export function spendFailureCode(reason: BlockReason, scope?: Scope): string {
  if (reason === 'project_not_configured') return 'spend_project_not_configured';
  const level: Record<Scope, string> = {
    monthly: '',
    daily: '',
    user_monthly: 'user_',
    project_monthly: 'project_',
    project_daily: 'project_daily_',
    project_user_monthly: 'project_user_',
  };
  return `spend_${scope ? level[scope] : ''}${reason}`;
}

/** What each level is called in a failure detail: [no allowance, would exceed]. Organisation wording is unchanged. */
const DETAIL: Record<Scope, [string, string]> = {
  monthly: ['There is no AI allowance (the limit is blank or zero).', 'This request could cost more than the AI allowance that is left.'],
  daily: ['There is no AI allowance (the limit is blank or zero).', 'This request could cost more than the AI allowance that is left.'],
  user_monthly: [
    'This person has no personal AI allowance (the personal limit is blank or zero).',
    'This request could cost more than the personal monthly AI allowance that is left.',
  ],
  project_monthly: [
    "The project has no monthly AI allowance (the project's limit is blank or zero).",
    "This request could cost more than the project's monthly AI allowance that is left.",
  ],
  project_daily: [
    "The project has no daily AI allowance (the project's daily limit is blank or zero).",
    "This request could cost more than the project's daily AI allowance that is left.",
  ],
  project_user_monthly: [
    "This person has no personal AI allowance in this project (the project's personal limit is blank or zero).",
    "This request could cost more than the person's monthly AI allowance in this project that is left.",
  ],
};

/** The failure detail, naming the level that refused. */
export function spendFailureDetail(reason: BlockReason, scope?: Scope): string {
  if (reason === 'not_configured') return 'The AI spend settings have not been approved yet, so no AI request is allowed.';
  if (reason === 'project_not_configured') return 'AI is not set up for this project: it has no AI allowance yet.';
  const [none, exceeded] = DETAIL[scope ?? 'monthly'];
  return reason === 'no_allowance' ? none : exceeded;
}

export type ReserveResult =
  | { status: 'reserved'; entryId: string }
  | { status: 'blocked'; reason: BlockReason; scope?: Scope; remainingMicroMyr?: bigint };

export interface OrganisationReserveInput {
  /** One logical request. Each retry or fallback is a further attempt of the same request. */
  requestId: string;
  attemptNo: number;
  /** From estimateMaxCostMicroMyr. Must be positive: an unknown cost is never zero. */
  estimateMicroMyr: bigint;
  purpose: string;
  actorUserId?: string | null;
}

export interface ReserveInput extends OrganisationReserveInput {
  projectId: string;
  connectionId: string;
  provider: Provider;
  /** The catalogue model identifier, as the provider knows it. */
  modelId: string;
  /** The price snapshot kept on the entry; settling prices the real usage from it. */
  prices: Prices;
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
  /** The caller's own monthly figures, only when a per-person limit applies and a person is given. */
  mine: PeriodSummary | null;
  /** The given project's monthly figures (limit null: no allowance), when a project is given. */
  project: PeriodSummary | null;
  /** null when the project has no daily limit applied. */
  projectDaily: PeriodSummary | null;
  /** The caller's own monthly figures in the project, only when a per-person project limit applies. */
  projectMine: PeriodSummary | null;
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
  p_cache_write: string | null;
  p_out: string;
  fx: string;
}

const ENTRY_COLUMNS = `id, status, estimate_micro_myr::text AS estimate, amount_micro_myr::text AS amount, exceeded_estimate, model_id,
  input_usd_per_million_micro::text AS p_in, cached_input_usd_per_million_micro::text AS p_cached,
  cache_write_usd_per_million_micro::text AS p_cache_write, output_usd_per_million_micro::text AS p_out, myr_per_usd_micro::text AS fx`;

function snapshotPrices(row: EntryRow): Prices {
  return {
    inputMicroUsdPerMillion: BigInt(row.p_in),
    cachedInputMicroUsdPerMillion: BigInt(row.p_cached),
    cacheWriteMicroUsdPerMillion: BigInt(row.p_cache_write ?? '0'), // entries from before 0028 had none
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
   * allow it, checked in the order of the spec (organisation, then project). A blank or zero limit
   * allows nothing, and so does having no approved settings or no project limits.
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    this.checkInput(input);
    const now = this.clock();
    return this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [SPEND_LOCK_KEY]);
      const settings = await readSettings(c);
      if (!settings) {
        return this.block(c, now, input, 'not_configured');
      }
      const refused = await this.checkOrganisation(c, now, input, settings);
      if (refused) return refused;

      const project = await readProjectLimits(c, input.projectId);
      if (!project) {
        return this.block(c, now, input, 'project_not_configured', 'project_monthly', 0n);
      }
      const checks: { scope: Scope; limit: bigint | null; period: Period; actor?: string }[] = [
        { scope: 'project_monthly', limit: project.monthlyLimitMicroMyr, period: monthPeriod(now) },
      ];
      if (project.daily.mode === 'limit') {
        checks.push({ scope: 'project_daily', limit: project.daily.limitMicroMyr, period: dayPeriod(now) });
      }
      if (project.userMonthly.mode === 'limit' && input.actorUserId) {
        checks.push({ scope: 'project_user_monthly', limit: project.userMonthly.limitMicroMyr, period: monthPeriod(now), actor: input.actorUserId });
      }
      for (const { scope, limit, period, actor } of checks) {
        const refusal = await this.checkLimit(c, now, input, scope, limit, period, actor, input.projectId);
        if (refusal) return refusal;
      }

      const entryId = uuidv7(now.getTime());
      await c.query(
        `INSERT INTO ai_spend_entries
           (id, request_id, attempt_no, created_at, updated_at, status, purpose, actor_user_id, model_id,
            input_usd_per_million_micro, cached_input_usd_per_million_micro, cache_write_usd_per_million_micro,
            output_usd_per_million_micro, myr_per_usd_micro, estimate_micro_myr, amount_micro_myr,
            project_id, connection_id, provider, ruled)
         VALUES ($1, $2, $3, $4, $4, 'reserved', $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, $15, $16, true)`,
        [
          entryId,
          input.requestId,
          input.attemptNo,
          now,
          input.purpose,
          input.actorUserId ?? null,
          input.modelId,
          input.prices.inputMicroUsdPerMillion.toString(),
          input.prices.cachedInputMicroUsdPerMillion.toString(),
          input.prices.cacheWriteMicroUsdPerMillion.toString(),
          input.prices.outputMicroUsdPerMillion.toString(),
          input.prices.myrPerUsdMicro.toString(),
          input.estimateMicroMyr.toString(),
          input.projectId,
          input.connectionId,
          input.provider,
        ],
      );
      return { status: 'reserved', entryId };
    });
  }

  private checkInput(input: OrganisationReserveInput): void {
    if (input.estimateMicroMyr <= 0n) {
      throw new RangeError('estimateMicroMyr must be positive');
    }
    if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1) {
      throw new RangeError('attemptNo must be a whole number of at least 1');
    }
  }

  /** The organisation scopes. Null when all allow the estimate. The per-person limit applies only with an actor. */
  private async checkOrganisation(c: PoolClient, now: Date, input: OrganisationReserveInput, settings: SpendSettings): Promise<ReserveResult | null> {
    const limits: { scope: Scope; limit: bigint | null; period: Period; actor?: string }[] = [
      { scope: 'monthly', limit: settings.monthlyLimitMicroMyr, period: monthPeriod(now) },
    ];
    if (settings.daily.mode === 'limit') {
      limits.push({ scope: 'daily', limit: settings.daily.limitMicroMyr, period: dayPeriod(now) });
    }
    if (settings.userMonthly.mode === 'limit' && input.actorUserId) {
      limits.push({ scope: 'user_monthly', limit: settings.userMonthly.limitMicroMyr, period: monthPeriod(now), actor: input.actorUserId });
    }
    for (const { scope, limit, period, actor } of limits) {
      const refusal = await this.checkLimit(c, now, input, scope, limit, period, actor);
      if (refusal) return refusal;
    }
    return null;
  }

  private async checkLimit(
    c: PoolClient,
    now: Date,
    input: OrganisationReserveInput,
    scope: Scope,
    limit: bigint | null,
    period: Period,
    actor?: string,
    projectId?: string,
  ): Promise<ReserveResult | null> {
    if (limit === null || limit === 0n) {
      return this.block(c, now, input, 'no_allowance', scope, 0n, projectId);
    }
    const { used } = await this.totals(c, period, actor, projectId);
    const remaining = limit - used;
    if (input.estimateMicroMyr > remaining) {
      return this.block(c, now, input, 'cap_would_be_exceeded', scope, remaining > 0n ? remaining : 0n, projectId);
    }
    return null;
  }

  /**
   * Replaces the held estimate with the cost of the usage the provider reported, priced at the
   * rates in force when the request was reserved. Also settles an uncertain entry once the real
   * usage is known. Doing it again changes nothing, so a cost is never counted twice. If the
   * real cost is higher than the estimate, the real cost is recorded and the entry is flagged.
   * `note`, when given, is kept on the entry (a bad response is settled with the chooser's note).
   */
  async settle(entryId: string, usage: Usage, note?: string): Promise<void> {
    const now = this.clock();
    await this.withEntry(entryId, async (c, e) => {
      if (e.status === 'confirmed') return;
      if (e.status === 'released') throw new SpendStateError('A released entry cannot be settled');
      const amount = costMicroMyr(usage, snapshotPrices(e));
      await c.query(
        `UPDATE ai_spend_entries
            SET status = 'confirmed', amount_micro_myr = $2, input_tokens = $3, cached_input_tokens = $4,
                output_tokens = $5, exceeded_estimate = $6, updated_at = $7, cache_write_tokens = $8, note = COALESCE($9, note)
          WHERE id = $1`,
        [entryId, amount.toString(), usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, amount > BigInt(e.estimate), now, usage.cacheWriteTokens ?? 0, note ?? null],
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
  async summary(forUserId?: string, projectId?: string): Promise<SpendSummary> {
    const now = this.clock();
    const settings = await readSettings(this.pool);
    if (!settings) {
      return { configured: false, monthly: null, daily: null, mine: null, project: null, projectDaily: null, projectMine: null };
    }
    const build = async (limit: bigint | null, period: Period, actor?: string, project?: string): Promise<PeriodSummary> => {
      const totals = await this.totals(this.pool, period, actor, project);
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
    const limits = projectId ? await readProjectLimits(this.pool, projectId) : null;
    return {
      configured: true,
      project: projectId ? await build(limits?.monthlyLimitMicroMyr ?? null, monthPeriod(now), undefined, projectId) : null,
      projectDaily:
        projectId && limits?.daily.mode === 'limit' ? await build(limits.daily.limitMicroMyr, dayPeriod(now), undefined, projectId) : null,
      projectMine:
        projectId && limits?.userMonthly.mode === 'limit' && forUserId
          ? await build(limits.userMonthly.limitMicroMyr, monthPeriod(now), forUserId, projectId)
          : null,
      monthly: await build(settings.monthlyLimitMicroMyr, monthPeriod(now)),
      daily: settings.daily.mode === 'limit' ? await build(settings.daily.limitMicroMyr, dayPeriod(now)) : null,
      mine:
        settings.userMonthly.mode === 'limit' && forUserId
          ? await build(settings.userMonthly.limitMicroMyr, monthPeriod(now), forUserId)
          : null,
    };
  }

  /**
   * Organisation totals count every entry that is not released (ruled or not). With a project, only that
   * project's entries count: entries from before projects have none.
   */
  private async totals(db: Pool | PoolClient, period: Period, actorUserId?: string, projectId?: string): Promise<{ used: bigint; reserved: bigint; uncertain: bigint }> {
    const { rows } = await db.query<{ used: string; reserved: string; uncertain: string }>(
      `SELECT COALESCE(SUM(amount_micro_myr), 0)::text AS used,
              COALESCE(SUM(amount_micro_myr) FILTER (WHERE status = 'reserved'), 0)::text AS reserved,
              COALESCE(SUM(amount_micro_myr) FILTER (WHERE status = 'uncertain'), 0)::text AS uncertain
         FROM ai_spend_entries
        WHERE status <> 'released' AND created_at >= $1 AND created_at < $2
          AND ($3::uuid IS NULL OR actor_user_id = $3::uuid)
          AND ($4::uuid IS NULL OR project_id = $4::uuid)`,
      [period.start, period.end, actorUserId ?? null, projectId ?? null],
    );
    return { used: BigInt(rows[0].used), reserved: BigInt(rows[0].reserved), uncertain: BigInt(rows[0].uncertain) };
  }

  private async block(
    c: PoolClient,
    at: Date,
    input: OrganisationReserveInput,
    reason: BlockReason,
    scope?: Scope,
    remainingMicroMyr?: bigint,
    projectId?: string,
  ): Promise<ReserveResult> {
    const project = projectId ?? (input as Partial<ReserveInput>).projectId ?? null;
    await writeAudit(c, {
      at,
      action: 'ai.request_blocked',
      actorUserId: input.actorUserId ?? null,
      detail: { reason, scope: scope ?? null, projectId: project, purpose: input.purpose, requestId: input.requestId, attemptNo: input.attemptNo },
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
