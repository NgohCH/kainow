import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { type ProjectAction, decide } from '../projects/matrix';
import { todayUtc8 } from '../projects/membership';
import { indexVersion } from '../assist/passage-index';
import { formatMessageTime } from '../assist/passages';
import { type ThreadAnswerView, threadAnswers } from '../assist/questions.service';
import { onMaterialRemoved } from '../assist/removal';
import { sha256Hex } from '../notes/text';
import { type AudienceChange, type AudienceMode, type AudienceRow, type Person, RESTRICTED_ROLES, audienceVisibleSql, parseAudienceChange } from './audience';
import { MINUTES_LABEL } from '../notes/notes.service';
import { AudienceService } from './audience.service';
import { type MessageState, cleanBody, displayBody, refuseSecrets, replyQuote } from './messages';
import { HELD_TEXT, POSSIBLE_COPY_TEXT, possibleCopies } from '../quarantine/labels';
import { HELD } from '../history/deleted-sql';

type Db = Pool | PoolClient;

export interface MessageView {
  id: string;
  no: number;
  author: Person;
  createdAt: Date;
  edited: boolean;
  version: number;
  state: MessageState;
  text: string | null;
  notice: string | null;
  replyTo: { id: string; no: number; quote: string | null; notice: string | null } | null;
  /**
   * Only for a holder of Inspect Deleted Content reading a Deleted message (history spec 4.7): `text` then holds the
   * message, read-only, and these say who deleted it, when and why, for the label "Deleted — <name>, <d Mon yyyy>: <reason>".
   */
  deletedBy?: string;
  deletedAt?: Date;
  deleteReason?: string;
  /** "Possible credential removed — awaiting check" on a place masked at once for a quarantine case (history spec 7.4). */
  quarantineLabel: string | null;
}

export interface MessageVersionView {
  versionNo: number;
  text: string;
  createdAt: Date;
}

export interface ThreadView {
  id: string;
  projectId: string;
  kind: 'discussion' | 'meeting';
  title: string;
  audience: { id: string; mode: AudienceMode; namedUsers: Person[]; changedAt: string | null };
  meetingDate: string | null;
  state: 'open' | 'ended' | null;
  messages: MessageView[];
  /** AI answers shared into the thread (spec 5.4), oldest first: not numbered messages; the web merges them by time. */
  aiAnswers: ThreadAnswerView[];
  /** The Present list of a meeting (empty for a discussion). */
  present: Person[];
  canPost: boolean;
  canModerate: boolean;
}

/**
 * One entry of a project's discussion list. Threads and meetings carry `messageCount`; notes, minutes and
 * submissions carry none. `label` is the short tag the screen shows ("Minutes — from meeting", "Submitted for review").
 */
export interface DiscussionListItem {
  kind: 'discussion' | 'meeting' | 'notes' | 'minutes' | 'submission';
  id: string;
  title: string;
  lastActivityAt: Date;
  meetingDate: string | null;
  state: 'open' | 'ended' | null;
  audienceMode: AudienceMode;
  messageCount: number | null;
  label: string | null;
}

export interface ThreadRow {
  id: string;
  projectId: string;
  kind: 'discussion' | 'meeting';
  title: string;
  audienceId: string;
  meetingDate: string | null;
  state: 'open' | 'ended' | null;
  /** Held in an open quarantine case (its title, or a minutes draft of the meeting; history spec 7.2). */
  heldCaseId: string | null;
}

const THREAD_COLUMNS = `id, project_id AS "projectId", kind, title, audience_id AS "audienceId",
  to_char(meeting_date, 'YYYY-MM-DD') AS "meetingDate", state, held_case_id AS "heldCaseId"`;

export const STALE_EDIT = 'Someone changed this since you opened it';
export const MEETING_ENDED = 'This meeting has ended.';
const REASON_REQUIRED = 'A reason is required (up to 500 characters).';
const BAD_TITLE = 'A title of 1 to 200 characters is required.';

type ModerationAction = 'hide' | 'unhide' | 'delete' | 'restore';

/** Which states each move starts from and ends in (spec 4.1, 4.3). Restoring is for Deleted messages; unhiding for Hidden ones. */
const MODERATION: Record<
  ModerationAction,
  { matrix: ProjectAction; from: MessageState[]; to: MessageState; event: 'hidden' | 'unhidden' | 'deleted' | 'restored'; refusal: (s: MessageState) => string }
