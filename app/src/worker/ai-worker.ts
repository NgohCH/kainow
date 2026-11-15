import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import type { AnalysisRunner } from '../analysis/analysis-runner';
import type { AnalysisJob } from '../analysis/queue';
import type { AssistRunner } from '../assist/assist-runner';
import type { AssistJob } from '../assist/queue';
import type { ExtractionJob } from '../extraction/queue';
import { MAX_ATTEMPTS } from '../extraction/prompt';
import type { ExtractionRunner } from '../extraction/runner';
import { QUEUES } from './queues';

/** At most this many AI requests at once (A05). One worker process is assumed in the MVP. */
export const AI_CONCURRENCY = 2;

export interface AiRunners {
  extraction: ExtractionRunner;
  analysis: AnalysisRunner;
  /** AI questions, report drafts and summaries (sub-project 4b). */
  assist?: AssistRunner;
}

type AiJob = ExtractionJob | AnalysisJob | AssistJob;

const isAnalysisJob = (data: AiJob): data is AnalysisJob => typeof (data as AnalysisJob).analysisRunId === 'string';
const isAssistJob = (data: AiJob): data is AssistJob => typeof (data as AssistJob).assistRequestId === 'string';

/** Starts processing AI jobs: extraction runs, discussion analysis runs and assist requests share the queue, and so the limit. Used by the worker process and the tests. */
export async function registerAiWorker(boss: PgBoss, runners: AiRunners, pool: Pool, concurrency: number = AI_CONCURRENCY): Promise<void> {
  await boss.work<AiJob>(QUEUES.ai, { localConcurrency: concurrency, pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) {
      const attemptNo = job.retryCount + 1;
      const last = attemptNo >= MAX_ATTEMPTS;
      if (isAssistJob(job.data)) {
        await processAssist(runners, pool, job.data.assistRequestId, attemptNo, last);
        continue;
      }
      const analysis = isAnalysisJob(job.data);
      const id = isAnalysisJob(job.data) ? job.data.analysisRunId : job.data.runId;
      try {
        const outcome = isAnalysisJob(job.data) ? await runners.analysis.process(job.data.analysisRunId, attemptNo, last) : await runners.extraction.process(job.data.runId, attemptNo, last);
        // Throwing makes pg-boss retry the job after its delay; the run is already back to 'queued'.
        if (outcome === 'retry') throw new Error(`${analysis ? 'analysis' : 'extraction'} ${id} attempt ${attemptNo} failed; will retry`);
      } catch (err) {
        // A failure outside the AI call (for example the database) must not leave the run 'running' for ever,
        // because that would block any new run for the same version or thread.
        if (last) {
          if (analysis) {
            const minutes = (await pool.query(`SELECT kind FROM analysis_runs WHERE id = $1`, [id])).rows[0]?.kind === 'minutes';
            const detail = minutes ? 'The minutes drafting stopped on an unexpected error.' : 'The analysis stopped on an unexpected error.';
            await pool.query(
              `UPDATE extraction_runs SET status = 'failed', failure_code = 'internal_error',
                      failure_detail = $2, finished_at = now()
                WHERE id = (SELECT extraction_run_id FROM analysis_runs WHERE id = $1) AND status IN ('queued', 'running')`,
              [id, detail],
            );
            await pool.query(
              `UPDATE analysis_runs SET status = 'failed', failure_code = 'internal_error',
                      failure_detail = $2, finished_at = now()
                WHERE id = $1 AND status IN ('queued', 'running')`,
              [id, detail],
            );
          } else {
            await pool.query(
              `UPDATE extraction_runs SET status = 'failed', failure_code = 'internal_error',
                      failure_detail = 'The extraction stopped on an unexpected error.', finished_at = now()
                WHERE id = $1 AND status IN ('queued', 'running')`,
              [id],
            );
          }
        }
        throw err;
      }
    }
  });
}

async function processAssist(runners: AiRunners, pool: Pool, id: string, attemptNo: number, last: boolean): Promise<void> {
  try {
    if (!runners.assist) throw new Error('AI assist requests are not handled by this worker');
    const outcome = await runners.assist.process(id, attemptNo, last);
    // Throwing makes pg-boss retry the job after its delay; the request is already back to 'queued'.
    if (outcome === 'retry') throw new Error(`assist ${id} attempt ${attemptNo} failed; will retry`);
  } catch (err) {
    // A failure outside the AI call must not leave the request 'running' for ever.
    if (last) {
      await pool.query(
        `UPDATE ai_requests SET status = 'failed', failure_code = 'internal_error',
                failure_detail = 'An unexpected error stopped the AI request.', finished_at = now()
          WHERE id = $1 AND status IN ('queued', 'running')`,
        [id],
      );
    }
    throw err;
  }
}
