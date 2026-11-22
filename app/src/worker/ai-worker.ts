import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import type { AnalysisRunner } from '../analysis/analysis-runner';
import type { AnalysisJob } from '../analysis/queue';
import type { AssistRunner } from '../assist/assist-runner';
import type { AssistJob } from '../assist/queue';
import { type ExtractionJob, JOB_OPTIONS } from '../extraction/queue';
import type { ExtractionRunner, RunOutcome } from '../extraction/runner';
import { POLICY_BOUNDS } from '../ai/policy';
import type { ProtectiveCheck } from '../ops/protective';
import { QUEUES } from './queues';

/**
 * The ceiling of AI jobs at once in one process: the concurrency setting's maximum (spec 6.5). The real limit is the
 * setting itself, held in the database as AI places (ai_call_slots), so it holds across every worker process.
 */
export const AI_CONCURRENCY = POLICY_BOUNDS.concurrency[1];

/** A job that waited for a free AI place starts again after this many seconds (spec 6.5). */
export const WAIT_AGAIN_SECONDS = 30;

/** A job fetched while protective read-only mode is on is sent again to start after this many seconds (spec 7.3). */
export const PROTECTIVE_AGAIN_SECONDS = 60;

export interface AiRunners {
  extraction: ExtractionRunner;
  analysis: AnalysisRunner;
  /** AI questions, report drafts and summaries (sub-project 4b). */
  assist?: AssistRunner;
}

type AiJob = ExtractionJob | AnalysisJob | AssistJob;
type Kind = 'extraction' | 'analysis' | 'assist';

const isAnalysisJob = (data: AiJob): data is AnalysisJob => typeof (data as AnalysisJob).analysisRunId === 'string';
const isAssistJob = (data: AiJob): data is AssistJob => typeof (data as AssistJob).assistRequestId === 'string';

function kindOf(data: AiJob): { kind: Kind; id: string } {
  if (isAssistJob(data)) return { kind: 'assist', id: data.assistRequestId };
  if (isAnalysisJob(data)) return { kind: 'analysis', id: data.analysisRunId };
  return { kind: 'extraction', id: data.runId };
}

/**
 * Starts processing AI jobs: extraction runs, discussion analysis runs and assist requests share the queue. Used by the
 * worker process and the tests. Each runner counts the attempts on its request row (spec 6.6); pg-boss retries are only
 * an upper bound.
 */
export async function registerAiWorker(
  boss: PgBoss,
  runners: AiRunners,
  pool: Pool,
  concurrency: number = AI_CONCURRENCY,
  operations?: ProtectiveCheck,
): Promise<void> {
  await boss.work(QUEUES.ai, { localConcurrency: concurrency, pollingIntervalSeconds: 0.5, includeMetadata: true }, async (jobs: JobWithMetadata<AiJob>[]) => {
    for (const job of jobs) {
      if (operations && (await operations.isProtective())) await holdForLater(boss, job);
      else await handle(boss, runners, pool, job);
    }
  });
}

/**
 * Protective read-only mode (spec 7.3): the job is not run. It is sent again unchanged under the same singletonKey to
 * start a minute later, and this delivery completes, so the queue keeps it and no pg-boss retry is used up. The request
 * row is never claimed, so it stays queued with its attempts as they were. `resume` is kept exactly as this delivery
 * would have honoured it: only on a first delivery (see `run`). Chosen over `offWork`, which would need a watcher to
 * start the queue again and would stop this process noticing Resume until it restarted.
 */
async function holdForLater(boss: PgBoss, job: JobWithMetadata<AiJob>): Promise<void> {
  const { kind, id } = kindOf(job.data);
  const { resume, ...rest } = job.data;
  const data = job.retryCount === 0 && resume !== undefined ? { ...rest, resume } : rest;
  const sent = await boss.send(QUEUES.ai, data, { ...JOB_OPTIONS, singletonKey: id, priority: job.priority, startAfter: PROTECTIVE_AGAIN_SECONDS });
  if (!sent) throw new Error(`${kind} ${id}: the job queue did not accept the job held for protective mode`);
}

