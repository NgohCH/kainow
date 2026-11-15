import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type AudienceMode, type Person, inAudience } from '../discussion/audience';
import { refuseSecrets } from '../discussion/messages';
import { NoteTextError, normaliseText, sha256Hex } from '../notes/text';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { decide } from '../projects/matrix';
import { hrefFor } from '../search/query';
import { findMaterial, stillReadable } from './material';
import { ASSIST_QUEUE, type AssistQueue } from './queue';
import { type RequestStatus, createRequest } from './requests';
import { buildTerms } from './terms';

type Db = Pick<PoolClient, 'query'>;

export const MAX_QUESTION = 500;
export const BAD_QUESTION = `A question must be 1 to ${MAX_QUESTION} characters.`;
export const ANSWER_LABEL = 'AI answer — check the sources';
export const NOT_FOUND_NOTICE = 'Nothing in this project matched your question';
export const NO_LONGER_READABLE = 'This answer used information you can no longer read';
export const UNAVAILABLE_PREFIX = 'AI answer unavailable: ';

/** How the screens name a question's state (spec 5.3): the request status, with a finished answer split by not_found. */
export type AnswerStatus = 'queued' | 'running' | 'answered' | 'not_found' | 'failed' | 'blocked';

export interface AnswerSource {
  marker: string;
  location: string;
  href: string;
  cited: boolean;
  dropped: boolean;
}

export interface AnswerView {
  id: string;
  projectId: string;
  question: string;
  status: AnswerStatus;
  /** Null until answered, when the AI gave no text, or when the viewer can no longer read what it was built from. */
  answerMarkdown: string | null;
  /** The line shown in place of, or above, the answer: not found, unavailable, or no longer readable. */
  notice: string | null;
  /** Why no AI answer was produced (failed or blocked), in plain words. */
  unavailableReason: string | null;
  /** The words the material search used (shown with "Nothing in this project matched your question"). */
  searchedWords: string[];
  label: typeof ANSWER_LABEL;
  askedBy: Person;
  askedByLabel: string;
  askedAt: Date;
  answeredAt: Date | null;
  model: string | null;
  visibility: 'private' | 'shared';
  sharedThreadId: string | null;
  /** Sources used: cited ones first, then the rest in the order they were found. */
  sources: AnswerSource[];
  droppedCount: number;
}

/** What visibility is decided on. */
export interface AnswerRow {
  requestId: string;
  projectId: string;
  requestedBy: string;
  visibility: 'private' | 'shared';
  sharedThreadId: string | null;
  hidden: boolean;
  reviewState: 'none' | 'review_required' | 'cleared' | 'withdrawn';
  answerMarkdown: string | null;
}

export type AnswerAccess = 'none' | 'readable' | 'no_longer_readable';

const ANSWER_ROW = `a.request_id AS "requestId", a.project_id AS "projectId", r.requested_by AS "requestedBy", a.visibility,
  a.shared_thread_id AS "sharedThreadId", a.hidden, a.review_state AS "reviewState", a.answer_markdown AS "answerMarkdown"`;

/** A question's answer row, or undefined. */
export async function loadAnswerRow(db: Db, requestId: string): Promise<AnswerRow | undefined> {
  if (!UUID.test(requestId)) return undefined;
  const { rows } = await db.query(
    `SELECT ${ANSWER_ROW} FROM ai_answers a JOIN ai_requests r ON r.id = a.request_id WHERE a.request_id = $1 AND r.kind = 'question'`,
    [requestId],
  );
  return rows[0] as AnswerRow | undefined;
}

const mayReview = (ctx: ProjectContext) => decide({ action: 'assist.review', roles: ctx.roles, status: ctx.project.status }).allowed;

/**
 * Who may see an answer now (spec 5.3, 5.5). Private: the requester only. Shared: anyone who can read the thread, unless
 * it is in review (PM and Deputy only) or hidden (moderators and the requester). Withdrawn: nobody, not even the
 * requester. Then, on every display, the viewer must still be able to read every passage and record it was built from;
 * if not, the answer is replaced by a notice ('no_longer_readable'). 'none' means the caller answers 404.
 */
export async function answerAccess(db: Db, ctx: ProjectContext | null, row: AnswerRow): Promise<AnswerAccess> {
  if (!canReadContent(ctx) || ctx.project.id !== row.projectId) return 'none';
  if (row.reviewState === 'withdrawn') return 'none';
  if (row.visibility === 'private') {
    if (row.requestedBy !== ctx.viewerId) return 'none';
  } else {
    const reviewer = mayReview(ctx);
    if (row.reviewState === 'review_required' && !reviewer) return 'none';
    if (row.hidden && !reviewer && row.requestedBy !== ctx.viewerId) return 'none';
    const thread = (
      await db.query<{ id: string; projectId: string; mode: AudienceMode; named: string[] }>(
        `SELECT au.id, au.project_id AS "projectId", au.mode,
                COALESCE((SELECT array_agg(m.user_id) FROM audience_members m WHERE m.audience_id = au.id), '{}') AS named
           FROM discussion_threads t JOIN audiences au ON au.id = t.audience_id
          WHERE t.id = $1 AND t.project_id = $2`,
        [row.sharedThreadId, row.projectId],
      )
    ).rows[0];
    if (!thread || !inAudience(ctx, { id: thread.id, projectId: thread.projectId, mode: thread.mode, namedUserIds: thread.named })) return 'none';
  }
  return (await stillReadable(db, ctx, row.requestId)) ? 'readable' : 'no_longer_readable';
}

