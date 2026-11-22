import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { ProtectiveCheck } from '../ops/protective';
import { uuidv7 } from '../common/uuid7';
import { QUEUES } from '../worker/queues';
import { StorageWaitingForKey } from './connector-factory';
import { type StorageDeps, type StorageFailureCode, type StorageJobData, onFinalFailure, storageHandler } from './jobs';
import { STORAGE_JOB_OPTIONS, storageSingletonKey } from './outbox';
import { MAX_RETRIES, WAIT_FOR_KEY_MS, nextAttemptAt } from './retry';
import { StorageError } from './types';

/** Two at once keeps within Graph's per-app throttling at Kainow's scale (spec 5.6). */
export const STORAGE_CONCURRENCY = 2;

/** Codes that another attempt cannot fix: the subject is failed at once (spec 5.6). */
const FINAL_CODES: ReadonlySet<StorageFailureCode> = new Set(['unauthorised', 'forbidden', 'invalid', 'too_large']);

/** A job fetched while protective read-only mode is on is sent again to start after this long (ops spec 7.3). */
export const PROTECTIVE_AGAIN_MS = 60_000;

/**
 * `log` takes fixed messages only; never an error object or message. With `operations`, a job fetched while protective
 * read-only mode is on is not run (ops spec 7.3, as the AI queue): it is sent again unchanged, to start a minute later,
 * and no attempt is counted or recorded.
 */
export async function registerStorageWorker(
  boss: PgBoss,
  deps: StorageDeps,
  log: (message: string) => void = (m) => console.error(m),
  operations?: ProtectiveCheck,
): Promise<void> {
  await boss.work(
    QUEUES.storage,
    { localConcurrency: STORAGE_CONCURRENCY, pollingIntervalSeconds: 0.5, includeMetadata: true },
    async (jobs: JobWithMetadata<StorageJobData>[]) => {
      for (const job of jobs) {
        if (operations && (await operations.isProtective())) {
          await sendAgain(boss, job, job.data, new Date(Date.now() + PROTECTIVE_AGAIN_MS), log);
          continue;
        }
        await runStorageJob(boss, deps, job, log);
      }
    },
  );
}

/** Thrown when recording an attempt, re-sending or a final-failure hook fails: fixed text, so pg-boss stores no detail. */
export const BOOKKEEPING_FAILED = 'storage job bookkeeping failed';

/**
 * Runs one attempt. Success and every failure are recorded in storage_attempts (codes only). A temporary failure sends
 * the job again for its next attempt on the schedule; after the last retry, or on a code that is never retried, the
 * subject's final-failure hook marks it failed. Waiting for the protected key is not an attempt.
 */
async function runStorageJob(boss: PgBoss, deps: StorageDeps, job: JobWithMetadata<StorageJobData>, log: (message: string) => void): Promise<void> {
  const data = job.data;
  const attempt = data.attempt ?? 1;
  const started = Date.now();
  let failure: unknown;
  let failed = false;
  try {
    const handler = storageHandler(data.job);
    // No handler: a worker older than the API that queued the job. Treated like any unexpected failure.
    if (!handler) throw new Error('no handler');
    await handler(deps, data.subjectId, attempt);
  } catch (err) {
    failed = true;
    failure = err;
  }
  try {
    if (!failed) await record(deps, data, 'ok', null, started);
    else await afterFailure(boss, deps, job, failure, started, log);
  } catch {
    // pg-boss keeps a thrown error's message with the job: never let a hook's or the database's text reach it.
    log(`Recording a storage ${data.job} job attempt failed; the job will be tried again.`);
    throw new Error(BOOKKEEPING_FAILED);
  }
}

async function afterFailure(
  boss: PgBoss, deps: StorageDeps, job: JobWithMetadata<StorageJobData>, err: unknown, started: number, log: (message: string) => void,
): Promise<void> {
  const data = job.data;
  const attempt = data.attempt ?? 1;
  if (err instanceof StorageWaitingForKey) {
    await sendAgain(boss, job, data, new Date(deps.clock().getTime() + WAIT_FOR_KEY_MS), log);
    return;
  }
  const code: StorageFailureCode = err instanceof StorageError ? err.code : 'internal';
  if (code === 'internal') log(`A storage ${data.job} job failed on an unexpected error.`);
  await record(deps, data, code, err instanceof StorageError ? (err.status ?? null) : null, started);
  if (FINAL_CODES.has(code) || attempt > MAX_RETRIES) {
    await onFinalFailure(deps, data.job, data.subjectId, code);
    return;
  }
  const now = deps.clock();
  const firstFailureAt = data.firstFailureAt ? new Date(data.firstFailureAt) : now;
  const retryAfterMs = err instanceof StorageError ? err.retryAfterMs : undefined;
  await sendAgain(
    boss,
    job,
    { ...data, attempt: attempt + 1, firstFailureAt: firstFailureAt.toISOString() },
    nextAttemptAt(firstFailureAt, attempt, now, retryAfterMs),
    log,
  );
}

/**
 * Sends the job's next run under the same key and priority. If a fresher job for the same subject already holds the
 * queued slot (an outbox send while this one ran), the queue keeps that one (stately policy) and this send is dropped:
 * the fresher job starts its own attempts and rechecks the subject when it runs.
 */
async function sendAgain(
  boss: PgBoss, job: JobWithMetadata<StorageJobData>, data: StorageJobData, startAfter: Date, log: (message: string) => void,
): Promise<void> {
  const id = await boss.send(QUEUES.storage, data, {
    ...STORAGE_JOB_OPTIONS,
    singletonKey: storageSingletonKey(data.job, data.subjectId),
    priority: job.priority,
    startAfter,
  });
  if (!id) log(`A newer storage ${data.job} job for the same subject is already queued; it replaces this retry.`);
}

async function record(deps: StorageDeps, data: StorageJobData, outcome: 'ok' | StorageFailureCode, status: number | null, started: number): Promise<void> {
  await deps.pool.query(
    `INSERT INTO storage_attempts (id, job, subject_id, outcome, provider_status, duration_ms, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [uuidv7(), data.job, data.subjectId, outcome, status, Math.max(0, Date.now() - started), deps.clock()],
  );
}
