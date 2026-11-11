import type { Pool, PoolClient } from 'pg';
import type { Clock } from '../auth/tokens';
import type { SpendService } from '../spend/spend.service';
import { loadThreadFacts } from './facts';
import type { AnalysisQueue } from './queue';
import { enqueueOrFail, insertRun, isActiveRunConflict } from './runs';
import { effectiveAnalysisSettingsMany } from './settings.service';
import { type Readiness, analysisState } from './state';

/** Fixed text: no thread, project or message content. */
export const THREAD_FAILED = 'An analysis could not be started for one thread; the other threads continue.';

/** Readiness for automatic runs (ruling R5): approved spend settings, and something left of every cap that applies. */
export async function readiness(spend: Pick<SpendService, 'summary'>): Promise<Readiness> {
  const s = await spend.summary();
  if (!s.configured) return { spendApproved: false, allowanceLeft: false };
  return { spendApproved: true, allowanceLeft: (s.monthly?.remainingMicroMyr ?? 0n) > 0n && (s.daily === null || s.daily.remainingMicroMyr > 0n) };
}

/**
 * The per-minute decision (spec 7.2). Facts for every thread with unanalysed messages come from one query and the settings of
 * their projects from two more; only threads the pure rules call due cost anything further. A due thread is re-checked under
 * its row lock before its run is inserted, and the partial unique index (one queued or running run per thread) is the last guard,
 * so two overlapping ticks, or a tick racing a button, can never start a thread twice.
 */
export class AnalysisTick {
  constructor(private readonly d: { pool: Pool; clock: Clock; queue: AnalysisQueue; spend: Pick<SpendService, 'summary'>; log?: (message: string) => void }) {}

  async run(): Promise<{ started: number }> {
    const now = this.d.clock();
    const candidates = await loadThreadFacts(this.d.pool, now);
    if (candidates.length === 0) return { started: 0 };
    const [settings, ready] = await Promise.all([
      effectiveAnalysisSettingsMany(this.d.pool, [...new Set(candidates.map((c) => c.projectId))]),
      readiness(this.d.spend),
    ]);
    let started = 0;
    for (const c of candidates) {
      const s = settings.get(c.projectId);
      if (!s || !analysisState(c.facts, s, ready, now).due) continue;
      // One thread that cannot be started must not stop the threads after it; the next tick tries it again.
      try {
        const id = await this.startOne(c.threadId, c.projectId, ready, now);
        if (id && (await enqueueOrFail(this.d.pool, this.d.queue, id, now))) started++;
      } catch {
        (this.d.log ?? ((m: string) => console.error(m)))(THREAD_FAILED);
      }
    }
    return { started };
  }

  private async startOne(threadId: string, projectId: string, ready: Readiness, now: Date): Promise<string | null> {
    const client: PoolClient = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM discussion_threads WHERE id = $1 FOR NO KEY UPDATE`, [threadId]);
      const [again] = await loadThreadFacts(client, now, threadId);
      const settings = (await effectiveAnalysisSettingsMany(client, [projectId])).get(projectId);
      if (!again || !settings || !analysisState(again.facts, settings, ready, now).due) {
        await client.query('ROLLBACK');
        return null;
      }
      const meeting = again.facts.kind === 'meeting';
      const id = await insertRun(client, {
        threadId,
        kind: meeting ? 'minutes' : 'proposals',
        trigger: 'quiet_period',
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
