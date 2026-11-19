import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { readReason, refuseSecretsIn } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import type { Prices } from '../spend/cost';
import { formatMicro, parseMicro } from '../spend/money';
import type { AiPurpose } from './guarded-call';
import type { Provider } from './keys';

export const PURPOSES = ['extraction', 'discussion_analysis', 'minutes_draft', 'question_answer', 'report_draft', 'summary_draft'] as const;

// Compile-time check that PURPOSES and AiPurpose hold exactly the same values.
type SamePurposes = [AiPurpose] extends [(typeof PURPOSES)[number]] ? ([(typeof PURPOSES)[number]] extends [AiPurpose] ? true : never) : never;
export const PURPOSES_MATCH_AI_PURPOSE: SamePurposes = true;

export const PROVIDERS: readonly Provider[] = ['openai', 'anthropic'];

/** The four per-model prices; the exchange rate belongs to the organisation, not to a model. */
export type ModelPrices = Omit<Prices, 'myrPerUsdMicro'>;

export interface ApprovedModel {
  id: string;
  provider: Provider;
  modelId: string;
  displayName: string;
  prices: ModelPrices;
  purposes: AiPurpose[];
  restrictedOk: boolean;
  dataTerms: string;
  state: 'approved' | 'withdrawn';
}

export interface ModelInput {
  provider: Provider;
  modelId: string;
  displayName: string;
  prices: ModelPrices;
  dataTerms: string;
  purposes: AiPurpose[];
  restrictedOk: boolean;
}

interface Row {
  id: string;
  provider: Provider;
  model_id: string;
  display_name: string;
  p_in: string;
  p_cached: string;
  p_write: string;
  p_out: string;
  data_terms: string;
  purposes: AiPurpose[];
  restricted_ok: boolean;
  state: 'approved' | 'withdrawn';
}

const COLUMNS = `id, provider, model_id, display_name, input_usd_per_million_micro::text AS p_in,
  cached_input_usd_per_million_micro::text AS p_cached, cache_write_usd_per_million_micro::text AS p_write,
  output_usd_per_million_micro::text AS p_out, data_terms, purposes, restricted_ok, state`;

/** The four price columns, read as text (`p_in`, `p_cached`, `p_write`, `p_out`), as model prices. */
export function modelPricesFromColumns(r: { p_in: string; p_cached: string; p_write: string; p_out: string }): ModelPrices {
  return {
    inputMicroUsdPerMillion: BigInt(r.p_in),
    cachedInputMicroUsdPerMillion: BigInt(r.p_cached),
    cacheWriteMicroUsdPerMillion: BigInt(r.p_write),
    outputMicroUsdPerMillion: BigInt(r.p_out),
  };
}

function toModel(r: Row): ApprovedModel {
  return {
    id: r.id,
    provider: r.provider,
    modelId: r.model_id,
    displayName: r.display_name,
    prices: modelPricesFromColumns(r),
    purposes: r.purposes,
    restrictedOk: r.restricted_ok,
    dataTerms: r.data_terms,
    state: r.state,
  };
}

/** A model as plain text for the API and the event log (prices as six-decimal USD strings). Never holds a secret. */
export function describeModel(m: ApprovedModel | ModelInput) {
  return {
    ...('id' in m ? { id: m.id } : {}),
    provider: m.provider,
    modelId: m.modelId,
    displayName: m.displayName,
    prices: {
      inputUsdPerMillion: formatMicro(m.prices.inputMicroUsdPerMillion),
      cachedInputUsdPerMillion: formatMicro(m.prices.cachedInputMicroUsdPerMillion),
      cacheWriteUsdPerMillion: formatMicro(m.prices.cacheWriteMicroUsdPerMillion),
      outputUsdPerMillion: formatMicro(m.prices.outputMicroUsdPerMillion),
    },
    purposes: m.purposes,
    restrictedOk: m.restrictedOk,
    dataTerms: m.dataTerms,
    ...('state' in m ? { state: m.state } : {}),
  };
}