/**
 * Runs the job's request. `resume` is honoured only on the job's first delivery: a pg-boss retry of a resumed job follows
 * an attempt that was sent (and may hold a spend entry), so the retry counts the next attempt (final review I1).
 */
async function run(runners: AiRunners, data: AiJob, retryCount: number): Promise<RunOutcome | 'wait'> {
  const job = { resume: retryCount === 0 ? data.resume : undefined };
  if (isAssistJob(data)) {
    if (!runners.assist) throw new Error('AI assist requests are not handled by this worker');
    return runners.assist.process(data.assistRequestId, job);
  }
  if (isAnalysisJob(data)) return runners.analysis.process(data.analysisRunId, job);
  return runners.extraction.process(data.runId, job);
}

async function handle(boss: PgBoss, runners: AiRunners, pool: Pool, job: JobWithMetadata<AiJob>): Promise<void> {
  const { kind, id } = kindOf(job.data);
  // pg-boss will not try this job again after this try.
  const finalTry = job.retryCount >= job.retryLimit;
  try {
    const outcome = await run(runners, job.data, job.retryCount);
    if (outcome === 'wait') {
      // No AI place was free: the same attempt resumes later, and this job completes (spec 6.5).
      await sendAgain(boss, pool, job, kind, id, 'wait');
      return;
    }
    if (outcome === 'retry') {
      // The run is already back to 'queued'. On pg-boss's last try a throw would leave it queued for ever, so the job is
      // sent again instead; the runner ends the request when its attempts are used.
      if (finalTry) {
        await sendAgain(boss, pool, job, kind, id, 'retry');
        return;
      }
      // Throwing makes pg-boss retry the job after its delay.
      throw new Error(`${kind} ${id} attempt failed; will retry`);
    }
  } catch (err) {
    // A failure outside the AI call (for example the database) must not leave the run 'running' for ever,
    // because that would block any new run for the same version or thread.
    if (finalTry) await failUnexpected(pool, kind, id);
    throw err;
  }
}

/** The attempt number the request row holds now: the attempt a waiting job resumes. */
async function countedAttempts(pool: Pool, kind: Kind, id: string): Promise<number | undefined> {
  const table = kind === 'assist' ? 'ai_requests' : kind === 'analysis' ? 'analysis_runs' : 'extraction_runs';
  return (await pool.query<{ attempts: number }>(`SELECT attempts FROM ${table} WHERE id = $1`, [id])).rows[0]?.attempts;
}

/**
 * Sends the job again under the same singletonKey (the ai queue's standard policy accepts it while this job is still
 * active). After a wait it carries `resume`, so the claim does not count the attempt again; after a retry it does not.
 */
async function sendAgain(boss: PgBoss, pool: Pool, job: JobWithMetadata<AiJob>, kind: Kind, id: string, why: 'wait' | 'retry'): Promise<void> {
  const { resume: _old, ...data } = job.data;
  const resume = why === 'wait' ? await countedAttempts(pool, kind, id) : undefined;
  const sent = await boss.send(QUEUES.ai, resume === undefined ? data : { ...data, resume }, {
    ...JOB_OPTIONS,
    singletonKey: id,
    priority: job.priority,
    startAfter: why === 'wait' ? WAIT_AGAIN_SECONDS : JOB_OPTIONS.retryDelay,
  });
  if (!sent) throw new Error(`${kind} ${id}: the job queue did not accept the job sent again`);
}

async function failUnexpected(pool: Pool, kind: Kind, id: string): Promise<void> {
  if (kind === 'assist') {
    await pool.query(
      `UPDATE ai_requests SET status = 'failed', failure_code = 'internal_error',
              failure_detail = 'An unexpected error stopped the AI request.', finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [id],
    );
    return;
  }
  if (kind === 'analysis') {
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
    return;
  }
  await pool.query(
    `UPDATE extraction_runs SET status = 'failed', failure_code = 'internal_error',
            failure_detail = 'The extraction stopped on an unexpected error.', finished_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [id],
  );
}
