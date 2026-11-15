import type { PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { type MembershipRow, effectiveRoles, todayUtc8 } from '../projects/membership';

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

/** Why a summary needs an access review (spec 7.3), stored as summaries.review_reason and as the event reason. */
export type SummaryReviewCause = 'audience_tightened' | 'message_hidden' | 'message_deleted' | 'original_deleted' | 'original_removed';

export const SUMMARY_REVIEW_LABEL = 'Access review required';

/** The plain words shown with Access review required (to PM, Owner and Sponsor only). */
export const SUMMARY_REVIEW_REASONS: Readonly<Record<SummaryReviewCause, string>> = {
  audience_tightened: "The original's audience was narrowed.",
  message_hidden: 'A message of the summarised meeting was hidden.',
  message_deleted: 'A message of the summarised meeting was deleted.',
  original_deleted: 'The original was deleted.',
  original_removed: 'The original is no longer available.',
};

/** Everyone holding PM, Owner or Sponsor in the project today (spec 7.4), as askApproval finds them. */
async function reviewers(db: Db, projectId: string, at: Date): Promise<string[]> {
  const { rows } = await db.query<MembershipRow>(
    `SELECT m.user_id AS "userId", m.role, to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn",
            m.revoked_at AS "revokedAt", m.held_at AS "heldAt", m.restored_at AS "restoredAt"
       FROM memberships m WHERE m.project_id = $1 AND m.role IN ('pm', 'owner', 'sponsor')`,
    [projectId],
  );
  const today = todayUtc8(at);
  return [...new Set(rows.map((r) => r.userId))].filter((id) => effectiveRoles(rows, id, today).length > 0).sort();
}

/**
 * The summaries part of the hook (spec 7.3). Summaries of the removed material's originals move:
 *   - the original's audience narrowed: an approved summary goes to `review_required` (it stays visible to its own
 *     audience, and its dependent answers and drafts are untouched);
 *   - a message of the summarised meeting hidden or deleted, when it was posted by the time the approved version was
 *     written (so it may be in that text), or the original source removed: an approved or review_required summary
 *     becomes `hidden`, seen only by the original's audience until Confirm or Withdraw.
 * Each move is recorded (no actor, no text) and PM, Owner and Sponsors are told in-app with the summary's own title.
 * Returns the summary sources that became hidden: their dependent answers and drafts are removed material.
 *
 * Candidates are found without a state filter; the state (and, for a message, whether it was posted by the time
 * the approved version was written) is decided only after the summary row is locked, by statements that run after
 * the lock is granted, so a Confirm or Approve committing meanwhile is seen and the move is not lost.
 *
 * Locks: after the caller's thread, message or audience rows; summary rows in id order, before any answer or draft.
 */
async function moveSummaries(db: Db, what: RemovedMaterial, reason: RemovalReason, at: Date): Promise<string[]> {
  const messageIds = what.messageIds ?? [];
  const sourceIds = what.sourceIds ?? [];
  const audienceId = what.audienceId ?? null;
  // A summary source is never itself summarised, so a withdrawn summary moves no other summary.
  if (reason === 'summary_withdrawn') return [];
  const causes = new Map<string, SummaryReviewCause>();
  if (audienceId !== null) {
    // The originals using that audience (sources_audience / threads by audience), then summaries_source_idx / summaries_thread_idx.
    const { rows } = await db.query<{ id: string }>(
      `SELECT sm.id FROM sources s JOIN summaries sm ON sm.original_source_id = s.id WHERE s.audience_id = $1
       UNION
       SELECT sm.id FROM discussion_threads t JOIN summaries sm ON sm.original_thread_id = t.id WHERE t.audience_id = $1`,
      [audienceId],
    );
    for (const r of rows) causes.set(r.id, 'audience_tightened');
  }
  if (messageIds.length > 0) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT DISTINCT sm.id FROM discussion_messages m JOIN summaries sm ON sm.original_thread_id = m.thread_id WHERE m.id = ANY($1::uuid[])`,
      [messageIds],
    );
    for (const r of rows) causes.set(r.id, reason === 'deleted' ? 'message_deleted' : 'message_hidden');
  }
  if (sourceIds.length > 0) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT sm.id FROM summaries sm WHERE sm.original_source_id = ANY($1::uuid[])`,
      [sourceIds],
    );
    for (const r of rows) causes.set(r.id, reason === 'deleted' ? 'original_deleted' : 'original_removed');
  }
  if (causes.size === 0) return [];
  const locked = (
    await db.query<{ id: string; projectId: string; state: string; sourceId: string | null; title: string | null }>(
      `SELECT sm.id, sm.project_id AS "projectId", sm.state, sm.summary_source_id AS "sourceId",
              (SELECT s.title FROM sources s WHERE s.id = sm.summary_source_id) AS title
         FROM summaries sm WHERE sm.id = ANY($1::uuid[]) AND sm.state IN ('approved', 'review_required')
        ORDER BY sm.id FOR UPDATE OF sm`,
      [[...causes.keys()]],
    )
  ).rows;
  const hidden: string[] = [];
  for (const sm of locked) {
    const cause = causes.get(sm.id) as SummaryReviewCause;
    const to = cause === 'audience_tightened' ? 'review_required' : 'hidden';
    // Tightening moves only an approved summary: never one already in review or hidden.
    if (to === 'review_required' && sm.state !== 'approved') continue;
    // A message counts only if it was posted by the time the approved version (as it is now, after the lock) was written.
    if (cause === 'message_hidden' || cause === 'message_deleted') {
      const inText = await db.query(
        `SELECT 1 FROM summaries sm JOIN summary_versions av ON av.id = sm.approved_version_id
           JOIN discussion_messages m ON m.thread_id = sm.original_thread_id
          WHERE sm.id = $1 AND m.id = ANY($2::uuid[]) AND m.created_at <= av.created_at LIMIT 1`,
        [sm.id, messageIds],
      );
      if (!inText.rowCount) continue;
    }
    await db.query(`UPDATE summaries SET state = $2, review_reason = $3 WHERE id = $1`, [sm.id, to, cause]);
    await db.query(
      `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, detail, at) VALUES ($1, $2, NULL, $3, 'summary', $4, $5, $6, $7)`,
      [uuidv7(at.getTime()), sm.projectId, to, sm.id, cause, { cause: reason, from: sm.state }, at],
    );
    // Recipients are PM, Owner and Sponsors, always in a Restricted original's audience; the summary's own title only.
    for (const userId of await reviewers(db, sm.projectId, at)) {
      await db.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, summary, link, created_at, email_off) VALUES ($1, $2, $3, 'summary_access_review', $4, $5, $6, true)`,
        [uuidv7(at.getTime()), userId, sm.projectId, `${SUMMARY_REVIEW_LABEL}: ${sm.title ?? 'Shareable summary'}`, `#/summaries/${sm.id}`, at],
      );
    }
    if (to === 'hidden' && sm.sourceId) hidden.push(sm.sourceId);
  }
  return hidden;
}

