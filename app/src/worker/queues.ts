import { PgBoss } from 'pg-boss';

/** Separate durable queues for AI, email and document work (architecture decision A11). */
export const QUEUES = {
  ai: 'ai',
  email: 'email',
  document: 'document',
} as const;

export const BOSS_SCHEMA = 'pgboss';

/**
 * Starts pg-boss and makes sure every queue exists. Retry limits, the global two-request AI
 * limit (A05) and pre-execution permission/allowance rechecks (A11) are added with the
 * features that use these queues; the library's defaults are not product policy.
 */
export async function startQueues(connectionString: string, schema: string = BOSS_SCHEMA): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema });
  boss.on('error', (err: Error) => console.error('pg-boss error:', err.message));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name);
  }
  return boss;
}
