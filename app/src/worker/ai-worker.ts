import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import type { ExtractionJob } from '../extraction/queue';
import { MAX_ATTEMPTS } from '../extraction/prompt';
import type { ExtractionRunner } from '../extraction/runner';
import { QUEUES } from './queues';

/** At most this many AI requests at once (A05). One worker process is assumed in the MVP. */
export const AI_CONCURRENCY = 2;

/** Starts processing extraction jobs. Shared by the worker process and the tests. */
export async function registerAiWorker(boss: PgBoss, runner: ExtractionRunner, pool: Pool, concurrency: number = AI_CONCURRENCY): Promise<void> {
  await boss.work<ExtractionJob>(QUEUES.ai, { localConcurrency: concurrency, pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) {
      const attemptNo = job.retryCount + 1;
      const last = attemptNo >= MAX_ATTEMPTS;
      try {
        const outcome = await runner.process(job.data.runId, attemptNo, last);
        // Throwing makes pg-boss retry the job after its delay; the run is already back to 'queued'.
        if (outcome === 'retry') throw new Error(`extraction ${job.data.runId} attempt ${attemptNo} failed; will retry`);
      } catch (err) {
        // A failure outside the AI call (for example the database) must not leave the run 'running' for ever,
        // because that would block any new extraction of the same version.
        if (last) {
          await pool.query(
            `UPDATE extraction_runs SET status = 'failed', failure_code = 'internal_error',
                    failure_detail = 'The extraction stopped on an unexpected error.', finished_at = now()
              WHERE id = $1 AND status IN ('queued', 'running')`,
            [job.data.runId],
          );
        }
        throw err;
      }
    }
  });
}