/** The runner's failure codes in plain words, for "AI answer unavailable: <reason>". */
const REASONS: Readonly<Record<string, string>> = {
  model_not_configured: 'no AI key is configured',
  spend_not_configured: 'the AI settings have not been approved yet',
  spend_no_allowance: 'there is no AI allowance',
  spend_user_no_allowance: 'you have no personal AI allowance',
  spend_cap_would_be_exceeded: 'not enough AI allowance is left',
  spend_user_cap_would_be_exceeded: 'not enough of your personal AI allowance is left',
  project_not_open: 'the project is not open (Deferred or Closed)',
  requester_not_allowed: 'you can no longer read this project',
  thread_not_found: 'the thread no longer exists',
  material_unavailable: 'nothing found for this question can be read any more',
  queue_unavailable: 'the question could not be queued; ask again',
  bad_response: 'the AI answer did not match its sources, so it was not kept',
  model_rejected: 'the AI service refused the request',
  model_unavailable: 'the AI service did not answer',
};

export function unavailableReason(code: string | null, detail: string | null): string {
  if (code && REASONS[code]) return REASONS[code];
  // secret_found names the kinds found; anything else unexpected keeps the runner's own wording.
  if (code === 'secret_found' && detail) return detail;
  return 'an unexpected error stopped the AI request';
}

/** The question: 1 to 500 characters after normalising, with no credential in it (refused as in 4a). */
export function cleanQuestion(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException(BAD_QUESTION);
  let text: string;
  try {
    text = normaliseText(raw).trim();
  } catch (err) {
    if (err instanceof NoteTextError) throw new BadRequestException(BAD_QUESTION);
    throw err;
  }
  if (text.length < 1 || text.length > MAX_QUESTION) throw new BadRequestException(BAD_QUESTION);
  refuseSecrets(text);
  return text;
}

interface ViewRow extends AnswerRow {
  askedByName: string;
  status: RequestStatus;
  failureCode: string | null;
  failureDetail: string | null;
  modelId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  question: string;
  notFound: boolean;
}

const VIEW_SELECT = `SELECT ${ANSWER_ROW}, u.display_name AS "askedByName", r.status, r.failure_code AS "failureCode",
       r.failure_detail AS "failureDetail", r.model_id AS "modelId", r.created_at AS "createdAt", r.finished_at AS "finishedAt",
       a.question, a.not_found AS "notFound"
  FROM ai_answers a JOIN ai_requests r ON r.id = a.request_id JOIN users u ON u.id = r.requested_by`;

/** The newest questions shown in the Ask panel. */
const LIST_LIMIT = 100;

