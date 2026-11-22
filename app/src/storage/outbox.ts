import type { Pool, PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import { uuidv7 } from '../common/uuid7';
import { QUEUES } from '../worker/queues';
import type { StorageJob, StorageJobData } from './jobs';

/** pg-boss runs a higher priority first: revocations and narrowing moves go ahead of grants and filing (spec 5.5). */
export const URGENT_PRIORITY = 10;
export const NORMAL_PRIORITY = 0;

/**
 * pg-boss options for every storage job. The retry schedule is not pg-boss's: the worker sends the job again with its own
 * start time (spec 5.6). pg-boss's retries only cover the worker itself failing (it died, or the database went away
 * while an attempt was recorded); they run the same attempt again.
 *
 * Delivery is at least once: an attempt can run again after a crash, a lost heartbeat or a failed record. Every handler
 * must be idempotent and recheck the subject's state before acting (A11).
 */
export const STORAGE_JOB_OPTIONS = {
  retryLimit: 4,
  retryDelay: 60,
  // A dead worker stops its heartbeat, and pg-boss retries the job within a minute or two.
  heartbeatSeconds: 60,
  // Bounds a live attempt only (a large upload at up to 120 seconds a chunk, or a relocation copy); the heartbeat, not
  // this, catches a dead worker.
  expireInSeconds: 3600,
} as const;

/** One storage job per kind and subject at a time: the queue's 'stately' policy keeps one queued and one running per key. */
export const storageSingletonKey = (job: StorageJob, subjectId: string): string => `${job}:${subjectId}`;

/**
 * Queues storage work inside the caller's transaction (spec 5.6): the job is sent only if the change commits, and the
 * one-minute outbox tick sends it even if no one nudges.
 */
export async function queueStorageJob(
  c: PoolClient,
  job: StorageJob,
  subjectId: string,
  opts?: { priority?: 'urgent' | 'normal' },
): Promise<void> {
  await c.query(`INSERT INTO storage_outbox (id, job, subject_id, urgent, created_at) VALUES ($1, $2, $3, $4, now())`, [
    uuidv7(),
    job,
    subjectId,
    opts?.priority === 'urgent',
  ]);
}

const BATCH = 100;

/**
 * Sends every unsent outbox row as a storage job and marks it sent; urgent rows first. A row ended by a restore
 * (`ended_at`, ops/after-restore.ts) is never sent. Rows are claimed with SKIP LOCKED,
 * so two ticks at once send each row once. A row whose key already has a queued job refreshes that job instead
 * (`sendOrRefresh`). Returns how many rows were sent.
 */
export async function sendStorageOutbox(pool: Pool, boss: PgBoss): Promise<number> {
  let total = 0;
  for (;;) {
    const c = await pool.connect();
    let claimed = 0;
    try {
      await c.query('BEGIN');
      const { rows } = await c.query<{ id: string; job: StorageJob; subject_id: string; urgent: boolean }>(
        `SELECT id, job, subject_id, urgent FROM storage_outbox
          WHERE sent_at IS NULL AND ended_at IS NULL
          ORDER BY urgent DESC, created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH],
      );
      for (const r of rows) {
        await sendOrRefresh(boss, { job: r.job, subjectId: r.subject_id }, r.urgent ? URGENT_PRIORITY : NORMAL_PRIORITY);
      }
      if (rows.length > 0) await c.query(`UPDATE storage_outbox SET sent_at = now() WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
      await c.query('COMMIT');
      claimed = rows.length;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    total += claimed;
    if (claimed < BATCH) return total;
  }
}

/**
 * Sends a fresh job for a change. Under the queue's stately policy a key holds one queued job and one running one, so if
 * a job is already queued for the key (for example a retry 30 minutes out, or the last retry), the send is refused; that
 * queued job is then refreshed to stand for the change: due now, at the higher of the two priorities, and with a fresh
 * attempt budget (data back to `{ job, subjectId }`). If the only job for the key is running, the send queues normally.
 */
export async function sendOrRefresh(boss: PgBoss, data: { job: StorageJob; subjectId: string }, priority: number): Promise<'sent' | 'refreshed'> {
  const singletonKey = storageSingletonKey(data.job, data.subjectId);
  const fresh: StorageJobData = { job: data.job, subjectId: data.subjectId };
  // The queued job may start running between the refused send and the refresh; then the queued slot is free, so try again.
  for (let i = 0; i < 3; i++) {
    if (await boss.send(QUEUES.storage, fresh, { ...STORAGE_JOB_OPTIONS, singletonKey, priority })) return 'sent';
    const queued = await boss.findJobs<StorageJobData>(QUEUES.storage, { key: singletonKey, queued: true });
    if (queued.length === 0) continue;
    const top = Math.max(priority, ...queued.map((j) => j.priority));
    const r = await boss.update(QUEUES.storage, fresh, { singletonKey, priority: top, startAfter: new Date(), match: 'all' });
    if (r.updated > 0) return 'refreshed';
  }
  throw new Error('The storage queue did not accept the job.');
}
