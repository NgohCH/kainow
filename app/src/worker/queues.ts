import { PgBoss } from 'pg-boss';

/** Separate durable queues for AI, email and document work (architecture decision A11). */
export const QUEUES = {
  ai: 'ai',
  email: 'email',
  document: 'document',
  sweep: 'sweep',
} as const;

export const BOSS_SCHEMA = 'pgboss';

/**
 * Starts pg-boss and makes sure every queue exists. Retry limits, the global two-request AI
 * limit (A05) and pre-execution permission/allowance rechecks (A11) are added with the
 * features that use these queues; the library's defaults are not product policy.
 */
export async function startQueues(
  connectionString: string,
  schema: string = BOSS_SCHEMA,
  options: { supervise?: boolean; schedule?: boolean } = {},
): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema, ...options });
  boss.on('error', (err: Error) => console.error('pg-boss error:', err.message));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    // One queued and one active job at most: a tick or nudge arriving while a run is queued or active is dropped,
    // because every run looks at all the work that is due (the sweep and the outbox are the source of truth).
    if (name === QUEUES.sweep || name === QUEUES.email) await boss.createQueue(name, { policy: 'stately' });
    else await boss.createQueue(name);
  }
  return boss;
}
