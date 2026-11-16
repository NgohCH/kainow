import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ExtractionService } from '../extraction/extraction.service';
import { type NewContent, NotesService, type SourceSummary } from '../notes/notes.service';
import { sha256Hex } from '../notes/text';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { refuseUnliveSource } from '../history/deleted-sql';
import { effectiveRoles } from '../projects/membership';
import { RESTRICTED_ROLES, parseAudienceChange } from './audience';
import { AudienceService } from './audience.service';
import { AUTOMATIC_ANALYSIS, type AutomaticAnalysis } from './automatic-analysis';
import { refuseSecrets } from './messages';
import { ThreadsService } from './threads.service';

export const MEETING_STILL_OPEN = 'The meeting is still open; later messages are not in these minutes';

export interface PublishResult {
  sourceId: string;
  versionNo: number;
  extractionRunId: string | null;
  /** Set when the meeting is still open, so the screen can say later messages are not in these minutes. */
  notice: string | null;
}

const REASON_REQUIRED = 'A reason is required (up to 500 characters).';

/** Publishing meeting minutes, member submissions and their review (spec 5.3, 5.4). */
@Injectable()
export class PublishingService {
  private readonly log = new Logger('Publishing');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(AUTOMATIC_ANALYSIS) private readonly automatic: AutomaticAnalysis,
    private readonly access: ProjectAccess,
    private readonly threads: ThreadsService,
    private readonly audiences: AudienceService,
    private readonly notes: NotesService,
    private readonly extraction: ExtractionService,
  ) {}

  private async meeting(db: PoolClient, threadId: string) {
    const t = await this.threads.threadRow(db, threadId, true);
    if (t.kind !== 'meeting') throw new NotFoundException();
    return t;
  }

  private async draftOf(db: PoolClient, threadId: string, versionNo: number) {
    const { rows } = await db.query(`SELECT id, body, version_no AS "versionNo" FROM minutes_drafts WHERE thread_id = $1 AND version_no = $2`, [threadId, versionNo]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0] as { id: string; body: string; versionNo: number };
  }

  /** People who hold PM, Deputy, Owner or Sponsor today, other than `except`. */
  private reviewers(ctx: ProjectContext, except: string): string[] {
    const ids = new Set(ctx.rows.map((r) => r.userId));
    return [...ids].filter((id) => id !== except && effectiveRoles(ctx.rows, id, ctx.today).some((r) => RESTRICTED_ROLES.includes(r)));
  }

  /** In-app notices with the title only, never the text (spec 4.5). */
  private async notify(db: PoolClient, projectId: string, userIds: string[], kind: string, summary: string, link: string, at: Date): Promise<void> {
    for (const userId of userIds) {
      await db.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, summary, link, created_at, email_off)
         VALUES ($1, $2, $3, $4, $5, $6, $7, EXISTS (SELECT 1 FROM email_preferences WHERE user_id = $2 AND project_id = $3 AND choice = 'off'))`,
        [uuidv7(at.getTime()), userId, projectId, kind, summary, link, at],
      );
    }
  }

  /** Asks for the automatic extraction of a newly published version when the project has it on. A failure never undoes publication. */
  private async automaticExtraction(projectId: string, versionId: string): Promise<string | null> {
    try {
      if (!(await this.automatic.isOn(projectId))) return null;
      return await this.extraction.requestAutomatic(versionId, 'minutes_published');
    } catch {
      this.log.warn('Could not request the automatic extraction after publishing; Run extraction still works');
      return null;
    }
  }

  async publishDraft(user: AuthUser, threadId: string, versionNo: number): Promise<PublishResult> {
    const done = await this.threads.inTransaction(async (db) => {
      // Thread row first, as every write path does; then the meeting's minutes source.
      const t = await this.meeting(db, threadId);
      await this.threads.readable(db, user, t);
      await this.access.authorize(user, 'minutes.publish', t.projectId, db);
      const draft = await this.draftOf(db, t.id, versionNo);
      // Every version added is checked for credentials (D79), the AI's draft included; only the kind is named.
      refuseSecrets(draft.body);
      const at = this.now();
      const existing = (
        await db.query(`SELECT id, publication, status, held_case_id AS "heldCaseId" FROM sources WHERE thread_id = $1 AND kind = 'minutes' FOR UPDATE`, [t.id])
      ).rows[0] as { id: string; publication: string; status: string; heldCaseId: string | null } | undefined;
      // Deleted minutes are not published into (404 until restored); held ones are refused until the case is released.
      if (existing) refuseUnliveSource(existing);
      let sourceId: string;
      if (existing) {
        sourceId = existing.id;
        // A reviewer publishing a draft settles any member submission for this meeting.
        await db.query(`UPDATE sources SET publication = 'published', returned_reason = NULL WHERE id = $1`, [sourceId]);
      } else {
        sourceId = uuidv7(at.getTime());
        await db.query(
          `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id, publication)
           VALUES ($1, $2, $3, $4, $5, 'minutes', $6, $7, 'published')`,
          [sourceId, t.title, user.id, at, t.projectId, t.audienceId, t.id],
        );
      }
      // A submission already holding exactly this text is simply published: no new version (and no 409).
      const same = existing && existing.publication !== 'published'
        ? (await db.query(
            `SELECT id, version_no AS "versionNo", char_count AS "charCount", text_sha256 AS "textSha256" FROM source_versions
              WHERE source_id = $1 ORDER BY version_no DESC LIMIT 1`,
            [sourceId],
          )).rows[0]
        : undefined;
      const version =
        same && same.textSha256 === sha256Hex(draft.body)
          ? (same as { id: string; versionNo: number; charCount: number; textSha256: string })
          : await this.notes.addVersionText(db, sourceId, draft.body, user.id, at, { minutesDraftId: draft.id });
      await db.query(
        `INSERT INTO discussion_events (id, thread_id, draft_id, actor_id, action, detail, at) VALUES ($1, $2, $3, $4, 'minutes_published', $5, $6)`,
        [uuidv7(at.getTime()), t.id, draft.id, user.id, JSON.stringify({ sourceId, versionNo: version.versionNo, draftVersion: draft.versionNo, meetingOpen: t.state === 'open' }), at],
      );
      await writeAudit(db, {
        at,
        action: 'minutes.published',
        actorUserId: user.id,
        subjectType: 'source',
        subjectId: sourceId,
        detail: { versionNo: version.versionNo, versionId: version.id, draftVersion: draft.versionNo, charCount: version.charCount, textSha256: version.textSha256 },
      });
      return { sourceId, version, projectId: t.projectId, open: t.state === 'open' };
    });
    return {
      sourceId: done.sourceId,
      versionNo: done.version.versionNo,
      extractionRunId: await this.automaticExtraction(done.projectId, done.version.id),
      notice: done.open ? MEETING_STILL_OPEN : null,
    };
  }

  private intendedMode(raw: unknown): 'project' | 'restricted' {
    if (raw !== 'project' && raw !== 'restricted') throw new BadRequestException('Say which audience you propose: Project-wide or Restricted.');
    return raw;
  }

  /** A member's notes by paste or upload, waiting for a reviewer (spec 5.4). */
  async submit(user: AuthUser, projectId: string, content: NewContent, body: { title?: unknown; intendedMode: unknown }): Promise<SourceSummary> {
    const ctx = await this.access.authorize(user, 'notes.submit', projectId);
    const intendedMode = this.intendedMode(body.intendedMode);
    const { source } = await this.notes.createSource({
      projectId,
      title: body.title,
      content,
      actorUserId: user.id,
      submission: {
        submittedBy: user.id,
        intendedMode,
        refuse: refuseSecrets,
        after: (db, src, at) => this.notify(db, projectId, this.reviewers(ctx, user.id), 'minutes_submitted', `Minutes submitted for review: ${src.title}`, `#/notes/${src.id}`, at),
      },
    });
    return source;
  }

  /** The Member path from a meeting: the starter submits one draft version of their meeting's minutes. */
  async submitDraft(user: AuthUser, threadId: string, versionNo: number): Promise<SourceSummary> {
    return this.threads.inTransaction(async (db) => {
      const t = await this.meeting(db, threadId);
      const { ctx } = await this.threads.readable(db, user, t);
      await this.access.authorize(user, 'notes.submit', t.projectId, db);
      const starter = (await db.query(`SELECT created_by FROM discussion_threads WHERE id = $1`, [t.id])).rows[0].created_by;
      if (starter !== user.id) throw new ForbiddenException('Only the person who started the meeting can submit its minutes.');
      const draft = await this.draftOf(db, t.id, versionNo);
      refuseSecrets(draft.body);
      const at = this.now();
      const existing = (
        await db.query(
          `SELECT id, publication, submitted_by AS "submittedBy", status, held_case_id AS "heldCaseId" FROM sources WHERE thread_id = $1 AND kind = 'minutes' FOR UPDATE`,
          [t.id],
        )
      ).rows[0];
      if (existing) refuseUnliveSource(existing);
      let sourceId: string;
      if (!existing) {
        sourceId = uuidv7(at.getTime());
        const mode = (await this.audiences.load(t.audienceId, db)).mode;
        await db.query(
          `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id, publication, submitted_by, intended_mode)
           VALUES ($1, $2, $3, $4, $5, 'minutes', $6, $7, 'submitted', $3, $8)`,
          [sourceId, t.title, user.id, at, t.projectId, t.audienceId, t.id, mode],
        );
      } else if (existing.publication === 'returned' && existing.submittedBy === user.id) {
        sourceId = existing.id;
        await db.query(`UPDATE sources SET publication = 'submitted', returned_reason = NULL WHERE id = $1`, [sourceId]);
      } else {
        throw new ConflictException(existing.publication === 'published' ? 'Minutes for this meeting are already published.' : 'Minutes for this meeting are already with a reviewer.');
      }
      const version = await this.notes.addVersionText(db, sourceId, draft.body, user.id, at, { minutesDraftId: draft.id });
      await this.notify(db, t.projectId, this.reviewers(ctx, user.id), 'minutes_submitted', `Minutes submitted for review: ${t.title}`, `#/notes/${sourceId}`, at);
      await writeAudit(db, {
        at,
        action: 'note.submitted',
        actorUserId: user.id,
        subjectType: 'source',
        subjectId: sourceId,
        detail: { versionNo: version.versionNo, versionId: version.id, draftVersion: draft.versionNo, charCount: version.charCount, textSha256: version.textSha256 },
      });
      return { id: sourceId, title: t.title, createdAt: at, latestVersion: version.versionNo, versionCount: version.versionNo };
    });
  }

  /** A submission the person may see, locked, in the order every path uses (its thread first, then the source). */
  private async lockedSubmission(db: PoolClient, user: AuthUser, sourceId: string) {
    const { row } = await this.audiences.assertSourceReadable(user, sourceId, db);
    if (row.kind === 'discussion') throw new NotFoundException();
    const thread = (await db.query(`SELECT thread_id AS "threadId" FROM sources WHERE id = $1`, [sourceId])).rows[0].threadId as string | null;
    if (thread) await this.threads.threadRow(db, thread, true);
    const { rows } = await db.query(
      `SELECT id, title, project_id AS "projectId", thread_id AS "threadId", publication, submitted_by AS "submittedBy", intended_mode AS "intendedMode",
              status, held_case_id AS "heldCaseId"
         FROM sources WHERE id = $1 FOR UPDATE`,
      [sourceId],
    );
    // A Deleted submission is neither published nor returned (404); a held one waits for its case (409).
    refuseUnliveSource(rows[0]);
    return rows[0] as { id: string; title: string; projectId: string; threadId: string | null; publication: string; submittedBy: string | null; intendedMode: string | null };
  }

  /** A reviewer publishes a submission, choosing its final audience, and automatic extraction follows (spec 5.4, 5.3). */
  async publishSubmission(user: AuthUser, sourceId: string, body: { audience: unknown }): Promise<PublishResult> {
    const done = await this.threads.inTransaction(async (db) => {
      const src = await this.lockedSubmission(db, user, sourceId);
      await this.access.authorize(user, 'minutes.publish', src.projectId, db);
      if (src.publication !== 'submitted') throw new ConflictException('Only a submission waiting for review can be published.');
      const at = this.now();
      let audienceId: string | null = null;
      if (src.threadId) {
        // Minutes from a meeting share the meeting's audience row; changing it is done on the meeting.
        if (body.audience !== undefined) throw new BadRequestException("These minutes share their meeting's audience; change it on the meeting.");
      } else {
        if (body.audience === undefined) throw new BadRequestException('Choose the audience: Project-wide or Restricted.');
        const change = parseAudienceChange(body.audience);
        if (change.mode === 'restricted') await this.access.authorize(user, 'meeting.restricted', src.projectId, db);
        audienceId = await this.audiences.create(db, src.projectId, change, user);
      }
      await db.query(`UPDATE sources SET publication = 'published', returned_reason = NULL${audienceId ? ', audience_id = $2' : ''} WHERE id = $1`, audienceId ? [sourceId, audienceId] : [sourceId]);
      const version = (await db.query(`SELECT id, version_no AS "versionNo" FROM source_versions WHERE source_id = $1 ORDER BY version_no DESC LIMIT 1`, [sourceId])).rows[0];
      if (src.threadId) {
        await db.query(`INSERT INTO discussion_events (id, thread_id, actor_id, action, detail, at) VALUES ($1, $2, $3, 'minutes_published', $4, $5)`, [
          uuidv7(at.getTime()), src.threadId, user.id, JSON.stringify({ sourceId, versionNo: version.versionNo, viaSubmission: true }), at,
        ]);
      }
      await writeAudit(db, { at, action: 'note.published', actorUserId: user.id, subjectType: 'source', subjectId: sourceId, detail: { versionNo: version.versionNo, submittedBy: src.submittedBy } });
      return { src, version };
    });
    return {
      sourceId,
      versionNo: done.version.versionNo,
      extractionRunId: await this.automaticExtraction(done.src.projectId, done.version.id),
      notice: null,
    };
  }

  /** A reviewer returns a submission with a reason; the submitter is told and keeps seeing it. */
  async returnSubmission(user: AuthUser, sourceId: string, body: { reason: unknown }): Promise<{ id: string; publication: 'returned' }> {
    return this.threads.inTransaction(async (db) => {
      const src = await this.lockedSubmission(db, user, sourceId);
      await this.access.authorize(user, 'minutes.publish', src.projectId, db);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason === '' || reason.length > 500) throw new BadRequestException(REASON_REQUIRED);
      if (src.publication !== 'submitted') throw new ConflictException('Only a submission waiting for review can be returned.');
      const at = this.now();
      await db.query(`UPDATE sources SET publication = 'returned', returned_reason = $2 WHERE id = $1`, [sourceId, reason]);
      if (src.threadId) {
        await db.query(`INSERT INTO discussion_events (id, thread_id, actor_id, action, reason, detail, at) VALUES ($1, $2, $3, 'submission_returned', $4, $5, $6)`, [
          uuidv7(at.getTime()), src.threadId, user.id, reason, JSON.stringify({ sourceId }), at,
        ]);
      }
      if (src.submittedBy) await this.notify(db, src.projectId, [src.submittedBy], 'minutes_returned', `Minutes returned: ${src.title}`, `#/notes/${sourceId}`, at);
      await writeAudit(db, { at, action: 'note.returned', actorUserId: user.id, subjectType: 'source', subjectId: sourceId, detail: { reasonLength: reason.length, reasonSha256: sha256Hex(reason) } });
      return { id: sourceId, publication: 'returned' as const };
    });
  }
}
