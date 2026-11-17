import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
import { type MaterialRef, findMaterial, readableMaterial, stillReadable } from './material';
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
export const SOME_CANNOT_READ = 'This answer used information some people in this thread cannot read.';
/** The same words as 4a's ThreadsService (not imported: threads.service imports this file). */
const MEETING_ENDED = 'This meeting has ended.';
const REASON_REQUIRED = 'A reason is required (up to 500 characters).';
const CHOOSE_THREAD = 'Choose a thread or meeting to share into.';

/** How the screens name a question's state (spec 5.3): the request status, with a finished answer split by not_found. */
export type AnswerStatus = 'queued' | 'running' | 'answered' | 'not_found' | 'failed' | 'blocked';

export interface AnswerSource {
  marker: string;
  /** Null for material dropped at start: it was not sent, and the viewer may no longer be allowed to know where it was. */
  location: string | null;
  href: string | null;
  cited: boolean;
  dropped: boolean;
}

export interface AnswerView {
  id: string;
  projectId: string;
  /** Null when the answer is hidden in its thread and the viewer is neither a moderator nor the requester. */
  question: string | null;
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
  sharedAt: Date | null;
  /** Hidden in its thread by a moderator; the notice then reads "Hidden by <name>: <reason>". */
  hidden: boolean;
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
  hiddenReason: string | null;
  hiddenByName: string | null;
  sharedAt: Date | null;
  reviewState: 'none' | 'review_required' | 'cleared' | 'withdrawn';
  answerMarkdown: string | null;
}

/**
 * 'hidden': a shared answer a moderator hid, seen by a thread reader who is neither a moderator nor the requester:
 * the item shows that it was hidden, by whom and why, and nothing of the question, answer or sources (as 4a hides a message).
 */
export type AnswerAccess = 'none' | 'hidden' | 'readable' | 'no_longer_readable';

const ANSWER_ROW = `a.request_id AS "requestId", a.project_id AS "projectId", r.requested_by AS "requestedBy", a.visibility,
  a.shared_thread_id AS "sharedThreadId", a.shared_at AS "sharedAt", a.hidden, a.hidden_reason AS "hiddenReason",
  (SELECT hu.display_name FROM users hu WHERE hu.id = a.hidden_by) AS "hiddenByName",
  a.review_state AS "reviewState", a.answer_markdown AS "answerMarkdown"`;

/** A question's answer row, or undefined. With `lock`, the answer row is locked for the transaction. */
export async function loadAnswerRow(db: Db, requestId: string, lock = false): Promise<AnswerRow | undefined> {
  if (!UUID.test(requestId)) return undefined;
  const { rows } = await db.query(
    `SELECT ${ANSWER_ROW} FROM ai_answers a JOIN ai_requests r ON r.id = a.request_id WHERE a.request_id = $1 AND r.kind = 'question'
     ${lock ? 'FOR UPDATE OF a' : ''}`,
    [requestId],
  );
  return rows[0] as AnswerRow | undefined;
}

export const hiddenNotice = (row: Pick<AnswerRow, 'hiddenByName' | 'hiddenReason'>): string =>
  `Hidden by ${row.hiddenByName ?? 'a moderator'}: ${row.hiddenReason ?? 'no reason recorded'}`;

const mayReview = (ctx: ProjectContext) => decide({ action: 'assist.review', roles: ctx.roles, status: ctx.project.status }).allowed;

/**
 * Who may see an answer now (spec 5.3, 5.4, 5.5). Private: the requester only. Shared: anyone who can read the thread,
 * unless it is in review (PM and Deputy only). A hidden shared answer shows its content to PM, Deputy and the requester;
 * other thread readers get 'hidden' (that it was hidden, by whom and why, nothing more). Withdrawn: nobody, not even
 * the requester. Then, on every display, the viewer must still be able to read every passage and record it was built
 * from; if not, the answer is replaced by a notice ('no_longer_readable'). 'none' means the caller answers 404.
 */
