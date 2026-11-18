import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { ModelClientFactory, ProviderClient } from '../ai/client-factory';
import type { Provider } from '../ai/keys';
import { type ProtectedKey, loadProtectedKey } from '../quarantine/protected-key';
import { seedAiConnection, seedAiModel } from './ai-connections';

/**
 * Test-only: makes a project ready for AI runs (sub-project 6), so runner tests reach the AI call through the project's
 * connections, the protected key and the project's limits, as production does.
 */

/** The model the default connection uses: the model id the runner tests have always expected. */
export const RUN_MODEL = 'gpt-6.1-sol';

let testKey: ProtectedKey | null = null;

/** One random protected key for the whole test process, held in memory only (the temporary file is removed at once). */
export function testProtectedKey(): ProtectedKey {
  if (testKey) return testKey;
  const dir = mkdtempSync(join(tmpdir(), 'kainow-ai-key-'));
  try {
    const file = join(dir, 'key');
    writeFileSync(file, randomBytes(32));
    testKey = loadProtectedKey(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!testKey) throw new Error('could not make the test protected key');
  return testKey;
}

/**
 * A factory that hands every attempt the given fake client (an object with `extract`, `draftMinutes` and/or `callJson`).
 * With null, every call throws an unexpected error, as a client that cannot be used.
 */
export function factoryFor(client: object | null): ModelClientFactory & { opened: Array<{ provider: Provider; timeoutMs: number }> } {
  const opened: Array<{ provider: Provider; timeoutMs: number }> = [];
  const broken = new Proxy({}, { get: () => async () => { throw new Error('no fake client was given to this test'); } });
  return {
    opened,
    forAttempt({ provider, timeoutMs }) {
      opened.push({ provider, timeoutMs });
      return (client ?? broken) as ProviderClient;
    },
  };
}

/** The runner deps that reach the AI: the test protected key and a factory for `client`. Spread into RunnerDeps. */
export function aiDeps(client: object | null): { key: ProtectedKey; factory: ModelClientFactory } {
  return { key: testProtectedKey(), factory: factoryFor(client) };
}

/**
 * Makes `projectId` ready for AI: an approved model (RUN_MODEL unless given; reused when it already exists), a ready
 * connection after the project's last one with a fake key sealed under testProtectedKey(), and a generous project
 * monthly allowance (kept when the project already has a limits row). Returns the connection id.
 */
export async function aiReady(
  pool: Pool,
  projectId: string,
  o: { modelId?: string; provider?: Provider; restrictedOk?: boolean; label?: string } = {},
): Promise<string> {
  const provider = o.provider ?? 'openai';
  const modelId = o.modelId ?? RUN_MODEL;
  const existing = (
    await pool.query<{ id: string; restricted_ok: boolean }>(`SELECT id, restricted_ok FROM ai_models WHERE provider = $1 AND model_id = $2`, [provider, modelId])
  ).rows[0];
  let model: { id: string; provider: Provider };
  if (existing) {
    if (o.restrictedOk !== undefined && existing.restricted_ok !== o.restrictedOk) throw new Error(`model ${modelId} already exists with another restricted_ok`);
    model = { id: existing.id, provider };
  } else {
    model = await seedAiModel(pool, { provider, modelId, restrictedOk: o.restrictedOk ?? true });
  }
  const position = (await pool.query<{ n: number }>(`SELECT COALESCE(max(position), 0) + 1 AS n FROM ai_connections WHERE project_id = $1`, [projectId])).rows[0].n;
  const connectionId = await seedAiConnection(pool, { projectId, model, position, label: o.label, protectedKey: testProtectedKey() });
  await pool.query(
    `INSERT INTO project_ai_limits (project_id, monthly_limit_micro_myr, daily_mode, user_monthly_mode, updated_at)
     VALUES ($1, 1000000000, 'not_applied', 'not_applied', now()) ON CONFLICT (project_id) DO NOTHING`,
    [projectId],
  );
  return connectionId;
}

type CountingTable = 'extraction_runs' | 'analysis_runs' | 'ai_requests';

const PROJECT_OF: Record<CountingTable, string> = {
  extraction_runs: `SELECT s.project_id FROM extraction_runs r JOIN source_versions v ON v.id = r.source_version_id JOIN sources s ON s.id = v.source_id WHERE r.id = $1`,
  analysis_runs: `SELECT th.project_id FROM analysis_runs a JOIN discussion_threads th ON th.id = a.thread_id WHERE a.id = $1`,
  ai_requests: `SELECT project_id FROM ai_requests WHERE id = $1`,
};

/** The runner shape since Task 11: the attempt number comes from the request row, not from the job. */
export interface CountingRunner<R> {
  process(id: string, job: { resume?: number }): Promise<R>;
}

/**
 * Drives a runner as attempt `attemptNo` of a request, last when `isLast`, the way pg-boss numbered attempts before
 * sub-project 6: the request row's counter is set so the claim makes it `attemptNo`, and the project's own attempts
 * are set to `attemptNo` when it is the last (otherwise cleared, so the organisation's apply). For the tests written
 * against the old `process(id, attemptNo, isLast)`; the counting itself is tested directly.
 */
export function byAttempt<R>(pool: Pool, table: CountingTable, runner: CountingRunner<R>): { process(id: string, attemptNo?: number, isLast?: boolean): Promise<R> } {
  return {
    async process(id: string, attemptNo = 1, isLast = false): Promise<R> {
      await pool.query(`UPDATE ${table} SET attempts = $2 - 1 WHERE id = $1 AND status IN ('queued', 'running')`, [id, attemptNo]);
      const project = (await pool.query<{ project_id: string | null }>(PROJECT_OF[table], [id])).rows[0]?.project_id;
      if (project) await pool.query(`UPDATE project_ai_limits SET max_attempts = $2 WHERE project_id = $1`, [project, isLast ? attemptNo : null]);
      return runner.process(id, {});
    },
  };
}
