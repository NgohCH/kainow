import type { PoolClient } from 'pg';
import type { RemovalReason } from '../assist/removal';
import { uuidv7 } from '../common/uuid7';
import { ACCESS_REVIEW_LABEL, outputReaders } from './readers';
import { queueOutputPlacement } from './sharing-queue';

/**
 * The outputs part of the removal hook (D101, spec 4.5): every Submitted or Registered output with a version rendered
 * from a draft that any of the touched requests built (`requests`: request id → why its material was removed) goes to
 * "Access review required", unless it is in review already. A cleared output touched again goes back to review.
 *
 * In review its readers are limited at once in Kainow (`readsOutput`: the PM, Deputies, Owner and Sponsors among its
 * readers who can still read all its remaining material); a Registered output's files move to its own output folder,
 * urgently (spec 5.5). Each move is recorded (`review_required`, no actor, the cause in its detail, never any text),
 * and those who now read it are told in-app with the output's own title only. Returns how many outputs moved.
 *
 * Locks: last in the hook, after summaries, answers and drafts; output rows in id order.
 */
export async function outputsOnMaterialRemoved(db: PoolClient, requests: ReadonlyMap<string, RemovalReason>, at: Date): Promise<number> {
  if (requests.size === 0) return 0;
  // The drafts any AI version of which came from a touched request, then every output version rendered from them: a
  // draft's material is that of all its AI versions (`draftAccess`), whichever version the output was rendered from.
  const touched = (
    await db.query<{ outputId: string; requestId: string }>(
      `SELECT DISTINCT ov.output_id AS "outputId", av.request_id AS "requestId"
         FROM report_draft_versions av
         JOIN report_draft_versions dv ON dv.draft_id = av.draft_id
         JOIN output_versions ov ON ov.draft_version_id = dv.id
        WHERE av.request_id = ANY($1::uuid[]) AND av.origin = 'ai'`,
      [[...requests.keys()]],
    )
  ).rows;
  if (touched.length === 0) return 0;
  // An output's cause is the removal itself when any request behind it used the removed material directly.
  const causeOf = new Map<string, RemovalReason>();
  for (const t of touched) {
    const prev = causeOf.get(t.outputId);
    if (prev === undefined || prev === 'summary_withdrawn') causeOf.set(t.outputId, requests.get(t.requestId) as RemovalReason);
  }
  const outputs = (
    await db.query<{ id: string; projectId: string; title: string; status: string }>(
      `SELECT o.id, o.project_id AS "projectId", o.title, o.status FROM outputs o
        WHERE o.id = ANY($1::uuid[]) AND o.status IN ('submitted', 'registered') AND o.review_state IN ('none', 'cleared')
        ORDER BY o.id FOR UPDATE`,
      [[...causeOf.keys()]],
    )
  ).rows;
  for (const o of outputs) {
    const cause = causeOf.get(o.id) as RemovalReason;
    await db.query(`UPDATE outputs SET review_state = 'review_required' WHERE id = $1`, [o.id]);
    await db.query(`INSERT INTO output_events (id, output_id, kind, actor_id, at, detail) VALUES ($1, $2, 'review_required', NULL, $3, $4)`, [
      uuidv7(at.getTime()), o.id, at, JSON.stringify({ cause }),
    ]);
    if (o.status === 'registered') await queueOutputPlacement(db, o.id, 'narrow');
    // Those who read it now are its reviewers (PM, Deputies, Owner and Sponsors who can still read it): the title only.
    for (const userId of [...(await outputReaders(db, o.id, at))].sort()) {
      await db.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, summary, link, created_at, email_off) VALUES ($1, $2, $3, 'output_access_review', $4, $5, $6, true)`,
        [uuidv7(at.getTime()), userId, o.projectId, `${ACCESS_REVIEW_LABEL}: ${o.title}`, `#/projects/${o.projectId}/outputs/${o.id}`, at],
      );
    }
  }
  return outputs.length;
}
