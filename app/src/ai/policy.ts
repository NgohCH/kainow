import type { Pool, PoolClient } from 'pg';
import { POLICY_BOUNDS } from '../spend/spend.settings';

export { POLICY_BOUNDS };

type Db = Pool | PoolClient;

/** What applies to one project's AI calls: the organisation's numbers, lowered by the project's own where it set lower ones. */
export interface EffectivePolicy {
  maxAttempts: number;
  timeoutMs: number;
  concurrency: number;
  source: { maxAttempts: 'organisation' | 'project'; timeoutSeconds: 'organisation' | 'project' };
}

/** The defaults when no organisation settings have been saved (the column defaults, D87). */
export const DEFAULT_POLICY = { maxAttempts: 3, timeoutSeconds: 120, concurrency: 2 } as const;

/**
 * A project value may only be lower than or equal to the organisation's, so the lower of the two applies even when the
 * Administrator lowered the organisation value after the project set its own. Importable without Nest (the worker passes
 * a plain Pool). Concurrency is organisation-wide only.
 */
export async function effectivePolicy(db: Db, projectId: string): Promise<EffectivePolicy> {
  const { rows } = await db.query<{ max_attempts: number | null; timeout_seconds: number | null; o_attempts: number | null; o_timeout: number | null; o_concurrency: number | null }>(
    `SELECT p.max_attempts, p.timeout_seconds, o.max_attempts AS o_attempts, o.timeout_seconds AS o_timeout, o.concurrency AS o_concurrency
       FROM (SELECT 1) one
       LEFT JOIN ai_spend_settings o ON o.id = 1
       LEFT JOIN project_ai_limits p ON p.project_id = $1`,
    [projectId],
  );
  const r = rows[0];
  const orgAttempts = r?.o_attempts ?? DEFAULT_POLICY.maxAttempts;
  const orgTimeout = r?.o_timeout ?? DEFAULT_POLICY.timeoutSeconds;
  const ownAttempts = r?.max_attempts ?? null;
  const ownTimeout = r?.timeout_seconds ?? null;
  const attemptsFromProject = ownAttempts !== null && ownAttempts < orgAttempts;
  const timeoutFromProject = ownTimeout !== null && ownTimeout < orgTimeout;
  return {
    maxAttempts: attemptsFromProject ? (ownAttempts as number) : orgAttempts,
    timeoutMs: (timeoutFromProject ? (ownTimeout as number) : orgTimeout) * 1000,
    concurrency: r?.o_concurrency ?? DEFAULT_POLICY.concurrency,
    source: { maxAttempts: attemptsFromProject ? 'project' : 'organisation', timeoutSeconds: timeoutFromProject ? 'project' : 'organisation' },
  };
}
