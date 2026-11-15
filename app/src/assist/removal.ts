import type { PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';

type Db = Pick<PoolClient, 'query'>;

/** Why material stopped being readable (spec 5.5, 7.3). Kept in the event detail as `cause`; never any text. */
export type RemovalReason = 'hidden' | 'deleted' | 'audience_tightened' | 'summary_withdrawn';

/** What was removed: messages hidden or deleted, sources deleted or withdrawn, or an audience that narrowed. */
export interface RemovedMaterial {
  messageIds?: string[];
  sourceIds?: string[];
  audienceId?: string;
}

/** The review_reason stored on every answer or draft this hook moves (spec 5.5). */
export const MATERIAL_REMOVED = 'material_removed';

/**
 * The requests that sent the removed material: passages of any version of those messages or sources (an edited
 * version that was sent is still the same content), passages owned by a source or thread using that audience, and
 * records (pending proposals) sent with that audience. Material dropped at start was never sent, so it does not
 * count; a request still queued has dropped nothing yet, so all its material counts.
 *
 * Runs under the caller's thread, message or audience lock, so it stays on indexes: the touched passage ids are found
 * first from the owners (message_versions (message_id, version_no), source_versions (source_id, version_no),
 * sources/discussion_threads by audience_id, passages (owner_kind, owner_id, ordinal)), then the material rows by
 * ai_request_material_passage_idx; records by the audience's project (ai_requests_project_idx, then the material key).
 */
async function touchedRequests(db: Db, what: RemovedMaterial): Promise<string[]> {
  const messageIds = what.messageIds ?? [];
  const sourceIds = what.sourceIds ?? [];
  const audienceId = what.audienceId ?? null;
  if (messageIds.length === 0 && sourceIds.length === 0 && audienceId === null) return [];
  const passageIds = (
    await db.query<{ id: string }>(
      `WITH owners (kind, id) AS (
         SELECT 'message_version', mv.id FROM message_versions mv WHERE mv.message_id = ANY($1::uuid[])
         UNION ALL
         SELECT 'source_version', sv.id FROM source_versions sv WHERE sv.source_id = ANY($2::uuid[])
         UNION ALL
         SELECT 'source_version', sv.id
           FROM audiences au JOIN sources s ON s.audience_id = au.id AND s.project_id = au.project_id
           JOIN source_versions sv ON sv.source_id = s.id
          WHERE au.id = $3::uuid
         UNION ALL
         SELECT 'message_version', mv.id
           FROM audiences au JOIN discussion_threads th ON th.audience_id = au.id AND th.project_id = au.project_id
           JOIN discussion_messages dm ON dm.thread_id = th.id
           JOIN message_versions mv ON mv.message_id = dm.id
          WHERE au.id = $3::uuid
       )
       SELECT p.id FROM owners o JOIN passages p ON p.owner_kind = o.kind AND p.owner_id = o.id`,
      [messageIds, sourceIds, audienceId],
    )
  ).rows.map((r) => r.id);
  const { rows } = await db.query<{ id: string }>(
    `SELECT m.request_id AS id FROM ai_request_material m
      WHERE m.passage_id = ANY($1::uuid[]) AND NOT m.dropped_at_start
     UNION
     SELECT m.request_id FROM audiences au
       JOIN ai_requests r ON r.project_id = au.project_id
       JOIN ai_request_material m ON m.request_id = r.id
      WHERE au.id = $2::uuid AND m.record_audience_id = au.id AND NOT m.dropped_at_start
     ORDER BY 1`,
    [passageIds, audienceId],
  );
  return rows.map((r) => r.id);
}

/**
 * The removal hook (spec 5.5, 6.3), run in the same transaction as the moderation, deletion or audience change.
 * Every answer or draft built on the removed material that is not already in review or withdrawn moves:
 *   - a private answer, or an unshared draft, is withdrawn (it disappears entirely, even for its requester);
 *   - a shared answer or shared draft goes to review_required (PM and Deputy only, until Clear or Withdraw).
 * An answer still being worked on is private, so it is withdrawn now; when the worker finishes it writes the text
 * but never shares or shows a withdrawn answer (completeQuestion shares only from review_state 'none').
 * A cleared answer touched again goes back to review; nothing is ever brought back by this hook.
 *
 * Locks: the caller may hold thread, message or audience rows. Answer rows are locked here in request id order,
 * then draft rows in id order, so two removals cannot deadlock with each other. Everything else that locks an
 * answer together with a thread takes the thread first (share, re-answer, the worker's completion).
 *
 * Summaries (spec 7.3) are added by sub-project 4b Task 10; 'summary_withdrawn' is accepted already.
 */
export async function onMaterialRemoved(
  db: PoolClient,
  what: RemovedMaterial,
  reason: RemovalReason,
  at: Date,
): Promise<{ withdrawn: number; review: number }> {
  const requestIds = await touchedRequests(db, what);
  if (requestIds.length === 0) return { withdrawn: 0, review: 0 };
  let withdrawn = 0;
  let review = 0;
  const event = (projectId: string, action: 'withdrawn' | 'review_required', targetKind: 'answer' | 'report_draft', targetId: string, detail: Record<string, unknown>) =>
    db.query(
      `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, detail, at) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(at.getTime()), projectId, action, targetKind, targetId, MATERIAL_REMOVED, { cause: reason, ...detail }, at],
    );

  const answers = (
    await db.query<{ id: string; projectId: string; visibility: 'private' | 'shared'; threadId: string | null }>(
      `SELECT request_id AS id, project_id AS "projectId", visibility, shared_thread_id AS "threadId"
         FROM ai_answers WHERE request_id = ANY($1::uuid[]) AND review_state IN ('none', 'cleared')
        ORDER BY request_id FOR UPDATE`,
      [requestIds],
    )
  ).rows;
  for (const a of answers) {
    const to = a.visibility === 'private' ? 'withdrawn' : 'review_required';
    await db.query(`UPDATE ai_answers SET review_state = $2, review_reason = $3, reviewed_by = NULL, reviewed_at = NULL WHERE request_id = $1`, [
      a.id,
      to,
      MATERIAL_REMOVED,
    ]);
    await event(a.projectId, to, 'answer', a.id, a.threadId ? { threadId: a.threadId } : {});
    if (to === 'withdrawn') withdrawn++;
    else review++;
  }

  // A draft is built on the material of every one of its AI versions' requests (spec 6.3), and is about to be built on
  // the material of a request still queued or running for it (a first draft or a Regenerate), which has no version yet:
  // that request is linked to its draft by its draft_requested event, written at the request's own time (found through
  // ai_assist_events_project_idx). The runner then blocks the request (reportRemoved) and nothing is charged.
  const drafts = (
    await db.query<{ id: string; projectId: string; shared: boolean }>(
      `WITH linked (id) AS (
         SELECT v.draft_id FROM report_draft_versions v WHERE v.origin = 'ai' AND v.request_id = ANY($1::uuid[])
         UNION
         SELECT e.target_id
           FROM ai_requests r
           JOIN ai_assist_events e ON e.project_id = r.project_id AND e.at = r.created_at
                                  AND e.action = 'draft_requested' AND e.target_kind = 'report_draft' AND e.detail->>'requestId' = r.id::text
          WHERE r.id = ANY($1::uuid[]) AND r.kind = 'report' AND r.status IN ('queued', 'running')
       )
       SELECT d.id, d.project_id AS "projectId", d.shared
         FROM report_drafts d JOIN linked l ON l.id = d.id
        WHERE d.review_state IN ('none', 'cleared')
        ORDER BY d.id FOR UPDATE OF d`,
      [requestIds],
    )
  ).rows;
  for (const d of drafts) {
    const to = d.shared ? 'review_required' : 'withdrawn';
    await db.query(`UPDATE report_drafts SET review_state = $2, review_reason = $3, reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`, [
      d.id,
      to,
      MATERIAL_REMOVED,
    ]);
    await event(d.projectId, to, 'report_draft', d.id, {});
    if (to === 'withdrawn') withdrawn++;
    else review++;
  }
  return { withdrawn, review };
}
