import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import type { AnalysisQueue } from './queue';

type Db = Pool | PoolClient;

export interface NewRun {
  threadId: string;
  kind: 'proposals' | 'minutes';
  trigger: 'quiet_period' | 'meeting_end' | 'button' | 'selection';
  requestedBy: string | null;
  coversFromNo: number;
  /** Null: the newest visible message at the moment of insertion. */
  coversThroughNo: number | null;
  selectedMessageIds?: string[];
  at: Date;
}

/**
 * Inserts a queued run. The partial unique index (one queued or running run per thread) raises 23505 when the thread already
 * has one; callers catch it with `isActiveRunConflict` and skip. The job that builds the input re-reads the messages when it
 * starts (spec 7.2), so `covers_through_no` here only records what the request saw.
 */
export async function insertRun(db: Db, run: NewRun): Promise<string> {
  const id = uuidv7(run.at.getTime());
  await db.query(
    `INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, covers_from_no, covers_through_no, selected_message_ids, created_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6, COALESCE($7, (SELECT COALESCE(max(message_no), 0) FROM discussion_messages WHERE thread_id = $2 AND state = 'visible')), $8, $9)`,
    [id, run.threadId, run.kind, run.trigger, run.requestedBy, run.coversFromNo, run.coversThroughNo, run.selectedMessageIds ?? null, run.at],
  );
  return id;
}

export const isActiveRunConflict = (err: unknown): boolean => (err as { code?: string } | null)?.code === '23505';

/**
 * Hands a committed run to the worker. If the queue refuses, the run is marked failed at once: a run left 'queued' without a
 * job would hold the thread's only active slot for ever. Returns whether the job was accepted.
 */
export async function enqueueOrFail(pool: Pool, queue: AnalysisQueue, runId: string, at: Date, explicit = false): Promise<boolean> {
  try {
    await queue.enqueue(runId, { explicit });
    return true;
  } catch {
    await pool.query(
      `UPDATE analysis_runs SET status = 'failed', failure_code = 'queue_unavailable',
              failure_detail = 'The analysis could not be queued; try again.', finished_at = $2
        WHERE id = $1 AND status = 'queued'`,
      [runId, at],
    );
    return false;
  }
}