/** Private AI questions (spec 5.1–5.3, 5.5): asking, the person's own list, and one answer by its link. */
@Injectable()
export class QuestionsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(ASSIST_QUEUE) private readonly queue: AssistQueue,
    private readonly access: ProjectAccess,
  ) {}

  private async inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Stores the question with the material found for it, at once, so the sources show immediately; the AI part runs on
   * the worker. Always personal scope: nothing here creates thread scope (so an Audit/Oversight grant holder's answer
   * stays private). With no search words, or nothing found, there is no AI request and no charge: the request is stored
   * already finished as "not found" and is never queued.
   */
  async ask(user: AuthUser, projectId: string, body: { question: unknown }): Promise<AnswerView> {
    const { id, queue, ctx } = await this.inTransaction(async (db) => {
      const ctx = await this.access.authorize(user, 'assist.ask', projectId, db);
      const question = cleanQuestion(body.question);
      const terms = buildTerms(question);
      const material = terms.length > 0 ? await findMaterial(db, { kind: 'personal', ctx }, terms) : [];
      const at = this.now();
      const id = await createRequest(db, { projectId, kind: 'question', requestedBy: user.id, scope: 'personal', material, at });
      const found = material.length > 0;
      await db.query(`INSERT INTO ai_answers (request_id, project_id, question, not_found) VALUES ($1, $2, $3, $4)`, [id, projectId, question, !found]);
      if (!found) await db.query(`UPDATE ai_requests SET status = 'succeeded', finished_at = $2 WHERE id = $1`, [id, at]);
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'asked', 'answer', $4, $5, $6)`,
        [uuidv7(at.getTime()), projectId, user.id, id, { questionLength: question.length, questionSha256: sha256Hex(question), terms: terms.length, material: material.length }, at],
      );
      return { id, queue: found, ctx };
    });
    if (queue) {
      try {
        await this.queue.enqueue(id);
      } catch {
        await this.pool.query(
          `UPDATE ai_requests SET status = 'failed', failure_code = 'queue_unavailable', failure_detail = 'The question could not be queued; ask again.', finished_at = $2
            WHERE id = $1 AND status = 'queued'`,
          [id, this.now()],
        );
      }
    }
    const view = await this.viewOf(ctx, id);
    if (!view) throw new NotFoundException();
    return view;
  }

  /** The person's own questions in this project, newest first. Readable in every project state. */
  async list(user: AuthUser, projectId: string): Promise<AnswerView[]> {
    const ctx = await this.access.authorize(user, 'note.view', projectId);
    const { rows } = await this.pool.query(
      `${VIEW_SELECT} WHERE r.project_id = $1 AND r.requested_by = $2 AND r.kind = 'question' ORDER BY r.created_at DESC, r.id DESC LIMIT ${LIST_LIMIT}`,
      [projectId, user.id],
    );
    const out: AnswerView[] = [];
    for (const row of rows as ViewRow[]) {
      const view = await this.build(ctx, row);
      if (view) out.push(view);
    }
    return out;
  }

  /** One answer by its link; 404 for anyone who may not see it. */
  async get(user: AuthUser, requestId: string): Promise<AnswerView> {
    const row = await loadAnswerRow(this.pool, requestId);
    if (!row) throw new NotFoundException();
    const ctx = await this.access.load(row.projectId, user);
    const view = ctx ? await this.viewOf(ctx, requestId) : undefined;
    if (!view) throw new NotFoundException();
    return view;
  }

  private async viewOf(ctx: ProjectContext, requestId: string): Promise<AnswerView | undefined> {
    const row = (await this.pool.query(`${VIEW_SELECT} WHERE a.request_id = $1 AND r.kind = 'question'`, [requestId])).rows[0] as ViewRow | undefined;
    return row ? this.build(ctx, row) : undefined;
  }

  private async build(ctx: ProjectContext, row: ViewRow): Promise<AnswerView | undefined> {
    const seen = await answerAccess(this.pool, ctx, row);
    if (seen === 'none') return undefined;
    const status: AnswerStatus = row.status === 'succeeded' ? (row.notFound ? 'not_found' : 'answered') : row.status;
    const ended = status === 'failed' || status === 'blocked';
    const reason = ended ? unavailableReason(row.failureCode, row.failureDetail) : null;
    const base = {
      id: row.requestId,
      projectId: row.projectId,
      question: row.question,
      status,
      searchedWords: buildTerms(row.question),
      label: ANSWER_LABEL,
      askedBy: { id: row.requestedBy, displayName: row.askedByName },
      askedByLabel: `Asked by ${row.askedByName}`,
      askedAt: row.createdAt,
      answeredAt: status === 'answered' || status === 'not_found' ? row.finishedAt : null,
      model: row.status === 'succeeded' ? row.modelId : null,
      visibility: row.visibility,
      sharedThreadId: row.sharedThreadId,
      unavailableReason: reason,
    } as const;
    if (seen === 'no_longer_readable') {
      return { ...base, answerMarkdown: null, notice: NO_LONGER_READABLE, sources: [], droppedCount: 0 };
    }
    const sources = await this.sources(row.requestId, row.projectId);
    return {
      ...base,
      answerMarkdown: row.answerMarkdown,
      notice: ended ? `${UNAVAILABLE_PREFIX}${reason}` : status === 'not_found' ? NOT_FOUND_NOTICE : null,
      sources: [...sources.filter((s) => s.cited), ...sources.filter((s) => !s.cited)],
      droppedCount: sources.filter((s) => s.dropped).length,
    };
  }

  /** The material the request stored, in found order, with a link to each passage or record. */
  private async sources(requestId: string, projectId: string): Promise<AnswerSource[]> {
    const { rows } = await this.pool.query(
      `SELECT m.marker, m.location, m.cited, m.dropped_at_start AS dropped, m.passage_id AS "passageId", m.record_kind AS "recordKind",
              m.record_id AS "recordId", sv.source_id AS "sourceId", dm.thread_id AS "threadId", dm.message_no AS "messageNo", x.run_id AS "runId"
         FROM ai_request_material m
         LEFT JOIN passages p ON p.id = m.passage_id
         LEFT JOIN source_versions sv ON p.owner_kind = 'source_version' AND sv.id = p.owner_id
         LEFT JOIN message_versions mv ON p.owner_kind = 'message_version' AND mv.id = p.owner_id
         LEFT JOIN discussion_messages dm ON dm.id = mv.message_id
         LEFT JOIN extraction_items x ON m.record_kind = 'ai_proposal' AND x.id = m.record_id
        WHERE m.request_id = $1 ORDER BY m.ordinal`,
      [requestId],
    );
    return rows.map((r) => {
      const common = { projectId, runId: null, versionNo: null, isCurrent: true };
      let href: string;
      if (r.passageId && r.threadId) href = hrefFor({ ...common, kind: 'message', itemId: r.passageId, threadId: r.threadId, messageNo: r.messageNo });
      else if (r.passageId) href = hrefFor({ ...common, kind: 'note', itemId: r.sourceId });
      else href = hrefFor({ ...common, kind: r.recordKind, itemId: r.recordId, runId: r.runId ?? null });
      return { marker: r.marker, location: r.location, href, cited: r.cited, dropped: r.dropped };
    });
  }
}
