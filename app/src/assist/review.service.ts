import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import type { Person } from '../discussion/audience';
import { ProjectAccess } from '../projects/access.service';
import { answerAccess, loadAnswerRow } from './questions.service';
import type { RemovalReason } from './removal';

type Db = Pick<PoolClient, 'query'>;

export type ReviewKind = 'answer' | 'draft';

const REASON_REQUIRED = 'A reason is required (up to 500 characters).';
const NOT_IN_REVIEW = 'This is not waiting for review.';

/** Why it is in review, in plain words, from the removal hook's cause (spec 5.5). */
const CAUSES: Readonly<Record<RemovalReason, string>> = {
  hidden: 'Something it used was hidden.',
  deleted: 'Something it used was deleted.',
  audience_tightened: 'The audience of something it used was narrowed.',
  summary_withdrawn: 'A shareable summary it used was withdrawn or hidden.',
};
const UNKNOWN_CAUSE = 'Something it used can no longer be read by everyone who could see it.';

/** One shared answer or shared draft waiting for PM or Deputy review. No answer or draft text. */
export interface ReviewItem {
  kind: ReviewKind;
  id: string;
  /** The question (answers) or the draft's title (drafts), which PM and Deputy may already read. */
  title: string;
  reviewReason: string;
  reason: string;
  /** By whom it was asked (answers) or requested (drafts). */
  by: Person;
  sharedThreadId: string | null;
  sharedAt: Date | null;
  flaggedAt: Date | null;
  href: string;
}

const kindOf = (raw: string): ReviewKind => {
  if (raw === 'answer' || raw === 'draft') return raw;
  throw new NotFoundException();
};

/**
 * Shared answers and shared drafts sent to review by the removal hook (spec 5.5, 6.3): listed for PM and Deputy
 * (`assist.review`, any project state), who Clear or Withdraw each with a reason. Private questions and unshared
 * drafts are never listed here: a private output touched by removal is withdrawn, not reviewed.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  async list(user: AuthUser, projectId: string): Promise<ReviewItem[]> {
    await this.access.authorize(user, 'assist.review', projectId);
    const cause = (kind: string, idExpr: string) =>
      `(SELECT e.detail->>'cause' FROM ai_assist_events e WHERE e.target_kind = '${kind}' AND e.target_id = ${idExpr} AND e.action = 'review_required' ORDER BY e.at DESC, e.id DESC LIMIT 1)`;
    const flagged = (kind: string, idExpr: string) =>
      `(SELECT e.at FROM ai_assist_events e WHERE e.target_kind = '${kind}' AND e.target_id = ${idExpr} AND e.action = 'review_required' ORDER BY e.at DESC, e.id DESC LIMIT 1)`;
    const { rows } = await this.pool.query(
      `SELECT 'answer' AS kind, a.request_id AS id, a.question AS title, a.review_reason AS "reviewReason", ${cause('answer', 'a.request_id')} AS cause,
              u.id AS "byId", u.display_name AS "byName", a.shared_thread_id AS "sharedThreadId", a.shared_at AS "sharedAt",
              ${flagged('answer', 'a.request_id')} AS "flaggedAt"
         FROM ai_answers a JOIN ai_requests r ON r.id = a.request_id JOIN users u ON u.id = r.requested_by
        WHERE a.project_id = $1 AND r.kind = 'question' AND a.visibility = 'shared' AND a.review_state = 'review_required'
       UNION ALL
       SELECT 'draft', d.id, d.title, d.review_reason, ${cause('report_draft', 'd.id')},
              u.id, u.display_name, NULL::uuid, d.shared_at, ${flagged('report_draft', 'd.id')}
         FROM report_drafts d JOIN users u ON u.id = d.created_by
        WHERE d.project_id = $1 AND d.shared AND d.review_state = 'review_required'
        ORDER BY "flaggedAt" NULLS LAST, id`,
      [projectId],
    );
    return rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      title: r.title,
      reviewReason: r.reviewReason,
      reason: CAUSES[r.cause as RemovalReason] ?? UNKNOWN_CAUSE,
      by: { id: r.byId, displayName: r.byName },
      sharedThreadId: r.sharedThreadId,
      sharedAt: r.sharedAt,
      flaggedAt: r.flaggedAt,
      href: r.kind === 'answer' ? `#/projects/${projectId}/threads/${r.sharedThreadId}?answer=${r.id}` : `#/reports/${r.id}`,
    }));
  }

  /**
   * The shared answer or draft, locked, for a reviewer. Anyone who may not see it at all finds nothing (404) before
   * the matrix refuses someone who may see the project but not review (403).
   */
  private async target(db: PoolClient, user: AuthUser, kind: ReviewKind, id: string): Promise<{ projectId: string; state: string }> {
    if (!UUID.test(id)) throw new NotFoundException();
    if (kind === 'answer') {
      const row = await loadAnswerRow(db, id, true);
      if (!row || row.visibility !== 'shared') throw new NotFoundException();
      const ctx = await this.access.load(row.projectId, user, db);
      // A reviewer can see it while it is in review; a Member cannot, and finds nothing (404, so it is not revealed).
      // Withdrawn answers are seen by nobody.
      if ((await answerAccess(db, ctx, row)) === 'none') throw new NotFoundException();
      await this.access.authorize(user, 'assist.review', row.projectId, db);
      return { projectId: row.projectId, state: row.reviewState };
    }
    const d = (
      await db.query<{ projectId: string; shared: boolean; state: string }>(
        `SELECT project_id AS "projectId", shared, review_state AS state FROM report_drafts WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!d || !d.shared) throw new NotFoundException();
    // Draft visibility belongs to the draft service (sub-project 4b Task 8); here only reviewers act on shared drafts.
    await this.access.authorize(user, 'assist.review', d.projectId, db);
    if (d.state === 'withdrawn') throw new NotFoundException();
    return { projectId: d.projectId, state: d.state };
  }

  private async decide(user: AuthUser, rawKind: string, id: string, to: 'cleared' | 'withdrawn', body: { reason: unknown }): Promise<{ kind: ReviewKind; id: string; reviewState: string }> {
    const kind = kindOf(rawKind);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const t = await this.target(client, user, kind, id);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason === '' || reason.length > 500) throw new BadRequestException(REASON_REQUIRED);
      if (t.state !== 'review_required') throw new ConflictException(NOT_IN_REVIEW);
      const at = this.now();
      await client.query(
        kind === 'answer'
          ? `UPDATE ai_answers SET review_state = $2, reviewed_by = $3, reviewed_at = $4 WHERE request_id = $1`
          : `UPDATE report_drafts SET review_state = $2, reviewed_by = $3, reviewed_at = $4 WHERE id = $1`,
        [id, to, user.id, at],
      );
      // The reviewer's own reason is kept, as a moderation reason is; never question, answer or draft text.
      await client.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv7(at.getTime()), t.projectId, user.id, to, kind === 'answer' ? 'answer' : 'report_draft', id, reason, at],
      );
      await client.query('COMMIT');
      return { kind, id, reviewState: to };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Back to visible; every display still rechecks the viewer against the material (spec 5.5). */
  clear(user: AuthUser, kind: string, id: string, body: { reason: unknown }) {
    return this.decide(user, kind, id, 'cleared', body);
  }

  /** Hidden for good; the rows and events stay for history. */
  withdraw(user: AuthUser, kind: string, id: string, body: { reason: unknown }) {
    return this.decide(user, kind, id, 'withdrawn', body);
  }
}