function text(value: unknown, label: string, max: number): string {
  const t = typeof value === 'string' ? value.trim() : '';
  if (t === '' || t.length > max) throw new BadRequestException(`Give ${label} (1 to ${max.toLocaleString('en-US')} characters).`);
  refuseSecretsIn(t);
  return t;
}

/** Reads and checks the body of an approve or change request. Throws 400 with a plain message. */
export function parseModelBody(body: unknown): { input: ModelInput; reason: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Send the model details as a JSON object.');
  const b = body as Record<string, unknown>;
  if (typeof b.provider !== 'string' || !(PROVIDERS as readonly string[]).includes(b.provider)) {
    throw new BadRequestException('The provider must be openai or anthropic.');
  }
  const purposes = b.purposes;
  if (!Array.isArray(purposes) || purposes.some((p) => typeof p !== 'string' || !(PURPOSES as readonly string[]).includes(p))) {
    throw new BadRequestException(`Purposes must be chosen from: ${PURPOSES.join(', ')}.`);
  }
  if (new Set(purposes).size !== purposes.length) throw new BadRequestException('A purpose is listed twice.');
  if (typeof b.restrictedOk !== 'boolean') throw new BadRequestException('Say whether this model is approved for restricted material (true or false).');
  const input: ModelInput = {
    provider: b.provider as Provider,
    modelId: text(b.modelId, 'the model identifier', 200),
    displayName: text(b.displayName, 'a display name', 200),
    prices: {
      inputMicroUsdPerMillion: parseMicro(b.inputUsdPerMillion, 'inputUsdPerMillion'),
      cachedInputMicroUsdPerMillion: parseMicro(b.cachedInputUsdPerMillion, 'cachedInputUsdPerMillion'),
      cacheWriteMicroUsdPerMillion: parseMicro(b.cacheWriteUsdPerMillion ?? '0', 'cacheWriteUsdPerMillion'),
      outputMicroUsdPerMillion: parseMicro(b.outputUsdPerMillion, 'outputUsdPerMillion'),
    },
    dataTerms: text(b.dataTerms, 'the data terms', 4000),
    purposes: purposes as AiPurpose[],
    restrictedOk: b.restrictedOk,
  };
  return { input, reason: readReason(b.reason) };
}

type EventAction = 'approved' | 'changed' | 'withdrawn' | 'reapproved';