export async function answerAccess(db: Db, ctx: ProjectContext | null, row: AnswerRow): Promise<AnswerAccess> {
  if (!canReadContent(ctx) || ctx.project.id !== row.projectId) return 'none';
  if (row.reviewState === 'withdrawn') return 'none';
  if (row.visibility === 'private') {
    if (row.requestedBy !== ctx.viewerId) return 'none';
  } else {
    const reviewer = mayReview(ctx);
    if (row.reviewState === 'review_required' && !reviewer) return 'none';
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
    if (row.hidden && !reviewer && row.requestedBy !== ctx.viewerId) return 'hidden';
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
  meeting_ended: 'the meeting has ended, so the answer could not be posted',
  material_unavailable: 'nothing found for this question can be read any more',
  material_removed: 'something it used was removed or its audience narrowed',
  queue_unavailable: 'the question could not be queued; ask again',
  bad_response: 'the AI answer did not match its sources, so it was not kept',
  model_rejected: 'the AI service refused the request',
  model_unavailable: 'the AI service did not answer',
  stalled: 'it stopped without finishing; ask again',
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

/**
 * The material the request stored, in found order, with a link to each passage or record. Material dropped at start
 * keeps its marker and flag but no location or link: it was not sent, and may be something the viewer cannot read now.
 */
export async function answerSources(db: Db, requestId: string, projectId: string): Promise<AnswerSource[]> {
  const { rows } = await db.query(
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
    if (r.dropped) return { marker: r.marker, location: null, href: null, cited: r.cited, dropped: true };
    const common = { projectId, runId: null, versionNo: null, isCurrent: true };
    let href: string;
    if (r.passageId && r.threadId) href = hrefFor({ ...common, kind: 'message', itemId: r.passageId, threadId: r.threadId, messageNo: r.messageNo });
    else if (r.passageId) href = hrefFor({ ...common, kind: 'note', itemId: r.sourceId });
    else href = hrefFor({ ...common, kind: r.recordKind, itemId: r.recordId, runId: r.runId ?? null });
    return { marker: r.marker, location: r.location, href, cited: r.cited, dropped: false };
  });
}

/** One answer as this viewer may see it, or undefined when they may not see it at all. */
async function buildView(db: Db, ctx: ProjectContext, row: ViewRow): Promise<AnswerView | undefined> {
  const seen = await answerAccess(db, ctx, row);
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
    sharedAt: row.sharedAt,
    hidden: row.hidden,
    unavailableReason: reason,
  } as const;
  if (seen === 'hidden') {
    return { ...base, question: null, searchedWords: [], answerMarkdown: null, notice: hiddenNotice(row), sources: [], droppedCount: 0 };
  }
  if (seen === 'no_longer_readable') {
    return { ...base, answerMarkdown: null, notice: NO_LONGER_READABLE, sources: [], droppedCount: 0 };
  }
  const sources = await answerSources(db, row.requestId, row.projectId);
  let notice: string | null = null;
  if (row.hidden) notice = hiddenNotice(row);
  else if (ended) notice = `${UNAVAILABLE_PREFIX}${reason}`;
  else if (status === 'not_found') notice = NOT_FOUND_NOTICE;
  return {
    ...base,
    answerMarkdown: row.answerMarkdown,
    notice,
    sources: [...sources.filter((s) => s.cited), ...sources.filter((s) => !s.cited)],
    droppedCount: sources.filter((s) => s.dropped).length,
  };
}

/** A shared AI answer as one item of a thread's timeline (spec 5.4). Not a numbered message; the web merges by time. */
export interface ThreadAnswerView {
  id: string;
  askedBy: Person;
  question: string | null;
  answerMarkdown: string | null;
  sources: AnswerSource[];
  droppedCount: number;
  sharedAt: Date;
  hidden: boolean;
  notice: string | null;
}

/**
 * The answers shared into a thread, oldest first, as this viewer may see each one: the caller has already checked
 * that the viewer can read the thread. Each display rechecks the viewer against the answer's material (spec 5.5).
 */
