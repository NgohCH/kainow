import type { Pool, PoolClient } from 'pg';
import { loadCandidatesForProjects } from '../ai/chooser';
import type { ProtectedKey } from '../quarantine/protected-key';
import { projectAllowancesMany } from '../spend/spend.service';
import type { Clock } from '../auth/tokens';
import { markStaleReservations } from '../ai/guarded-call';
import type { SpendService } from '../spend/spend.service';
import { loadThreadFacts } from './facts';
import type { AnalysisQueue } from './queue';
import { BOSS_SCHEMA, QUEUES } from '../worker/queues';
import { enqueueOrFail, insertRun, isActiveRunConflict } from './runs';
import { effectiveAnalysisSettingsMany } from './settings.service';
import { type Readiness, analysisState } from './state';

type Db = Pool | PoolClient;

/** Fixed text: no thread, project or message content. */
export const THREAD_FAILED = 'An analysis could not be started for one thread; the other threads continue.';

export const STALLED_MINUTES = 45;
export const STALLED_DETAIL = 'This analysis stopped without finishing; ask again.';
export const ASSIST_STALLED_DETAIL = 'The AI request stopped without finishing.';
/** Above any real attempt number: every reservation still open on a stalled request is stale. */
const ALL_ATTEMPTS = 2147483647;

/** Readiness for automatic runs (ruling R5): approved spend settings, and something left of every cap that applies. */
export async function readiness(spend: Pick<SpendService, 'summary'>): Promise<Readiness> {
  const s = await spend.summary();
  if (!s.configured) return { spendApproved: false, allowanceLeft: false };
  return { spendApproved: true, allowanceLeft: (s.monthly?.remainingMicroMyr ?? 0n) > 0n && (s.daily === null || s.daily.remainingMicroMyr > 0n) };
}

/**
 * Per-project readiness for automatic runs (spec 6.1) for all the projects the tick considers at once: one query for their
 * connections (the chooser's own eligibility for discussion_analysis, restriction ignored) and one for their limits and spend.
 * The organisation's own checks stay in readiness(). Writes nothing: no run row and no audit row. With no protected key
 * (keyId null) no query is needed: every project is blocked protected_key_missing.
 */
export async function readinessMany(db: Db, projectIds: string[], at: Date, keyId: string | null): Promise<Map<string, Readiness>> {
  const out = new Map<string, Readiness>();
  const ok = { spendApproved: true, allowanceLeft: true };
  if (projectIds.length === 0) return out;
  if (keyId === null) {
    for (const id of projectIds) out.set(id, { ...ok, blockedReason: 'protected_key_missing' });
    return out;
  }
  const [candidates, allowances] = await Promise.all([
    loadCandidatesForProjects(db, projectIds, 'discussion_analysis', false, keyId),
    projectAllowancesMany(db, projectIds, at),
  ]);
  for (const id of projectIds) {
    const list = candidates.get(id) ?? [];
    const allowance = allowances.get(id);
    if (list.length === 0) out.set(id, { ...ok, blockedReason: 'ai_not_set_up' });
    else if (!list.some((c) => c.eligible)) out.set(id, { ...ok, blockedReason: 'no_eligible_connection' });
    else if (allowance !== 'ok' && allowance !== 'used') out.set(id, { ...ok, blockedReason: 'project_no_allowance' });
    else if (allowance === 'used') out.set(id, { ...ok, blockedReason: 'project_allowance_used' });
    else out.set(id, { ...ok });
  }
  return out;
}

/**
 * The per-minute decision (spec 7.2). Facts for every thread with unanalysed messages come from one query and the settings of
 * their projects from two more; only threads the pure rules call due cost anything further. A due thread is re-checked under
 * its row lock before its run is inserted, and the partial unique index (one queued or running run per thread) is the last guard,
 * so two overlapping ticks, or a tick racing a button, can never start a thread twice.
 */
export class AnalysisTick {
  constructor(private readonly d: { pool: Pool; clock: Clock; queue: AnalysisQueue; spend: Pick<SpendService, 'summary' | 'markUncertain'>; key: ProtectedKey | null; log?: (message: string) => void }) {}