@Injectable()
export class ModelsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(): Promise<ApprovedModel[]> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM ai_models ORDER BY provider, display_name, id`);
    return rows.map(toModel);
  }

  async get(id: string): Promise<ApprovedModel | null> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM ai_models WHERE id = $1`, [id]);
    return rows[0] ? toModel(rows[0]) : null;
  }

  /** Approves a model. A withdrawn model with the same provider and identifier is brought back under its own id. */
  async approve(input: ModelInput, reason: string, actorUserId: string | null): Promise<ApprovedModel> {
    return this.inTransaction(async (c, now) => {
      const existing = await c.query<Row>(`SELECT ${COLUMNS} FROM ai_models WHERE provider = $1 AND model_id = $2 FOR UPDATE`, [input.provider, input.modelId]);
      const before = existing.rows[0] ? toModel(existing.rows[0]) : null;
      if (before && before.state === 'approved') throw new ConflictException('This model is already approved.');
      const id = before?.id ?? uuidv7(now.getTime());
      const values = [
        input.displayName,
        input.prices.inputMicroUsdPerMillion.toString(),
        input.prices.cachedInputMicroUsdPerMillion.toString(),
        input.prices.cacheWriteMicroUsdPerMillion.toString(),
        input.prices.outputMicroUsdPerMillion.toString(),
        input.dataTerms,
        input.purposes,
        input.restrictedOk,
        now,
        actorUserId,
      ];
      if (before) {
        await c.query(
          `UPDATE ai_models SET display_name = $2, input_usd_per_million_micro = $3, cached_input_usd_per_million_micro = $4,
             cache_write_usd_per_million_micro = $5, output_usd_per_million_micro = $6, data_terms = $7, purposes = $8,
             restricted_ok = $9, state = 'approved', updated_at = $10, updated_by = $11 WHERE id = $1`,
          [id, ...values],
        );
      } else {
        try {
          await c.query(
            `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
               cache_write_usd_per_million_micro, output_usd_per_million_micro, data_terms, purposes, restricted_ok, state, updated_at, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'approved', $12, $13)`,
            [id, input.provider, input.modelId, ...values],
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw new ConflictException('This model is already approved.');
          throw err;
        }
      }
      const after = (await this.read(c, id))!;
      await this.record(c, now, id, before ? 'reapproved' : 'approved', actorUserId, reason, before, after);
      return after;
    });
  }

  /** Changes everything but the provider and the identifier. */
  async change(id: string, input: ModelInput, reason: string, actorUserId: string | null): Promise<ApprovedModel> {
    return this.inTransaction(async (c, now) => {
      const before = await this.lock(c, id);
      if (input.provider !== before.provider || input.modelId !== before.modelId) {
        throw new BadRequestException('The provider and the model identifier cannot be changed. Approve a new model instead.');
      }
      await c.query(
        `UPDATE ai_models SET display_name = $2, input_usd_per_million_micro = $3, cached_input_usd_per_million_micro = $4,
           cache_write_usd_per_million_micro = $5, output_usd_per_million_micro = $6, data_terms = $7, purposes = $8,
           restricted_ok = $9, updated_at = $10, updated_by = $11 WHERE id = $1`,
        [
          id,
          input.displayName,
          input.prices.inputMicroUsdPerMillion.toString(),
          input.prices.cachedInputMicroUsdPerMillion.toString(),
          input.prices.cacheWriteMicroUsdPerMillion.toString(),
          input.prices.outputMicroUsdPerMillion.toString(),
          input.dataTerms,
          input.purposes,
          input.restrictedOk,
          now,
          actorUserId,
        ],
      );
      const after = (await this.read(c, id))!;
      await this.record(c, now, id, 'changed', actorUserId, reason, before, after);
      return after;
    });
  }

  async withdraw(id: string, reason: string, actorUserId: string | null): Promise<ApprovedModel> {
    return this.inTransaction(async (c, now) => {
      const before = await this.lock(c, id);
      if (before.state === 'withdrawn') throw new ConflictException('This model is already withdrawn.');
      await c.query(`UPDATE ai_models SET state = 'withdrawn', updated_at = $2, updated_by = $3 WHERE id = $1`, [id, now, actorUserId]);
      const after = (await this.read(c, id))!;
      await this.record(c, now, id, 'withdrawn', actorUserId, reason, before, after);
      return after;
    });
  }

  private async read(c: PoolClient, id: string): Promise<ApprovedModel | null> {
    const { rows } = await c.query<Row>(`SELECT ${COLUMNS} FROM ai_models WHERE id = $1`, [id]);
    return rows[0] ? toModel(rows[0]) : null;
  }

  private async lock(c: PoolClient, id: string): Promise<ApprovedModel> {
    const { rows } = await c.query<Row>(`SELECT ${COLUMNS} FROM ai_models WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new NotFoundException('That model is not in the catalogue.');
    return toModel(rows[0]);
  }

  private async record(c: PoolClient, at: Date, id: string, action: EventAction, actorUserId: string | null, reason: string, before: ApprovedModel | null, after: ApprovedModel): Promise<void> {
    const detail = { previous: before ? describeModel(before) : null, new: describeModel(after) };
    await c.query(`INSERT INTO ai_model_events (id, model_ref, action, actor_id, reason, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      uuidv7(at.getTime()),
      id,
      action,
      actorUserId,
      reason,
      JSON.stringify(detail),
      at,
    ]);
    await writeAudit(c, { at, action: `ai.model_${action}`, actorUserId, subjectType: 'ai_model', subjectId: id, detail: { provider: after.provider, modelId: after.modelId } });
  }

  private async inTransaction<T>(work: (c: PoolClient, now: Date) => Promise<T>): Promise<T> {
    const now = this.clock();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client, now);
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
