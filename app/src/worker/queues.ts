import { PgBoss } from 'pg-boss';

/** Separate durable queues for AI, email and document work (architecture decision A11). */
export const QUEUES = {
  ai: 'ai',
  email: 'email',
  document: 'document',
  sweep: 'sweep',
  analysis: 'analysis',
  /** Cleans quarantine cases reported while the protected key was missing (history spec 7.3). */
  quarantine: 'quarantine.clean-waiting',
  /** Storage side effects: filing, source files, sharing, checks, relocation, holds (external outputs spec 5.6). */
  storage: 'storage',
  /** The one-minute tick that sends storage outbox rows. */
  storageOutbox: 'storage.outbox',
  /** The daily storage tick at 02:30 UTC+8 (checks and sharing reconciliation). */
  storageDaily: 'storage.daily',
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
    // 'stately' (one queued and one active job per key) keeps duplicate ticks from piling up on a new queue. It is
    // only applied when the queue is first created: pg-boss cannot change the policy of an existing queue, so this
    // is not what prevents overlapping runs (see registerSchedules).
    // The storage queue is 'stately' too: one queued and one running job per kind and subject, never two at once.
    if (
      name === QUEUES.sweep || name === QUEUES.email || name === QUEUES.quarantine ||
      name === QUEUES.storage || name === QUEUES.storageOutbox || name === QUEUES.storageDaily
    ) await boss.createQueue(name, { policy: 'stately' });
    else await boss.createQueue(name);
  }
  return boss;
}
