import type { Pool, PoolClient } from 'pg';
import type { ProjectStatus } from '../projects/matrix';
import { ROLLING_WINDOW_MINUTES, type ThreadFacts } from './state';

type Db = Pool | PoolClient;

export interface LoadedFacts {
  threadId: string;
  projectId: string;
  /** The "analysed up to" message number (0 when nothing has been analysed). */
  cursor: number;
  facts: ThreadFacts;
}

/**
 * Facts for threads in one set-based query. Cursors (spec 7.2): a discussion's is the highest covers_through_no of its succeeded
 * proposals runs that are not selection runs; a meeting's is the newest draft's covers_through_no. Unanalysed messages are visible
 * ones above the cursor, so the newest of them is also the newest visible message of the thread.
 *
 * With a thread id: that thread, whatever its state. Without: every thread that may hold unanalysed messages, found from the
 * cheap `next_message_no - 1 > cursor` test before any message row is read. Every probe is an index probe:
 * analysis_runs_thread_idx, analysis_runs_one_active_per_thread, minutes_drafts (thread_id, version_no) and
 * discussion_messages (thread_id, message_no).
 */
export async function loadThreadFacts(db: Db, now: Date, threadId?: string): Promise<LoadedFacts[]> {
  const { rows } = await db.query(
    `SELECT b.id, b.project_id AS "projectId", b.cursor, b.kind, b.state AS "meetingState", b.project_status AS "projectStatus",
            u.n AS "unanalysedCount", u.newest AS "newestVisibleAt",
            (SELECT r.status FROM analysis_runs r WHERE r.thread_id = b.id AND r.status IN ('queued', 'running')) AS "activeRun",
            COALESCE((SELECT array_agg(r.created_at ORDER BY r.created_at) FROM analysis_runs r
                       WHERE r.thread_id = b.id AND r.trigger = 'quiet_period'
                         AND r.created_at > $2::timestamptz - make_interval(mins => $3)), '{}') AS "recentAutoStarts",
            (SELECT CASE WHEN r.status IN ('failed', 'blocked') THEN r.created_at END
               FROM analysis_runs r WHERE r.thread_id = b.id AND r.trigger = 'quiet_period' ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS "lastAutoFailedAt",
            EXISTS (SELECT 1 FROM analysis_runs r WHERE r.thread_id = b.id AND r.trigger = 'meeting_end' AND b.ended_at IS NOT NULL AND r.created_at >= b.ended_at) AS "finalDraftRequested",
            EXISTS (SELECT 1 FROM minutes_drafts d WHERE d.thread_id = b.id AND d.origin = 'human') AS "hasHumanDraft",
            (SELECT max(r.finished_at) FROM analysis_runs r WHERE r.thread_id = b.id AND r.status = 'succeeded' AND r.trigger <> 'selection') AS "lastAnalysedAt",
            (SELECT CASE WHEN r.status IN ('failed', 'blocked') THEN COALESCE(r.failure_detail, r.failure_code) END
               FROM analysis_runs r WHERE r.thread_id = b.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS "lastFailure"
       FROM (
         SELECT t.id, t.project_id, t.kind, t.state, t.ended_at, t.next_message_no, p.status AS project_status,
                CASE WHEN t.kind = 'discussion'
                     THEN COALESCE((SELECT max(r.covers_through_no) FROM analysis_runs r
                                     WHERE r.thread_id = t.id AND r.kind = 'proposals' AND r.status = 'succeeded' AND r.trigger <> 'selection'), 0)
                     ELSE COALESCE((SELECT d.covers_through_no FROM minutes_drafts d WHERE d.thread_id = t.id ORDER BY d.version_no DESC LIMIT 1), 0)
                END AS cursor
           FROM discussion_threads t JOIN projects p ON p.id = t.project_id
          WHERE ($1::uuid IS NULL AND t.held_case_id IS NULL) OR t.id = $1
       ) b
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS n, max(m.created_at) AS newest FROM discussion_messages m
          WHERE m.thread_id = b.id AND m.state = 'visible' AND m.held_case_id IS NULL AND m.message_no > b.cursor
       ) u
      WHERE $1::uuid IS NOT NULL OR (b.next_message_no - 1 > b.cursor AND u.n > 0)
      ORDER BY b.id`,
    [threadId ?? null, now, ROLLING_WINDOW_MINUTES],
  );
  return rows.map((r) => ({
    threadId: r.id as string,
    projectId: r.projectId as string,
    cursor: r.cursor as number,
    facts: {
      kind: r.kind,
      projectStatus: r.projectStatus as ProjectStatus,
      meetingState: r.meetingState,
      newestVisibleAt: r.newestVisibleAt,
      unanalysedCount: r.unanalysedCount,
      activeRun: r.activeRun,
      recentAutoStarts: r.recentAutoStarts as Date[],
      hasHumanDraft: r.hasHumanDraft,
      lastAnalysedAt: r.lastAnalysedAt,
      lastFailure: r.lastFailure,
      lastAutoFailedAt: r.lastAutoFailedAt,
      finalDraftRequested: r.finalDraftRequested,
    },
  }));
}
