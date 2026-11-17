import { triggerLabel } from '../analysis/labels';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { effectiveRoles } from '../projects/membership';
import { NoteTextError, normaliseText, sha256Hex } from '../notes/text';
import { type Person, inAudience } from './audience';
import { refuseSecrets } from './messages';
import { MEETING_ENDED, STALE_EDIT, type ThreadRow, type ThreadView, ThreadsService } from './threads.service';

type Db = Pool | PoolClient;

/** Called once after a meeting ends (Task 10 binds the real implementation that requests the final draft). */
export interface MeetingEndHook {
  onMeetingEnded(threadId: string): Promise<void>;
}
export const MEETING_END_HOOK = Symbol('MEETING_END_HOOK');
export const NO_MEETING_END_HOOK: MeetingEndHook = { onMeetingEnded: async () => undefined };

export const MAX_MINUTES_CHARS = 100_000;
const AI_LABEL = 'AI draft — not official minutes';
const MAX_PRESENT = 500;

export interface DraftView {
  id: string;
  versionNo: number;
  origin: 'ai' | 'human';
  body: string;
  coversThroughNo: number;
  createdAt: Date;
  author: Person | null;
  editedFromVersion: number | null;
  label: string;
}

export interface MinutesVersionSummary {
  versionNo: number;
  origin: 'ai' | 'human';
  author: Person | null;
  trigger: string | null;
  createdAt: Date;
  coversThroughNo: number;
}

export interface MinutesView {
  current: DraftView | null;
  versions: MinutesVersionSummary[];
  hasHumanVersion: boolean;
  canEdit: boolean;
  canPublish: boolean;
}

const meta = (text: string) => ({ length: text.length, sha256: sha256Hex(text) });

const DRAFT_SELECT = `SELECT d.id, d.version_no AS "versionNo", d.origin, d.body, d.covers_through_no AS "coversThroughNo", d.created_at AS "createdAt",
       d.created_by AS "authorId", u.display_name AS "authorName", f.version_no AS "editedFromVersion", r.trigger AS "trigger",
       ru.display_name AS "requesterName"
  FROM minutes_drafts d
  LEFT JOIN users u ON u.id = d.created_by
  LEFT JOIN minutes_drafts f ON f.id = d.edited_from_id
  LEFT JOIN analysis_runs r ON r.id = d.analysis_run_id
  LEFT JOIN users ru ON ru.id = r.requested_by`;

function draftView(r: Record<string, any>): DraftView {
  const author = r.authorId ? { id: r.authorId as string, displayName: r.authorName as string } : null;
  return {
    id: r.id,
    versionNo: r.versionNo,
    origin: r.origin,
    body: r.body,
    coversThroughNo: r.coversThroughNo,
    createdAt: r.createdAt,
    author,
    editedFromVersion: r.editedFromVersion ?? null,
    label: r.origin === 'human' && author ? `${AI_LABEL} · Edited by ${author.displayName}` : AI_LABEL,
  };
}

/**
 * Stores an AI draft as the next version of a meeting's minutes. Standalone because the worker builds plain
 * classes without Nest. It locks the thread row (FOR NO KEY UPDATE, like every write path) before reading the
 * newest version number, so it queues behind a concurrent minutes save instead of colliding on the unique key.
 * Given a Pool it runs in its own transaction; given a client it joins the caller's (re-taking the lock is harmless).
 */
export async function insertAiDraft(
  db: Db,
  threadId: string,
  input: { body: string; coversThroughNo: number; analysisRunId: string },
  now: () => Date = () => new Date(),
): Promise<DraftView> {
  if (db instanceof Pool) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const view = await insertAiDraft(client, threadId, input, now);
      await client.query('COMMIT');
      return view;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  await db.query(`SELECT 1 FROM discussion_threads WHERE id = $1 FOR NO KEY UPDATE`, [threadId]);
  const at = now();
  const next = Number((await db.query(`SELECT COALESCE(max(version_no), 0) + 1 AS n FROM minutes_drafts WHERE thread_id = $1`, [threadId])).rows[0].n);
  await db.query(
    `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, analysis_run_id, created_at)
     VALUES ($1, $2, $3, 'ai', $4, $5, $6, $7)`,
    [uuidv7(at.getTime()), threadId, next, input.body, input.coversThroughNo, input.analysisRunId, at],
  );
  return draftView((await db.query(`${DRAFT_SELECT} WHERE d.thread_id = $1 AND d.version_no = $2`, [threadId, next])).rows[0]);
}

