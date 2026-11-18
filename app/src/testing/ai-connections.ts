import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { ModelClientFactory, ProviderClient } from '../ai/client-factory';
import { type KeyBinding, type Provider, sealApiKey } from '../ai/keys';
import { uuidv7 } from '../common/uuid7';
import type { ProtectedKey } from '../quarantine/protected-key';
import type { Prices } from '../spend/cost';
import { seedProject } from './projects';

/** Shared by the AI connection tests. Obviously fake keys only. */
export const KEY_A = `sk-test-${'x'.repeat(40)}`;
export const KEY_B = `sk-test-${'y'.repeat(40)}`;

export const ORG = {
  myrPerUsd: 4.1,
  monthlyLimitMyr: 200,
  daily: { mode: 'not_applied' },
  projectsMaySetLimits: false,
  projectsMayManageConnections: false,
  projectCeiling: { mode: 'not_applied' },
  maxAttempts: 3,
  timeoutSeconds: 120,
  concurrency: 2,
};

export const modelBody = (provider: 'openai' | 'anthropic', modelId: string) => ({
  provider,
  modelId,
  displayName: `Model ${modelId}`,
  inputUsdPerMillion: '2.00',
  cachedInputUsdPerMillion: '0.10',
  cacheWriteUsdPerMillion: '0',
  outputUsdPerMillion: '10.00',
  dataTerms: 'Not used for training; retained 30 days.',
  purposes: ['extraction'],
  restrictedOk: false,
  reason: 'Reviewed the provider terms',
});

/** A key file in a temporary folder; returns its path. */
export function keyFile(dir: string, name = 'p.key'): string {
  const path = join(dir, name);
  writeFileSync(path, randomBytes(32));
  return path;
}


/** The approved test model prices (USD 2.00 / 0.10 / 0 / 10.00 per million) at the MVP rate of 4.1. */
export const TEST_PRICES: Prices = {
  inputMicroUsdPerMillion: 2_000_000n,
  cachedInputMicroUsdPerMillion: 100_000n,
  cacheWriteMicroUsdPerMillion: 0n,
  outputMicroUsdPerMillion: 10_000_000n,
  myrPerUsdMicro: 4_100_000n,
};

/** An approved catalogue model at TEST_PRICES; the model id is unique unless given. */
export async function seedAiModel(
  pool: Pool,
  o: { provider?: Provider; modelId?: string; purposes?: string[]; restrictedOk?: boolean; state?: 'approved' | 'withdrawn' } = {},
): Promise<{ id: string; provider: Provider; modelId: string }> {
  const id = uuidv7();
  const provider = o.provider ?? 'openai';
  const modelId = o.modelId ?? `test-model-${id.slice(-12)}`;
  await pool.query(
    `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
                            cache_write_usd_per_million_micro, output_usd_per_million_micro, data_terms, purposes, restricted_ok, state, updated_at)
     VALUES ($1, $2, $3, $4, 2000000, 100000, 0, 10000000, 'Not used for training.', $5, $6, $7, now())`,
    [
      id,
      provider,
      modelId,
      `Model ${modelId}`,
      o.purposes ?? ['extraction', 'discussion_analysis', 'minutes_draft', 'question_answer', 'report_draft', 'summary_draft'],
      o.restrictedOk ?? true,
      o.state ?? 'approved',
    ],
  );
  return { id, provider, modelId };
}

/**
 * A project connection to `model` at `position`. With a protected key and an API key, its current key is sealed for this
 * connection; with `sealedFor`, the sealed row of another binding is stored instead (a copied row that will not open).
 */
export async function seedAiConnection(
  pool: Pool,
  o: {
    projectId: string;
    model: { id: string; provider: Provider };
    position: number;
    label?: string;
    state?: 'ready' | 'unchecked' | 'key_rejected' | 'disabled';
    protectedKey?: ProtectedKey | null;
    apiKey?: string;
    sealedFor?: KeyBinding;
  },
): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, created_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [id, o.projectId, o.model.id, o.label ?? `Connection ${o.position}`, o.position, o.state ?? 'ready'],
  );
  if (o.protectedKey) {
    const binding = o.sealedFor ?? { connectionId: id, projectId: o.projectId, provider: o.model.provider };
    const sealed = sealApiKey(o.protectedKey, o.apiKey ?? KEY_A, binding);
    await pool.query(
      `INSERT INTO ai_connection_keys (id, connection_id, ciphertext, nonce, tag, key_id, saved_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [uuidv7(), id, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId],
    );
  }
  return id;
}

/** The project's own limits row: a generous monthly allowance unless given; nothing else applied. */
export async function seedProjectAllowance(
  pool: Pool,
  projectId: string,
  o: { monthlyMicroMyr?: bigint | null; maxAttempts?: number | null; timeoutSeconds?: number | null } = {},
): Promise<void> {
  const monthly = o.monthlyMicroMyr === undefined ? 1_000_000_000n : o.monthlyMicroMyr;
  await pool.query(
    `INSERT INTO project_ai_limits (project_id, monthly_limit_micro_myr, daily_mode, user_monthly_mode, max_attempts, timeout_seconds, updated_at)
     VALUES ($1, $2, 'not_applied', 'not_applied', $3, $4, now())
     ON CONFLICT (project_id) DO UPDATE SET monthly_limit_micro_myr = EXCLUDED.monthly_limit_micro_myr,
       max_attempts = EXCLUDED.max_attempts, timeout_seconds = EXCLUDED.timeout_seconds`,
    [projectId, monthly === null ? null : monthly.toString(), o.maxAttempts ?? null, o.timeoutSeconds ?? null],
  );
}

/**
 * For spend tests that are about the organisation's limits: one active project with a generous allowance and one
 * connection (no key needed to reserve). Returns the project-scope fields of a ReserveInput.
 */
export async function seedSpendTarget(
  pool: Pool,
  pmUserId: string,
): Promise<{ projectId: string; connectionId: string; provider: Provider; modelId: string; prices: Prices }> {
  const projectId = await seedProject(pool, { status: 'active', members: [{ userId: pmUserId, role: 'pm' }] });
  const model = await seedAiModel(pool);
  const connectionId = await seedAiConnection(pool, { projectId, model, position: 1 });
  await seedProjectAllowance(pool, projectId);
  return { projectId, connectionId, provider: model.provider, modelId: model.modelId, prices: TEST_PRICES };
}

/** A model-client factory for tests: records every client built (with the key it was given); the client is a token the test's `call` ignores. */
export function fakeFactory(): ModelClientFactory & { opened: { provider: string; apiKey: string; timeoutMs: number }[] } {
  const opened: { provider: string; apiKey: string; timeoutMs: number }[] = [];
  return {
    opened,
    forAttempt(c) {
      opened.push(c);
      return { provider: c.provider } as unknown as ProviderClient;
    },
  };
}