/**
 * The removal hook (spec 5.5, 6.3, 7.3), run in the same transaction as the moderation, deletion, audience change or
 * summary withdrawal. First the summaries of the removed material's originals move (moveSummaries); a summary that
 * becomes hidden makes its own `summary` source removed material too (cause `summary_withdrawn`). Then every answer or
 * draft built on the removed material that is not already in review or withdrawn moves:
 *   - a private answer, or an unshared draft, is withdrawn (it disappears entirely, even for its requester);
 *   - a shared answer or shared draft goes to review_required (PM and Deputy only, until Clear or Withdraw).
 * An answer still being worked on is private, so it is withdrawn now; when the worker finishes it writes the text
 * but never shares or shows a withdrawn answer (completeQuestion shares only from review_state 'none').
 * A cleared answer touched again goes back to review; nothing is ever brought back by this hook.
 *
 * Locks: the caller may hold thread, message, audience or (Confirm/Withdraw) summary rows. Summary rows are locked
 * here in id order, then answer rows in request id order, then draft rows in id order, so two removals cannot
 * deadlock with each other. Everything else that locks an answer together with a thread takes the thread first
 * (share, re-answer, the worker's completion).
 */
export async function onMaterialRemoved(
  db: PoolClient,
  what: RemovedMaterial,
  reason: RemovalReason,
  at: Date,
): Promise<{ withdrawn: number; review: number }> {
  const hiddenSummaries = await moveSummaries(db, what, reason, at);
  const primary = await touchedRequests(db, what);
  const viaSummary = hiddenSummaries.length > 0 ? await touchedRequests(db, { sourceIds: hiddenSummaries }) : [];
  // The cause recorded on each output: the removal itself, or a summary it used being hidden.
  const causeOf = new Map<string, RemovalReason>();
  for (const id of viaSummary) causeOf.set(id, 'summary_withdrawn');
  for (const id of primary) causeOf.set(id, reason);
  const requestIds = [...causeOf.keys()].sort();
  if (requestIds.length === 0) return { withdrawn: 0, review: 0 };
  let withdrawn = 0;
  let review = 0;
  const event = (
    projectId: string,
    action: 'withdrawn' | 'review_required',
    targetKind: 'answer' | 'report_draft',
    targetId: string,
    cause: RemovalReason,
    detail: Record<string, unknown>,
  ) =>
    db.query(
      `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, detail, at) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(at.getTime()), projectId, action, targetKind, targetId, MATERIAL_REMOVED, { cause, ...detail }, at],
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
    await event(a.projectId, to, 'answer', a.id, causeOf.get(a.id) ?? reason, a.threadId ? { threadId: a.threadId } : {});
    if (to === 'withdrawn') withdrawn++;
    else review++;
  }

  // A draft is built on the material of every one of its AI versions' requests (spec 6.3), and is about to be built on
  // the material of a request still queued or running for it (a first draft or a Regenerate), which has no version yet.
  // Every report request is linked to its draft by its draft_requested event, written at the request's own time: the
  // request by primary key, its event by ai_assist_events_project_idx (project_id, at), the version check by the
  // (draft_id, version_no) index prefix. A request that ended without a version (failed, blocked) touches nothing.
  // The runner blocks a pending one (reportRemoved), so nothing is charged.
  const links = (
    await db.query<{ draftId: string; requestId: string }>(
      `SELECT e.target_id AS "draftId", r.id AS "requestId"
         FROM ai_requests r
         JOIN ai_assist_events e ON e.project_id = r.project_id AND e.at = r.created_at
                                AND e.action = 'draft_requested' AND e.target_kind = 'report_draft' AND e.detail->>'requestId' = r.id::text
        WHERE r.id = ANY($1::uuid[]) AND r.kind = 'report'
          AND (r.status IN ('queued', 'running')
               OR EXISTS (SELECT 1 FROM report_draft_versions v WHERE v.draft_id = e.target_id AND v.origin = 'ai' AND v.request_id = r.id))`,
      [requestIds],
    )
  ).rows;
  // A draft's cause is the removal itself when any of its requests used the removed material directly.
  const draftCause = new Map<string, RemovalReason>();
  for (const l of links) {
    if (draftCause.get(l.draftId) !== reason) draftCause.set(l.draftId, causeOf.get(l.requestId) ?? reason);
  }
  const drafts =
    draftCause.size === 0
      ? []
      : (
          await db.query<{ id: string; projectId: string; shared: boolean }>(
            `SELECT d.id, d.project_id AS "projectId", d.shared FROM report_drafts d
              WHERE d.id = ANY($1::uuid[]) AND d.review_state IN ('none', 'cleared')
              ORDER BY d.id FOR UPDATE`,
            [[...draftCause.keys()]],
          )
        ).rows;
  for (const d of drafts) {
    const to = d.shared ? 'review_required' : 'withdrawn';
    await db.query(`UPDATE report_drafts SET review_state = $2, review_reason = $3, reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`, [
      d.id,
      to,
      MATERIAL_REMOVED,
    ]);
    await event(d.projectId, to, 'report_draft', d.id, draftCause.get(d.id) ?? reason, {});
    if (to === 'withdrawn') withdrawn++;
    else review++;
  }
  return { withdrawn, review };
}