  async run(): Promise<{ started: number }> {
    const now = this.d.clock();
    await this.failStalled(now);
    const candidates = await loadThreadFacts(this.d.pool, now);
    if (candidates.length === 0) return { started: 0 };
    const projectIds = [...new Set(candidates.map((c) => c.projectId))];
    const [settings, org, perProject] = await Promise.all([
      effectiveAnalysisSettingsMany(this.d.pool, projectIds),
      readiness(this.d.spend),
      readinessMany(this.d.pool, projectIds, now, this.d.key?.id ?? null),
    ]);
    const readyOf = (projectId: string): Readiness => ({ ...org, blockedReason: perProject.get(projectId)?.blockedReason });
    let started = 0;
    for (const c of candidates) {
      const s = settings.get(c.projectId);
      if (!s || !analysisState(c.facts, s, readyOf(c.projectId), now).due) continue;
      // One thread that cannot be started must not stop the threads after it; the next tick tries it again.
      try {
        const id = await this.startOne(c.threadId, c.projectId, readyOf(c.projectId), now);
        if (id && (await enqueueOrFail(this.d.pool, this.d.queue, id, now))) started++;
      } catch {
        (this.d.log ?? ((m: string) => console.error(m)))(THREAD_FAILED);
      }
    }
    return { started };
  }

  /**
   * A run that has been queued or running for more than STALLED_MINUTES never finished (a lost job or a dead worker); it is
   * marked failed so the thread's one active slot is freed, and so is its extraction run if that is still waiting. One set-based pass,
   * then the same for AI assist requests, so the Ask panel and Drafts stop waiting and Re-answer or Regenerate are allowed again.
   */
  private async failStalled(now: Date): Promise<void> {
    // A run that still has a live job (waiting in the queue, retrying or being worked) is never stalled, however old: the queue may
    // simply be busy. Without a pg-boss schema (no queue has ever started) there is no job to find.
    const hasJobs = (await this.d.pool.query(`SELECT to_regclass('${BOSS_SCHEMA}.job') IS NOT NULL AS ok`)).rows[0].ok as boolean;
    const noLiveJob = hasJobs
      ? `AND NOT EXISTS (SELECT 1 FROM ${BOSS_SCHEMA}.job j WHERE j.name = '${QUEUES.ai}' AND j.singleton_key = analysis_runs.id::text AND j.state IN ('created', 'retry', 'active'))`
      : '';
    await this.d.pool.query(
      `WITH stalled AS (
         UPDATE analysis_runs SET status = 'failed', failure_code = 'stalled', failure_detail = $2, finished_at = $1
          WHERE status IN ('queued', 'running') AND created_at < $1::timestamptz - make_interval(mins => $3) ${noLiveJob}
          RETURNING extraction_run_id
       )
       UPDATE extraction_runs SET status = 'failed', failure_code = 'stalled', failure_detail = $2, finished_at = $1
        WHERE status IN ('queued', 'running') AND id IN (SELECT extraction_run_id FROM stalled WHERE extraction_run_id IS NOT NULL)`,
      [now, STALLED_DETAIL, STALLED_MINUTES],
    );
    // AI assist requests (questions, report drafts, summaries) share the queue and the same rule. A stalled request's open
    // reservation may have reached the provider, so it stays counted as uncertain.
    const noLiveAssistJob = hasJobs
      ? `AND NOT EXISTS (SELECT 1 FROM ${BOSS_SCHEMA}.job j WHERE j.name = '${QUEUES.ai}' AND j.singleton_key = ai_requests.id::text AND j.state IN ('created', 'retry', 'active'))`
      : '';
    const stalled = await this.d.pool.query<{ id: string }>(
      `UPDATE ai_requests SET status = 'failed', failure_code = 'stalled', failure_detail = $2, finished_at = $1
        WHERE status IN ('queued', 'running') AND created_at < $1::timestamptz - make_interval(mins => $3) ${noLiveAssistJob}
        RETURNING id`,
      [now, ASSIST_STALLED_DETAIL, STALLED_MINUTES],
    );
    for (const { id } of stalled.rows) {
      await markStaleReservations(this.d.pool, this.d.spend, id, ALL_ATTEMPTS);
    }
  }

  private async startOne(threadId: string, projectId: string, ready: Readiness, now: Date): Promise<string | null> {
    const client: PoolClient = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM discussion_threads WHERE id = $1 FOR NO KEY UPDATE`, [threadId]);
      const [again] = await loadThreadFacts(client, now, threadId);
      const settings = (await effectiveAnalysisSettingsMany(client, [projectId])).get(projectId);
      const decision = again && settings ? analysisState(again.facts, settings, ready, now) : null;
      if (!again || !decision || !decision.due) {
        await client.query('ROLLBACK');
        return null;
      }
      const meeting = again.facts.kind === 'meeting';
      const id = await insertRun(client, {
        threadId,
        kind: meeting ? 'minutes' : 'proposals',
        trigger: decision.trigger ?? 'quiet_period',
        requestedBy: null,
        coversFromNo: meeting ? 1 : again.cursor + 1,
        coversThroughNo: null,
        at: now,
      });
      await client.query('COMMIT');
      return id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isActiveRunConflict(err)) return null;
      throw err;
    } finally {
      client.release();
    }
  }
}