export async function threadAnswers(db: Db, ctx: ProjectContext, threadId: string): Promise<ThreadAnswerView[]> {
  const { rows } = await db.query(
    `${VIEW_SELECT} WHERE a.shared_thread_id = $1 AND a.visibility = 'shared' AND r.kind = 'question' ORDER BY a.shared_at, a.request_id`,
    [threadId],
  );
  const out: ThreadAnswerView[] = [];
  for (const row of rows as ViewRow[]) {
    const v = await buildView(db, ctx, row);
    if (!v) continue;
    out.push({
      id: v.id,
      askedBy: v.askedBy,
      question: v.question,
      answerMarkdown: v.answerMarkdown,
      sources: v.sources,
      droppedCount: v.droppedCount,
      sharedAt: row.sharedAt as Date,
      hidden: v.hidden,
      notice: v.notice,
    });
  }
  return out;
}

/** A thread or meeting the requester may share into. */
interface Target {
  id: string;
  audienceId: string;
}

type Material = Awaited<ReturnType<typeof findMaterial>>;

/** Private AI questions (spec 5.1–5.3, 5.5), sharing them into threads (spec 5.4), and hiding shared ones. */
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

  /** Queues a stored request; if the queue cannot take it, the request ends failed so it is not left waiting. */
  private async enqueue(id: string): Promise<void> {
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

  /** Writes the request, its material and its answer row; with no material it is stored already finished as not found. */
  private async store(
    db: Db,
    q: { projectId: string; userId: string; question: string; material: Material; at: Date; scope: 'personal' | 'thread'; threadId?: string },
  ): Promise<string> {
    const id = await createRequest(db, {
      projectId: q.projectId,
      kind: 'question',
      requestedBy: q.userId,
      scope: q.scope,
      scopeThreadId: q.threadId,
      material: q.material,
      at: q.at,
    });
    const found = q.material.length > 0;
    await db.query(`INSERT INTO ai_answers (request_id, project_id, question, not_found) VALUES ($1, $2, $3, $4)`, [id, q.projectId, q.question, !found]);
    if (!found) await db.query(`UPDATE ai_requests SET status = 'succeeded', finished_at = $2 WHERE id = $1`, [id, q.at]);
    return id;
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
      const id = await this.store(db, { projectId, userId: user.id, question, material, at, scope: 'personal' });
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'asked', 'answer', $4, $5, $6)`,
        [uuidv7(at.getTime()), projectId, user.id, id, { questionLength: question.length, questionSha256: sha256Hex(question), terms: terms.length, material: material.length }, at],
      );
      return { id, queue: material.length > 0, ctx };
    });
    if (queue) await this.enqueue(id);
    return this.mustView(ctx, id);
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
      const view = await buildView(this.pool, ctx, row);
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

  /**
   * The requester's own answer, locked, and their context for sharing (spec 8: the requester, who can post in the
   * thread). Anyone else, or an answer the requester can no longer see at all, is 404; the matrix refuses an
   * Audit/Oversight grant holder (read-only: private answers only, spec 5.1) and a Deferred or Closed project with 403.
   */
  private async ownAnswer(db: PoolClient, user: AuthUser, requestId: string): Promise<{ row: AnswerRow; ctx: ProjectContext }> {
    const row = await loadAnswerRow(db, requestId, true);
    if (!row || row.requestedBy !== user.id) throw new NotFoundException();
    if ((await answerAccess(db, await this.access.load(row.projectId, user, db), row)) === 'none') throw new NotFoundException();
    const ctx = await this.access.authorize(user, 'assist.share', row.projectId, db);
    return { row, ctx };
  }

  /**
   * Locks the chosen thread row (if the id names one) before anything locks the answer row: threads before answers is
   * the order moderation and its removal hook use (spec 5.5), so sharing cannot deadlock with hiding a message.
   * Only a lock: whether the person may see or post in the thread is checked by postableThread.
   */
  private async lockThreadFirst(db: PoolClient, raw: unknown): Promise<void> {
    if (typeof raw === 'string' && UUID.test(raw)) await db.query(`SELECT 1 FROM discussion_threads WHERE id = $1 FOR NO KEY UPDATE`, [raw]);
  }

  /** A thread or meeting in the project that the person can read and post in (open; Draft, Planned or Active). */
  private async postableThread(db: PoolClient, user: AuthUser, ctx: ProjectContext, raw: unknown): Promise<Target> {
    if (typeof raw !== 'string' || !UUID.test(raw)) throw new BadRequestException(CHOOSE_THREAD);
    const t = (
      await db.query<{ id: string; audienceId: string; state: 'open' | 'ended' | null; mode: AudienceMode; named: string[] }>(
        `SELECT t.id, t.audience_id AS "audienceId", t.state, au.mode,
                COALESCE((SELECT array_agg(m.user_id) FROM audience_members m WHERE m.audience_id = au.id), '{}') AS named
           FROM discussion_threads t JOIN audiences au ON au.id = t.audience_id
          WHERE t.id = $1 AND t.project_id = $2
          FOR NO KEY UPDATE OF t`,
        [raw, ctx.project.id],
      )
    ).rows[0];
    if (!t || !inAudience(ctx, { id: t.audienceId, projectId: ctx.project.id, mode: t.mode, namedUserIds: t.named })) throw new NotFoundException();
    await this.access.authorize(user, 'discussion.post', ctx.project.id, db);
    if (t.state === 'ended') throw new ConflictException(MEETING_ENDED);
    return { id: t.id, audienceId: t.audienceId };
  }

  /**
   * Share to thread (spec 5.4): allowed only when every material row the request sent (cited or not; not those dropped
   * at start, which were never sent) is in the thread's material scope (spec 4.3), by the rule material.ts applies.
   * A pending proposal is never in thread scope, so an answer that used one cannot be shared: re-answer instead.
   */
  async share(user: AuthUser, requestId: string, body: { threadId: unknown }): Promise<AnswerView> {
    const ctx = await this.inTransaction(async (db) => {
      await this.lockThreadFirst(db, body.threadId);
      const { row, ctx } = await this.ownAnswer(db, user, requestId);
      const target = await this.postableThread(db, user, ctx, body.threadId);
      if (row.visibility === 'shared') throw new ConflictException('This answer is already shared.');
      const req = (
        await db.query<{ status: RequestStatus; notFound: boolean }>(
          `SELECT r.status, a.not_found AS "notFound" FROM ai_requests r JOIN ai_answers a ON a.request_id = r.id WHERE r.id = $1`,
          [row.requestId],
        )
      ).rows[0];
      if (req.status !== 'succeeded' || req.notFound || row.reviewState !== 'none') throw new ConflictException('Only an answered question can be shared.');
      const sent = (
        await db.query(
          `SELECT passage_id AS "passageId", record_kind AS "recordKind", record_id AS "recordId", record_audience_id AS "recordAudienceId"
             FROM ai_request_material WHERE request_id = $1 AND NOT dropped_at_start ORDER BY ordinal`,
          [row.requestId],
        )
      ).rows as MaterialRef[];
      const ok = await readableMaterial(db, { kind: 'thread', ctx, threadAudienceId: target.audienceId }, sent);
      if (!ok.every(Boolean)) throw new ConflictException({ statusCode: 409, message: SOME_CANNOT_READ, error: 'Conflict', canReanswer: true });
      const at = this.now();
      await db.query(`UPDATE ai_answers SET visibility = 'shared', shared_thread_id = $2, shared_by = $3, shared_at = $4 WHERE request_id = $1`, [
        row.requestId,
        target.id,
        user.id,
        at,
      ]);
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'shared', 'answer', $4, $5, $6)`,
        [uuidv7(at.getTime()), row.projectId, user.id, row.requestId, { threadId: target.id, material: sent.length }, at],
      );
      return ctx;
    });
    return this.mustView(ctx, requestId);
  }

  /**
   * Re-answer for this thread (spec 5.4): the same question asked again with thread scope, so only material everyone in
   * the thread can read is found and sent. On success the worker shares it into the thread (completeQuestion). With
   * nothing found it ends at once as "not found", stays private, and is never queued or posted.
   */
  async reanswer(user: AuthUser, requestId: string, body: { threadId: unknown }): Promise<AnswerView> {
    const { id, queue, ctx } = await this.inTransaction(async (db) => {
      await this.lockThreadFirst(db, body.threadId);
      const { row, ctx } = await this.ownAnswer(db, user, requestId);
      const target = await this.postableThread(db, user, ctx, body.threadId);
      const question = (await db.query<{ question: string }>(`SELECT question FROM ai_answers WHERE request_id = $1`, [row.requestId])).rows[0].question;
      // One re-answer of a question for a thread at a time (the thread row is locked, so two requests cannot both pass).
      const pending = await db.query(
        `SELECT 1 FROM ai_requests r JOIN ai_answers a ON a.request_id = r.id
          WHERE r.kind = 'question' AND r.scope = 'thread' AND r.scope_thread_id = $1 AND r.requested_by = $2
            AND r.status IN ('queued', 'running') AND a.question = $3 LIMIT 1`,
        [target.id, user.id, question],
      );
      if (pending.rowCount) throw new ConflictException('This question is already being answered again for this thread.');
      const terms = buildTerms(question);
      const material = terms.length > 0 ? await findMaterial(db, { kind: 'thread', ctx, threadAudienceId: target.audienceId }, terms) : [];
      const at = this.now();
      const id = await this.store(db, { projectId: row.projectId, userId: user.id, question, material, at, scope: 'thread', threadId: target.id });
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'reanswered', 'answer', $4, $5, $6)`,
        [uuidv7(at.getTime()), row.projectId, user.id, id, { fromRequestId: row.requestId, threadId: target.id, terms: terms.length, material: material.length }, at],
      );
      return { id, queue: material.length > 0, ctx };
    });
    if (queue) await this.enqueue(id);
    return this.mustView(ctx, id);
  }

  /** Hide or unhide a shared answer (spec 5.4): PM or Deputy, with a reason, as 4a moderates a message. */
  private async moderate(user: AuthUser, requestId: string, hide: boolean, body: { reason: unknown }): Promise<AnswerView> {
    const ctx = await this.inTransaction(async (db) => {
      const row = await loadAnswerRow(db, requestId, true);
      if (!row || row.visibility !== 'shared') throw new NotFoundException();
      if ((await answerAccess(db, await this.access.load(row.projectId, user, db), row)) === 'none') throw new NotFoundException();
      const ctx = await this.access.authorize(user, 'message.moderate', row.projectId, db);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason === '' || reason.length > 500) throw new BadRequestException(REASON_REQUIRED);
      if (row.hidden === hide) throw new ConflictException(hide ? 'This answer is already hidden.' : 'This answer is not hidden.');
      const at = this.now();
      await db.query(
        hide
          ? `UPDATE ai_answers SET hidden = true, hidden_reason = $2, hidden_by = $3, hidden_at = $4 WHERE request_id = $1`
          : `UPDATE ai_answers SET hidden = false, hidden_reason = NULL, hidden_by = NULL, hidden_at = NULL WHERE request_id = $1`,
        hide ? [row.requestId, reason, user.id, at] : [row.requestId],
      );
      // The reason is the moderator's own words, kept as 4a keeps a message moderation reason; never question or answer text.
      await db.query(
        `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, detail, at) VALUES ($1, $2, $3, $4, 'answer', $5, $6, $7, $8)`,
        [uuidv7(at.getTime()), row.projectId, user.id, hide ? 'hidden' : 'unhidden', row.requestId, reason, { threadId: row.sharedThreadId }, at],
      );
      return ctx;
    });
    return this.mustView(ctx, requestId);
  }

  hide(user: AuthUser, requestId: string, body: { reason: unknown }) {
    return this.moderate(user, requestId, true, body);
  }

  unhide(user: AuthUser, requestId: string, body: { reason: unknown }) {
    return this.moderate(user, requestId, false, body);
  }

  private async viewOf(ctx: ProjectContext, requestId: string): Promise<AnswerView | undefined> {
    const row = (await this.pool.query(`${VIEW_SELECT} WHERE a.request_id = $1 AND r.kind = 'question'`, [requestId])).rows[0] as ViewRow | undefined;
    return row ? buildView(this.pool, ctx, row) : undefined;
  }

  private async mustView(ctx: ProjectContext, requestId: string): Promise<AnswerView> {
    const view = await this.viewOf(ctx, requestId);
    if (!view) throw new NotFoundException();
    return view;
  }
}