> = {
  hide: { matrix: 'message.moderate', from: ['visible'], to: 'hidden', event: 'hidden', refusal: (s) => `This message is already ${s}.` },
  unhide: { matrix: 'message.moderate', from: ['hidden'], to: 'visible', event: 'unhidden', refusal: (s) => (s === 'deleted' ? 'This message is deleted; restore it instead.' : 'This message is not hidden.') },
  delete: { matrix: 'message.moderate', from: ['visible', 'hidden'], to: 'deleted', event: 'deleted', refusal: () => 'This message is already deleted.' },
  restore: { matrix: 'message.restore', from: ['deleted'], to: 'visible', event: 'restored', refusal: (s) => (s === 'hidden' ? 'This message is hidden; unhide it instead.' : 'This message is not deleted.') },
};

const meta = (text: string) => ({ length: text.length, sha256: sha256Hex(text) });

function parseTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException(BAD_TITLE);
  const title = raw.normalize('NFC').trim();
  if (title === '' || title.length > 200) throw new BadRequestException(BAD_TITLE);
  return title;
}

function parseMeetingDate(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const real = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw;
  if (!real) throw new BadRequestException('Give the meeting date as YYYY-MM-DD.');
  return raw as string;
}

function uuidOrNotFound(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException();
  return id;
}