/** Typed meetings: the Present list, ending, and draft minutes versions (spec 5.1, 5.2). */
@Injectable()
export class MeetingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(MEETING_END_HOOK) private readonly endHook: MeetingEndHook,
    private readonly access: ProjectAccess,
    private readonly threads: ThreadsService,
  ) {}

  /** A meeting row; a discussion has no Present list, end or minutes (404). */
  private async meeting(db: Db, threadId: string, lock = false): Promise<ThreadRow> {
    const t = await this.threads.threadRow(db, threadId, lock);
    if (t.kind !== 'meeting') throw new NotFoundException();
    return t;
  }

  private async isStarter(db: Db, user: AuthUser, t: ThreadRow): Promise<boolean> {
    return (await db.query(`SELECT created_by FROM discussion_threads WHERE id = $1`, [t.id])).rows[0].created_by === user.id;
  }

  /** The starter (who needs the right to post), or a role holding `minutes.publish`; the project state is checked too. */
  private async authorizeMinutesManager(db: Db, user: AuthUser, t: ThreadRow): Promise<void> {
    await this.access.authorize(user, (await this.isStarter(db, user, t)) ? 'discussion.post' : 'minutes.publish', t.projectId, db);
  }

  async setPresent(user: AuthUser, threadId: string, body: { userIds: unknown }): Promise<Person[]> {
    await this.threads.inTransaction(async (db) => {
      const t = await this.meeting(db, threadId, true);
      const { ctx, audience } = await this.threads.readable(db, user, t, true);
      await this.access.authorize(user, 'discussion.post', t.projectId, db);
      if (t.state === 'ended') throw new ConflictException(MEETING_ENDED);
      const raw = body.userIds;
      if (!Array.isArray(raw) || raw.length > MAX_PRESENT || !raw.every((x) => typeof x === 'string' && UUID.test(x))) {
        throw new BadRequestException('Give the Present list as a list of people.');
      }
      const wanted = [...new Set(raw as string[])];
      for (const id of wanted) {
        // A participant holds an active role; a grant holder is not one. The audience test is the one reading uses.
        const roles = effectiveRoles(ctx.rows, id, ctx.today);
        const them: ProjectContext = { ...ctx, roles, viewerId: id, isAdmin: false, grantKinds: [] };
        if (roles.length === 0 || !inAudience(them, audience)) {
          throw new BadRequestException('Only current project participants who can read this meeting can be marked present.');
        }
      }
      const before = (await db.query(`SELECT user_id AS id FROM meeting_attendees WHERE thread_id = $1`, [t.id])).rows.map((r) => r.id as string);
      const added = wanted.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !wanted.includes(id));
      if (added.length === 0 && removed.length === 0) return;
      const at = this.now();
      if (removed.length) await db.query(`DELETE FROM meeting_attendees WHERE thread_id = $1 AND user_id = ANY($2::uuid[])`, [t.id, removed]);
      for (const id of added) {
        await db.query(`INSERT INTO meeting_attendees (thread_id, user_id, marked_by, marked_at) VALUES ($1, $2, $3, $4)`, [t.id, id, user.id, at]);
      }
      await db.query(
        `INSERT INTO discussion_events (id, thread_id, actor_id, action, detail, at) VALUES ($1, $2, $3, 'present_changed', $4, $5)`,
        [uuidv7(at.getTime()), t.id, user.id, JSON.stringify({ added, removed }), at],
      );
    });
    const { rows } = await this.pool.query(`SELECT user_id AS id FROM meeting_attendees WHERE thread_id = $1`, [threadId]);
    return this.threads.people(this.pool, rows.map((r) => r.id));
  }

  async end(user: AuthUser, threadId: string): Promise<ThreadView> {
    await this.threads.inTransaction(async (db) => {
      const t = await this.meeting(db, threadId, true);
      await this.threads.readable(db, user, t, true);
      await this.authorizeMinutesManager(db, user, t);
      if (t.state === 'ended') throw new ConflictException(MEETING_ENDED);
      const at = this.now();
      await db.query(`UPDATE discussion_threads SET state = 'ended', ended_by = $2, ended_at = $3 WHERE id = $1`, [t.id, user.id, at]);
      await db.query(`INSERT INTO discussion_events (id, thread_id, actor_id, action, at) VALUES ($1, $2, $3, 'meeting_ended', $4)`, [
        uuidv7(at.getTime()),
        t.id,
        user.id,
        at,
      ]);
    });
    try {
      await this.endHook.onMeetingEnded(threadId);
    } catch {
      // The meeting has ended; a failed request for the final draft must not undo that. The Draft minutes button still works.
      new Logger('Meetings').warn('Could not request the final draft after a meeting ended');
    }
    return this.threads.get(user, threadId);
  }

  async minutes(user: AuthUser, threadId: string): Promise<MinutesView> {
    const t = await this.meeting(this.pool, threadId);
    const { ctx } = await this.threads.readable(this.pool, user, t);
    const { rows } = await this.pool.query(`${DRAFT_SELECT} WHERE d.thread_id = $1 ORDER BY d.version_no DESC`, [t.id]);
    const publish = this.threads.allowed(ctx, 'minutes.publish');
    const starter = await this.isStarter(this.pool, user, t);
    return {
      current: rows[0] ? draftView(rows[0]) : null,
      versions: rows.map((r) => {
        const v = draftView(r);
        return { versionNo: v.versionNo, origin: v.origin, author: v.author, trigger: r.trigger ?? null, label: r.origin === 'ai' ? triggerLabel(r.trigger ?? null, r.requesterName ?? null) : (v.author?.displayName ?? null), createdAt: v.createdAt, coversThroughNo: v.coversThroughNo };
      }),
      hasHumanVersion: rows.some((r) => r.origin === 'human'),
      canEdit: publish || (starter && this.threads.allowed(ctx, 'discussion.post')),
      canPublish: publish,
    };
  }

  async minutesVersion(user: AuthUser, threadId: string, versionNo: number): Promise<DraftView> {
    const t = await this.meeting(this.pool, threadId);
    await this.threads.readable(this.pool, user, t);
    const { rows } = await this.pool.query(`${DRAFT_SELECT} WHERE d.thread_id = $1 AND d.version_no = $2`, [t.id, versionNo]);
    if (!rows[0]) throw new NotFoundException();
    return draftView(rows[0]);
  }

  async saveMinutes(user: AuthUser, threadId: string, body: { body: unknown; basedOnVersion: unknown }): Promise<DraftView> {
    const versionNo = await this.threads.inTransaction(async (db) => {
      // Thread row first (the order every write path uses); then the newest draft is compared with the version the editor opened.
      const t = await this.meeting(db, threadId, true);
      await this.threads.readable(db, user, t, true);
      await this.authorizeMinutesManager(db, user, t);
      const based = body.basedOnVersion;
      if (typeof based !== 'number' || !Number.isInteger(based) || based < 0) throw new BadRequestException('Say which version you are editing (0 when there is no draft yet).');
      if (typeof body.body !== 'string') throw new BadRequestException('Write the minutes (1 to 100,000 characters).');
      let text: string;
      try {
        text = normaliseText(body.body);
      } catch (err) {
        if (err instanceof NoteTextError) throw new BadRequestException(err.message === 'The text is empty.' ? 'The minutes are empty.' : err.message);
        throw err;
      }
      if (text.length > MAX_MINUTES_CHARS) throw new BadRequestException(`The minutes are longer than ${MAX_MINUTES_CHARS.toLocaleString('en-US')} characters.`);
      refuseSecrets(text);
      const newest = (await db.query(`SELECT id, version_no AS v, body, covers_through_no AS covers FROM minutes_drafts WHERE thread_id = $1 ORDER BY version_no DESC LIMIT 1`, [t.id])).rows[0];
      const newestNo: number = newest ? newest.v : 0;
      if (newestNo !== based) {
        const current = newest ? draftView((await db.query(`${DRAFT_SELECT} WHERE d.id = $1`, [newest.id])).rows[0]) : null;
        throw new ConflictException({ statusCode: 409, message: STALE_EDIT, error: 'Conflict', current });
      }
      if (newest && newest.body === text) throw new BadRequestException('Nothing has changed in these minutes.');
      const at = this.now();
      const id = uuidv7(at.getTime());
      // A person's version covers what the draft it came from covered (nothing, when written from scratch): it never saw later messages.
      const covers: number = newest ? newest.covers : 0;
      await db.query(
        `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, edited_from_id, created_by, created_at)
         VALUES ($1, $2, $3, 'human', $4, $5, $6, $7, $8)`,
        [id, t.id, newestNo + 1, text, covers, newest ? newest.id : null, user.id, at],
      );
      await db.query(
        `INSERT INTO discussion_events (id, thread_id, draft_id, actor_id, action, detail, at) VALUES ($1, $2, $3, $4, 'minutes_edited', $5, $6)`,
        [uuidv7(at.getTime()), t.id, id, user.id, JSON.stringify({ ...meta(text), version: newestNo + 1 }), at],
      );
      return newestNo + 1;
    });
    return this.minutesVersion(user, threadId, versionNo);
  }

  /** For callers that hold the Nest-built service; the worker uses the standalone function. */
  insertAiDraft(db: Db, threadId: string, input: { body: string; coversThroughNo: number; analysisRunId: string }): Promise<DraftView> {
    return insertAiDraft(db, threadId, input, this.now);
  }
}