/** Threads, meetings and their versioned messages (spec 3, 4, 5.1). Every read is bounded by the thread's audience. */
@Injectable()
export class ThreadsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly audiences: AudienceService,
  ) {}

  async inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
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

  async threadRow(db: Db, threadId: string, lock = false): Promise<ThreadRow> {
    const { rows } = await db.query(`SELECT ${THREAD_COLUMNS} FROM discussion_threads WHERE id = $1 ${lock ? 'FOR NO KEY UPDATE' : ''}`, [uuidOrNotFound(threadId)]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0] as ThreadRow;
  }

  /**
   * Reading: a participant or valid grant holder inside the audience; anyone else finds nothing (404). A thread held in
   * a quarantine case (history spec 7.2) is not found either; for a write (`write`), someone who could otherwise act on
   * it is refused with HELD (409) instead.
   */
  async readable(db: Db, user: AuthUser, t: ThreadRow, write = false): Promise<{ ctx: ProjectContext; audience: AudienceRow }> {
    const ctx = await this.access.authorize(user, 'note.view', t.projectId, db);
    const audience = await this.audiences.load(t.audienceId, db);
    this.audiences.assertReadable(ctx, audience);
    if (t.heldCaseId) {
      if (write) throw new ConflictException(HELD);
      throw new NotFoundException();
    }
    return { ctx, audience };
  }

  allowed(ctx: ProjectContext, action: ProjectAction): boolean {
    return decide({ action, roles: ctx.roles, status: ctx.project.status }).allowed;
  }

  async people(db: Db, ids: string[]): Promise<Person[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(`SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1::uuid[]) ORDER BY display_name, id`, [ids]);
    return rows as Person[];
  }

  /**
   * `inspectDeleted`: the viewer holds Inspect Deleted Content in this project, so a Deleted message that is not held in
   * a quarantine case shows its (stored, cleaned) text with who deleted it, when and why. Nobody else sees that text.
   */
  private async messageViews(db: Db, viewerId: string, where: string, params: unknown[], inspectDeleted = false): Promise<MessageView[]> {
    const { rows } = await db.query(
      `SELECT m.id, m.message_no AS no, m.author_id AS "authorId", au.display_name AS "authorName", m.created_at AS "createdAt",
              m.state, m.state_reason AS "stateReason", sb.display_name AS "stateByName", m.state_at AS "stateAt",
              m.held_case_id IS NOT NULL AS held, v.version_no AS version, v.body,
              r.id AS "replyId", r.message_no AS "replyNo", r.state AS "replyState", r.held_case_id IS NOT NULL AS "replyHeld", rv.body AS "replyBody"
         FROM discussion_messages m
         JOIN users au ON au.id = m.author_id
         JOIN LATERAL (SELECT version_no, body FROM message_versions WHERE message_id = m.id ORDER BY version_no DESC LIMIT 1) v ON true
         LEFT JOIN users sb ON sb.id = m.state_by
         LEFT JOIN discussion_messages r ON r.id = m.reply_to_id
         LEFT JOIN LATERAL (SELECT body FROM message_versions WHERE message_id = r.id ORDER BY version_no DESC LIMIT 1) rv ON true
        WHERE ${where} ORDER BY m.message_no`,
      params,
    );
    const possible = await possibleCopies(db, 'message', rows.map((r) => r.id));
    return rows.map((r) => {
      // A held message shows no text to anyone, only the label (history spec 7.2).
      const shown = r.held
        ? { text: null, notice: HELD_TEXT }
        : displayBody({ state: r.state, body: r.body, stateBy: r.stateByName, stateReason: r.stateReason }, r.authorId === viewerId);
      const inspected = inspectDeleted && r.state === 'deleted' && !r.held;
      return {
        id: r.id,
        no: r.no,
        author: { id: r.authorId, displayName: r.authorName },
        createdAt: r.createdAt,
        edited: r.version > 1,
        version: r.version,
        state: r.state,
        text: shown.text,
        notice: shown.notice,
        quarantineLabel: possible.has(r.id) ? POSSIBLE_COPY_TEXT : null,
        replyTo: r.replyId
          ? {
              id: r.replyId,
              no: r.replyNo,
              quote: r.replyState === 'visible' && !r.replyHeld ? replyQuote(r.replyBody) : null,
              notice: r.replyHeld ? `Reply to a held message` : r.replyState === 'visible' ? null : `Reply to a ${r.replyState} message`,
            }
          : null,
        ...(inspected ? { text: r.body as string, deletedBy: r.stateByName as string, deletedAt: r.stateAt as Date, deleteReason: r.stateReason as string } : {}),
      } satisfies MessageView;
    });
  }

  async start(user: AuthUser, projectId: string, body: { kind: unknown; title: unknown; meetingDate?: unknown; audience?: unknown }): Promise<ThreadView> {
    const id = await this.inTransaction(async (db) => {
      await this.access.authorize(user, 'discussion.post', projectId, db);
      if (body.kind !== 'discussion' && body.kind !== 'meeting') throw new BadRequestException('Choose a discussion or a meeting.');
      const kind = body.kind;
      const title = parseTitle(body.title);
      refuseSecrets(title);
      let change: AudienceChange = { mode: 'project', namedUserIds: [] };
      let meetingDate: string | null = null;
      if (kind === 'meeting') {
        if (body.audience !== undefined) change = parseAudienceChange(body.audience);
        if (change.mode === 'restricted') await this.access.authorize(user, 'meeting.restricted', projectId, db);
        meetingDate = parseMeetingDate(body.meetingDate, todayUtc8(this.now()));
      } else if (body.audience !== undefined || body.meetingDate !== undefined) {
        throw new BadRequestException('Only a meeting has a date and an audience; a discussion is open to the whole project.');
      }
      const audienceId = await this.audiences.create(db, projectId, change, user);
      const at = this.now();
      const threadId = uuidv7(at.getTime());
      await db.query(
        `INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, meeting_date, state, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [threadId, projectId, kind, title, audienceId, meetingDate, kind === 'meeting' ? 'open' : null, user.id, at],
      );
      await db.query(
        `INSERT INTO discussion_events (id, thread_id, actor_id, action, detail, at) VALUES ($1, $2, $3, 'thread_started', $4, $5)`,
        [uuidv7(at.getTime()), threadId, user.id, JSON.stringify(meta(title)), at],
      );
      return threadId;
    });
    return this.get(user, id);
  }

  /** Threads, meetings and published notes in the project the viewer may read, newest activity first. */
  async list(user: AuthUser, projectId: string): Promise<DiscussionListItem[]> {
    const ctx = await this.access.authorize(user, 'note.view', projectId);
    const visible = (alias: string) => audienceVisibleSql(alias, '$2', '$3');
    // A submission is for its submitter and for PM, Deputy, Owner and Sponsor, whatever audience is intended (spec 5.4).
    const reviewer = ctx.roles.some((r) => RESTRICTED_ROLES.includes(r));
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         SELECT t.kind, t.id, t.title, COALESCE(t.last_message_at, t.created_at) AS "lastActivityAt",
                to_char(t.meeting_date, 'YYYY-MM-DD') AS "meetingDate", t.state, a.mode AS "audienceMode", t.next_message_no - 1 AS "messageCount", NULL AS label
           FROM discussion_threads t JOIN audiences a ON a.id = t.audience_id
          WHERE t.project_id = $1 AND t.held_case_id IS NULL AND ${visible('a')}
         UNION ALL
         SELECT CASE WHEN s.publication <> 'published' THEN 'submission' WHEN s.kind = 'minutes' THEN 'minutes' ELSE 'notes' END,
                s.id, s.title, max(v.created_at), NULL, NULL, a.mode, NULL,
                CASE WHEN s.publication = 'submitted' THEN 'Submitted for review' WHEN s.publication = 'returned' THEN 'Returned'
                     WHEN s.kind = 'minutes' THEN '${MINUTES_LABEL}' END
           FROM sources s JOIN audiences a ON a.id = s.audience_id JOIN source_versions v ON v.source_id = s.id
          WHERE s.project_id = $1 AND s.status = 'active' AND s.held_case_id IS NULL AND s.kind IN ('notes', 'minutes')
            AND ((s.publication = 'published' AND ${visible('a')}) OR (s.publication <> 'published' AND ($4::boolean OR s.submitted_by = $2::uuid)))
          GROUP BY s.id, a.mode
       ) items ORDER BY "lastActivityAt" DESC, id DESC`,
      [projectId, user.id, this.access.today(), reviewer],
    );
    return rows as DiscussionListItem[];
  }

  async get(user: AuthUser, threadId: string, afterNo = 0): Promise<ThreadView> {
    const t = await this.threadRow(this.pool, threadId);
    const { ctx, audience } = await this.readable(this.pool, user, t);
    const messages = await this.messageViews(this.pool, user.id, 'm.thread_id = $1 AND m.message_no > $2', [t.id, afterNo], ctx.inspectDeleted === true);
    // Each Deleted message shown to a holder of Inspect Deleted Content is an opening, recorded by kind and id only.
    const at = this.now();
    for (const m of messages) {
      if (m.deletedBy === undefined) continue;
      await writeAudit(this.pool, { at, action: 'deleted.inspected', actorUserId: user.id, subjectType: 'message', subjectId: m.id, detail: { projectId: t.projectId } });
    }
    return {
      id: t.id,
      projectId: t.projectId,
      kind: t.kind,
      title: t.title,
      audience: { id: audience.id, mode: audience.mode, namedUsers: await this.people(this.pool, audience.namedUserIds), changedAt: await this.audiences.changedAt(audience.id, this.pool) },
      meetingDate: t.meetingDate,
      state: t.state,
      messages,
      aiAnswers: await threadAnswers(this.pool, ctx, t.id),
      present: await this.people(
        this.pool,
        (await this.pool.query(`SELECT user_id AS id FROM meeting_attendees WHERE thread_id = $1`, [t.id])).rows.map((r) => r.id),
      ),
      canPost: this.allowed(ctx, 'discussion.post') && t.state !== 'ended',
      canModerate: this.allowed(ctx, 'message.moderate'),
    };
  }

  /** Writes the passage index for a new message version, in the same transaction (spec 4.1). */
  private async indexMessage(db: Db, versionId: string, projectId: string, messageNo: number, authorId: string, text: string, at: Date): Promise<void> {
    const author = (await db.query(`SELECT display_name AS n FROM users WHERE id = $1`, [authorId])).rows[0].n as string;
    await indexVersion(db, 'message_version', versionId, projectId, text, { messageNo, author, at: formatMessageTime(at) });
  }

  async post(user: AuthUser, threadId: string, body: { body: unknown; replyToId?: unknown }): Promise<MessageView> {
    const messageId = await this.inTransaction(async (db) => {
      // The thread row lock keeps message numbers gap-free and in order when two people post at once.
      const t = await this.threadRow(db, threadId, true);
      await this.readable(db, user, t, true);
      await this.access.authorize(user, 'discussion.post', t.projectId, db);
      if (t.state === 'ended') throw new ConflictException(MEETING_ENDED);
      const text = cleanBody(body.body);
      refuseSecrets(text);
      let replyTo: string | null = null;
      if (body.replyToId !== undefined && body.replyToId !== null) {
        const ok =
          typeof body.replyToId === 'string' &&
          UUID.test(body.replyToId) &&
          (await db.query(`SELECT 1 FROM discussion_messages WHERE id = $1 AND thread_id = $2`, [body.replyToId, t.id])).rowCount === 1;
        if (!ok) throw new BadRequestException('Reply to a message in this thread.');
        replyTo = body.replyToId as string;
      }
      const at = this.now();
      const no = (await db.query(`SELECT next_message_no AS n FROM discussion_threads WHERE id = $1`, [t.id])).rows[0].n as number;
      await db.query(`UPDATE discussion_threads SET next_message_no = $2, last_message_at = $3 WHERE id = $1`, [t.id, no + 1, at]);
      const id = uuidv7(at.getTime());
      await db.query(
        `INSERT INTO discussion_messages (id, thread_id, message_no, author_id, reply_to_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, t.id, no, user.id, replyTo, at],
      );
      const versionId = uuidv7(at.getTime());
      await db.query(
        `INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, 1, $3, $4, $5)`,
        [versionId, id, text, sha256Hex(text), at],
      );
      await this.indexMessage(db, versionId, t.projectId, no, user.id, text, at);
      await db.query(
        `INSERT INTO discussion_events (id, thread_id, message_id, actor_id, action, detail, at) VALUES ($1, $2, $3, $4, 'posted', $5, $6)`,
        [uuidv7(at.getTime()), t.id, id, user.id, JSON.stringify(meta(text)), at],
      );
      return id;
    });
    return (await this.messageViews(this.pool, user.id, 'm.id = $1', [messageId]))[0];
  }

  /**
   * The message's thread, author and state. With `lock`, the thread row is locked first and the message row second
   * (the order `post` uses), both FOR NO KEY UPDATE so inserts that reference them (replies, events) are not blocked.
   */
  private async messageRow(db: Db, messageId: string, lock = false): Promise<{ t: ThreadRow; authorId: string; state: MessageState; heldCaseId: string | null }> {
    const found = await db.query(`SELECT thread_id AS "threadId" FROM discussion_messages WHERE id = $1`, [uuidOrNotFound(messageId)]);
    if (!found.rows[0]) throw new NotFoundException();
    const t = await this.threadRow(db, found.rows[0].threadId, lock);
    const { rows } = await db.query(
      `SELECT author_id AS "authorId", state, held_case_id AS "heldCaseId" FROM discussion_messages WHERE id = $1 ${lock ? 'FOR NO KEY UPDATE' : ''}`,
      [messageId],
    );
    return { t, authorId: rows[0].authorId, state: rows[0].state, heldCaseId: rows[0].heldCaseId };
  }

  async edit(user: AuthUser, messageId: string, body: { body: unknown; basedOnVersion: unknown }): Promise<MessageView> {
    await this.inTransaction(async (db) => {
      // The message row lock makes two edits based on the same version meet: the second sees the first and is refused.
      const m = await this.messageRow(db, messageId, true);
      await this.readable(db, user, m.t, true);
      if (m.heldCaseId) throw new ConflictException(HELD);
      if (m.authorId !== user.id) throw new ForbiddenException('Only the author can edit a message.');
      await this.access.authorize(user, 'discussion.post', m.t.projectId, db);
      if (m.t.state === 'ended') throw new ConflictException(MEETING_ENDED);
      if (m.state !== 'visible') throw new ConflictException('This message is hidden or deleted, so it cannot be edited.');
      const based = body.basedOnVersion;
      if (typeof based !== 'number' || !Number.isInteger(based) || based < 1) throw new BadRequestException('Say which version you are editing.');
      const text = cleanBody(body.body);
      refuseSecrets(text);
      const latest = (await db.query(`SELECT version_no AS v, body FROM message_versions WHERE message_id = $1 ORDER BY version_no DESC LIMIT 1`, [messageId])).rows[0];
      if (latest.v !== based) {
        const current = (await this.messageViews(db, user.id, 'm.id = $1', [messageId]))[0];
        throw new ConflictException({ statusCode: 409, message: STALE_EDIT, error: 'Conflict', current });
      }
      if (latest.body === text) throw new BadRequestException('Nothing has changed in this message.');
      const at = this.now();
      const versionId = uuidv7(at.getTime());
      await db.query(
        `INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [versionId, messageId, latest.v + 1, text, sha256Hex(text), at],
      );
      const no = (await db.query(`SELECT message_no AS n FROM discussion_messages WHERE id = $1`, [messageId])).rows[0].n as number;
      await this.indexMessage(db, versionId, m.t.projectId, no, m.authorId, text, at);
      await db.query(`UPDATE discussion_threads SET last_message_at = $2 WHERE id = $1`, [m.t.id, at]);
      await db.query(
        `INSERT INTO discussion_events (id, thread_id, message_id, actor_id, action, detail, at) VALUES ($1, $2, $3, $4, 'edited', $5, $6)`,
        [uuidv7(at.getTime()), m.t.id, messageId, user.id, JSON.stringify({ ...meta(text), version: latest.v + 1 }), at],
      );
    });
    return (await this.messageViews(this.pool, user.id, 'm.id = $1', [messageId]))[0];
  }

  private async moderate(user: AuthUser, messageId: string, action: ModerationAction, body: { reason: unknown }): Promise<MessageView> {
    await this.inTransaction(async (db) => {
      // Thread row first, then message row: the order posts and edits use, so moderation cannot deadlock with them.
      const m = await this.messageRow(db, messageId, true);
      await this.readable(db, user, m.t, true);
      if (m.heldCaseId) throw new ConflictException(HELD);
      // Deleting one's own message needs only the right to post; every other move needs the moderator's (or restorer's) action.
      if (action === 'delete' && m.authorId === user.id) await this.access.authorize(user, 'discussion.post', m.t.projectId, db);
      else await this.access.authorize(user, MODERATION[action].matrix, m.t.projectId, db);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason === '' || reason.length > 500) throw new BadRequestException(REASON_REQUIRED);
      const rule = MODERATION[action];
      if (!rule.from.includes(m.state)) throw new ConflictException(rule.refusal(m.state));
      const at = this.now();
      await db.query(
        rule.to === 'visible'
          ? `UPDATE discussion_messages SET state = 'visible', state_reason = NULL, state_by = NULL, state_at = NULL WHERE id = $1`
          : `UPDATE discussion_messages SET state = $2, state_reason = $3, state_by = $4, state_at = $5 WHERE id = $1`,
        rule.to === 'visible' ? [messageId] : [messageId, rule.to, reason, user.id, at],
      );
      await db.query(
        `INSERT INTO discussion_events (id, thread_id, message_id, actor_id, action, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv7(at.getTime()), m.t.id, messageId, user.id, rule.event, reason, at],
      );
      // AI answers and drafts built on this message (4b spec 5.5): private ones withdrawn, shared ones to review. Same
      // transaction; the thread and message rows are already locked, and the hook locks answers and drafts after them.
      // Unhiding or restoring brings nothing back.
      if (rule.to === 'hidden' || rule.to === 'deleted') await onMaterialRemoved(db, { messageIds: [messageId] }, rule.to, at);
    });
    return (await this.messageViews(this.pool, user.id, 'm.id = $1', [messageId]))[0];
  }

  hide(user: AuthUser, messageId: string, body: { reason: unknown }) {
    return this.moderate(user, messageId, 'hide', body);
  }
  unhide(user: AuthUser, messageId: string, body: { reason: unknown }) {
    return this.moderate(user, messageId, 'unhide', body);
  }
  delete(user: AuthUser, messageId: string, body: { reason: unknown }) {
    return this.moderate(user, messageId, 'delete', body);
  }
  restore(user: AuthUser, messageId: string, body: { reason: unknown }) {
    return this.moderate(user, messageId, 'restore', body);
  }

  /**
   * Earlier versions are open to anyone who can read the thread (spec 4.2). A hidden message shows its versions
   * only to its author. A deleted or held message does not exist (404) unless the viewer holds Inspect Deleted Content
   * and it is not held (history spec 4.7).
   */
  async versions(user: AuthUser, messageId: string): Promise<MessageVersionView[]> {
    const m = await this.messageRow(this.pool, messageId);
    const { ctx } = await this.readable(this.pool, user, m.t);
    const held = (await this.pool.query(`SELECT held_case_id IS NOT NULL AS held FROM discussion_messages WHERE id = $1`, [messageId])).rows[0].held as boolean;
    if (held || (m.state === 'deleted' && ctx.inspectDeleted !== true)) throw new NotFoundException();
    if (m.state === 'hidden' && m.authorId !== user.id) return [];
    const { rows } = await this.pool.query(
      `SELECT version_no AS "versionNo", body AS text, created_at AS "createdAt" FROM message_versions WHERE message_id = $1 ORDER BY version_no`,
      [messageId],
    );
    return rows as MessageVersionView[];
  }
}
