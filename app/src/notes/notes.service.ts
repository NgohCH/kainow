import { maskedVersionText } from '../discussion/masking';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { RESTRICTED_ROLES, audienceVisibleSql } from '../discussion/audience';
import { refuseSecrets } from '../discussion/messages';
import { effectiveRoles } from '../projects/membership';
import { ProjectAccess } from '../projects/access.service';
import { summaryShownSql } from '../assist/material';
import { indexVersion } from '../assist/passage-index';
import { UploadRejected, readUpload } from './readers';
import { NoteTextError, normaliseText, sha256Hex } from './text';

export interface NewContent {
  /** Pasted text. Exactly one of text or file is given. */
  text?: unknown;
  file?: { originalname: string; buffer: Buffer };
}

interface Prepared {
  origin: 'paste' | 'upload' | 'meeting' | 'summary';
  text: string;
  filename: string | null;
  mediaType: string | null;
  original: Buffer | null;
}

export interface SummaryLabels {
  label: string;
  approved: string | null;
  from: string;
}

export interface SourceSummary {
  id: string;
  title: string;
  createdAt: Date;
  latestVersion: number;
  versionCount: number;
}

/**
 * One line of a project's notes list: published notes, minutes published from a meeting, and approved shareable
 * summaries (each of the last two labelled as such).
 */
export interface ListedSource extends SourceSummary {
  kind: 'notes' | 'minutes' | 'summary';
  label: string | null;
}

export const MINUTES_LABEL = 'Minutes — from meeting';
/** A `summary` source in lists (AI assist spec 7.2). */
export const SUMMARY_LIST_LABEL = 'Shareable summary';
export const SUMMARY_APPROVED_LABEL = 'Summary approved for sharing';
export const FROM_RESTRICTED_LABEL = 'From a restricted source';

/** What a plain-notes submission adds to creating a source (spec 5.4). */
export interface SubmissionInput {
  submittedBy: string;
  intendedMode: 'project' | 'restricted';
  /** Throws to refuse the extracted text before anything is stored. */
  refuse(text: string): void;
  /** Runs in the same transaction, after the source is stored. */
  after(client: PoolClient, source: { id: string; title: string }, at: Date): Promise<void>;
}

export interface VersionSummary {
  id: string;
  sourceId: string;
  versionNo: number;
  origin: 'paste' | 'upload' | 'meeting' | 'discussion' | 'summary';
  filename: string | null;
  mediaType: string | null;
  charCount: number;
  textSha256: string;
  originalSha256: string | null;
  createdAt: Date;
}

const VERSION_COLUMNS = `id, source_id AS "sourceId", version_no AS "versionNo", origin, filename, media_type AS "mediaType",
  char_count AS "charCount", text_sha256 AS "textSha256", original_sha256 AS "originalSha256", created_at AS "createdAt"`;

/** Browsers send multipart filenames as Latin-1 bytes of the UTF-8 name; undo that, then strip anything unsafe. */
export function cleanFilename(raw: string): string {
  let name = Buffer.from(raw, 'latin1').toString('utf8');
  if (name.includes('�')) name = raw;
  name = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return name.slice(0, 200) || 'upload';
}

@Injectable()
export class NotesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  private async prepare(content: NewContent): Promise<Prepared> {
    const hasText = content.text !== undefined;
    if (hasText === Boolean(content.file)) {
      throw new BadRequestException('Send either pasted text or one file, not both and not neither');
    }
    try {
      if (content.file) {
        const filename = cleanFilename(content.file.originalname);
        const read = await readUpload(filename, content.file.buffer);
        return { origin: 'upload', text: read.text, filename, mediaType: read.mediaType, original: content.file.buffer };
      }
      if (typeof content.text !== 'string') {
        throw new BadRequestException('text must be a string');
      }
      return { origin: 'paste', text: normaliseText(content.text), filename: null, mediaType: null, original: null };
    } catch (err) {
      if (err instanceof UploadRejected || err instanceof NoteTextError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  private checkTitle(title: unknown): string {
    if (typeof title !== 'string' || title.trim() === '' || title.trim().length > 200) {
      throw new BadRequestException('A title of 1 to 200 characters is required');
    }
    return title.trim();
  }

  async createSource(input: {
    projectId: string;
    title?: unknown;
    content: NewContent;
    actorUserId: string;
    submission?: SubmissionInput;
  }): Promise<{ source: SourceSummary; version: VersionSummary }> {
    const prepared = await this.prepare(input.content);
    input.submission?.refuse(prepared.text);
    const title = this.checkTitle(input.title ?? (prepared.filename ? prepared.filename.replace(/\.[^.]*$/, '') || prepared.filename : undefined));
    const at = this.now();
    const sourceId = uuidv7(at.getTime());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The database gives a plain note its own Project-wide audience; a submission gets its real one when published.
      await client.query(
        `INSERT INTO sources (id, title, created_by, created_at, project_id, publication, submitted_by, intended_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sourceId, title, input.actorUserId, at, input.projectId, input.submission ? 'submitted' : 'published', input.submission?.submittedBy ?? null, input.submission?.intendedMode ?? null],
      );
      const version = await this.insertVersion(client, sourceId, 1, prepared, input.actorUserId, at);
      await input.submission?.after(client, { id: sourceId, title }, at);
      await writeAudit(client, {
        at,
        action: input.submission ? 'note.submitted' : 'note.created',
        actorUserId: input.actorUserId,
        subjectType: 'source',
        subjectId: sourceId,
        detail: this.auditDetail(version, prepared),
      });
      await client.query('COMMIT');
      return { source: { id: sourceId, title, createdAt: at, latestVersion: 1, versionCount: 1 }, version };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async addVersion(sourceId: string, content: NewContent, actorUserId: string): Promise<VersionSummary> {
    const prepared = await this.prepare(content);
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The source row is the lock that keeps version numbers gap-free when two people add at once.
      const src = await client.query<{ kind: string; publication: string; submittedBy: string | null; projectId: string; title: string }>(
        'SELECT kind, publication, submitted_by AS "submittedBy", project_id AS "projectId", title FROM sources WHERE id = $1 AND status = \'active\' FOR UPDATE',
        [sourceId],
      );
      if (src.rowCount === 0) throw new NotFoundException();
      const row = src.rows[0];
      if (row.kind === 'summary') throw new ConflictException('A shareable summary gets a new version only when a new version of the summary is approved.');
      if (row.kind !== 'notes') throw new ConflictException('Minutes get a new version by publishing a draft from the meeting.');
      // A returned submission is revised by its submitter alone, and goes back to the reviewers.
      const revising = row.publication === 'returned' && row.submittedBy === actorUserId;
      if (row.publication !== 'published' && !revising) throw new ConflictException('This submission is waiting for a reviewer; publish or return it first.');
      if (revising) refuseSecrets(prepared.text);
      const latest = await client.query<{ version_no: number; text_sha256: string }>(
        'SELECT version_no, text_sha256 FROM source_versions WHERE source_id = $1 ORDER BY version_no DESC LIMIT 1',
        [sourceId],
      );
      if (latest.rows[0]?.text_sha256 === sha256Hex(prepared.text)) {
        throw new ConflictException('This text is identical to the latest version, so no new version was made');
      }
      const versionNo = (latest.rows[0]?.version_no ?? 0) + 1;
      const version = await this.insertVersion(client, sourceId, versionNo, prepared, actorUserId, at);
      if (revising) {
        await client.query(`UPDATE sources SET publication = 'submitted', returned_reason = NULL WHERE id = $1`, [sourceId]);
        await this.notifyReviewers(client, row.projectId, actorUserId, `Minutes submitted for review: ${row.title}`, `#/notes/${sourceId}`, at);
      }
      await writeAudit(client, {
        at,
        action: revising ? 'note.resubmitted' : 'note.version_added',
        actorUserId,
        subjectType: 'source',
        subjectId: sourceId,
        detail: this.auditDetail(version, prepared),
      });
      await client.query('COMMIT');
      return version;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Tells everyone holding PM, Deputy, Owner or Sponsor today (except the actor) that minutes await review. Titles only. */
  private async notifyReviewers(client: PoolClient, projectId: string, actorId: string, summary: string, link: string, at: Date): Promise<void> {
    // Only the memberships and today's date are used from the context, so the viewer is irrelevant.
    const ctx = await this.access.load(projectId, { id: actorId, role: 'member' } as AuthUser, client);
    if (!ctx) return;
    const ids = [...new Set(ctx.rows.map((r) => r.userId))].filter(
      (id) => id !== actorId && effectiveRoles(ctx.rows, id, ctx.today).some((r) => RESTRICTED_ROLES.includes(r)),
    );
    for (const userId of ids) {
      await client.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, summary, link, created_at, email_off)
         VALUES ($1, $2, $3, 'minutes_submitted', $4, $5, $6, EXISTS (SELECT 1 FROM email_preferences WHERE user_id = $2 AND project_id = $3 AND choice = 'off'))`,
        [uuidv7(at.getTime()), userId, projectId, summary, link, at],
      );
    }
  }

  /**
   * Adds text as the next version of a source the caller has already locked (FOR UPDATE) inside `client`'s
   * transaction, so numbers stay gap-free. Refuses text identical to the newest version (409). With a minutes draft
   * the version's origin is `meeting`; for an approved shareable summary it is `summary`; otherwise it is a paste.
   * The version's passages are indexed in the same transaction. The caller writes the audit event.
   */
  async addVersionText(
    client: PoolClient,
    sourceId: string,
    text: string,
    actorId: string,
    at: Date,
    extra: { minutesDraftId?: string; summary?: boolean } = {},
  ): Promise<VersionSummary> {
    const latest = await client.query<{ version_no: number; text_sha256: string }>(
      'SELECT version_no, text_sha256 FROM source_versions WHERE source_id = $1 ORDER BY version_no DESC LIMIT 1',
      [sourceId],
    );
    if (latest.rows[0]?.text_sha256 === sha256Hex(text)) {
      throw new ConflictException('This text is identical to the latest version, so no new version was made');
    }
    const prepared: Prepared = { origin: extra.minutesDraftId ? 'meeting' : extra.summary ? 'summary' : 'paste', text, filename: null, mediaType: null, original: null };
    return this.insertVersion(client, sourceId, (latest.rows[0]?.version_no ?? 0) + 1, prepared, actorId, at, extra.minutesDraftId ?? null);
  }

  /** Metadata and hashes only. The note text is never written to the audit trail. */
  private auditDetail(v: VersionSummary, p: Prepared): Record<string, unknown> {
    return {
      versionNo: v.versionNo,
      versionId: v.id,
      origin: v.origin,
      filename: v.filename,
      mediaType: v.mediaType,
      originalBytes: p.original?.length ?? null,
      charCount: v.charCount,
      textSha256: v.textSha256,
      originalSha256: v.originalSha256,
    };
  }

  private async insertVersion(
    client: { query: Pool['query'] },
    sourceId: string,
    versionNo: number,
    p: Prepared,
    actorUserId: string,
    at: Date,
    minutesDraftId: string | null = null,
  ): Promise<VersionSummary> {
    const id = uuidv7(at.getTime());
    const { rows } = await client.query<VersionSummary>(
      `INSERT INTO source_versions
         (id, source_id, version_no, origin, filename, media_type, original_bytes, original_sha256,
          text_content, text_sha256, char_count, created_by, created_at, minutes_draft_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${VERSION_COLUMNS}`,
      [
        id, sourceId, versionNo, p.origin, p.filename, p.mediaType, p.original,
        p.original ? sha256Hex(p.original) : null,
        p.text, sha256Hex(p.text), p.text.length, actorUserId, at, minutesDraftId,
      ],
    );
    // The passage index is written in the same transaction as the version (spec 4.1); notes from before projects have none.
    const projectId = (await client.query(`SELECT project_id AS "projectId" FROM sources WHERE id = $1`, [sourceId])).rows[0]?.projectId;
    if (projectId) await indexVersion(client, 'source_version', id, projectId, p.text);
    return rows[0];
  }

  /**
   * The published notes, meeting minutes and approved shareable summaries of one project that the viewer's audience
   * rule lets them read, newest first. Submissions and discussion transcripts are never listed here. Notes from before
   * projects belong to none.
   */
  async list(userId: string, projectId: string): Promise<ListedSource[]> {
    const { rows } = await this.pool.query<ListedSource>(
      `SELECT s.id, s.title, s.created_at AS "createdAt", s.kind,
              CASE WHEN s.kind = 'minutes' THEN $4::text WHEN s.kind = 'summary' THEN $5::text END AS label,
              max(v.version_no)::int AS "latestVersion", count(v.id)::int AS "versionCount"
         FROM sources s JOIN source_versions v ON v.source_id = s.id JOIN audiences a ON a.id = s.audience_id
        WHERE s.status = 'active' AND s.project_id = $1 AND s.kind IN ('notes', 'minutes', 'summary') AND s.publication = 'published'
          AND ${summaryShownSql('s')} AND ${audienceVisibleSql('a', '$2', '$3')}
        GROUP BY s.id ORDER BY s.created_at DESC, s.id DESC`,
      [projectId, userId, this.access.today(), MINUTES_LABEL, SUMMARY_LIST_LABEL],
    );
    return rows;
  }

  /** The note and its versions. The caller has already checked the viewer may see this source (AudienceService.assertSourceReadable). */
  async get(sourceId: string): Promise<{
    source: Pick<SourceSummary, 'id' | 'title' | 'createdAt'> & {
      projectId: string;
      kind: string;
      label: string | null;
      publication: string;
      intendedMode: string | null;
      returnedReason: string | null;
      provenance: string | null;
      audience: { id: string; mode: string; namedUsers: Array<{ id: string; displayName: string }>; changedAt: string | null };
      /** An approved shareable summary's labels (AI assist spec 7.2); null for any other source. Never names the original. */
      summary: SummaryLabels | null;
      /** False for a shareable summary: it is never evidence, so no extraction is offered on it. */
      mayExtract: boolean;
    };
    versions: VersionSummary[];
  }> {
    const src = await this.pool.query(
      `SELECT id, title, created_at AS "createdAt", project_id AS "projectId", kind, publication, intended_mode AS "intendedMode",
              returned_reason AS "returnedReason", audience_id AS "audienceId"
         FROM sources WHERE id = $1 AND status = 'active'`,
      [sourceId],
    );
    if (src.rowCount === 0) throw new NotFoundException();
    const { rows } = await this.pool.query<VersionSummary>(
      `SELECT ${VERSION_COLUMNS} FROM source_versions WHERE source_id = $1 ORDER BY version_no`,
      [sourceId],
    );
    const { audienceId, ...s } = src.rows[0];
    const aud = (
      await this.pool.query(`SELECT a.mode, (SELECT max(e.at) FROM audience_events e WHERE e.audience_id = a.id) AS "changedAt" FROM audiences a WHERE a.id = $1`, [audienceId])
    ).rows[0];
    const named = await this.pool.query<{ id: string; displayName: string }>(
      `SELECT u.id, u.display_name AS "displayName" FROM audience_members am JOIN users u ON u.id = am.user_id WHERE am.audience_id = $1 ORDER BY u.display_name, u.id`,
      [audienceId],
    );
    return {
      source: {
        ...s,
        audience: { id: audienceId, mode: aud.mode, namedUsers: named.rows, changedAt: aud.changedAt ? (aud.changedAt as Date).toISOString() : null },
        label: s.kind === 'minutes' ? MINUTES_LABEL : s.kind === 'summary' ? SUMMARY_LIST_LABEL : null,
        provenance: rows.length ? await this.provenance(rows[rows.length - 1].id) : null,
        summary: s.kind === 'summary' ? await this.summaryLabels(sourceId) : null,
        mayExtract: s.kind !== 'summary',
      },
      versions: rows,
    };
  }

  /** "Summary approved for sharing", "Approved by <name> on <date>" (the latest approval) and "From a restricted source". */
  private async summaryLabels(sourceId: string): Promise<SummaryLabels | null> {
    const { rows } = await this.pool.query<{ by: string | null; at: Date | null }>(
      `SELECT u.display_name AS by, sm.approved_at AS at
         FROM sources s JOIN summaries sm ON sm.id = s.summary_id LEFT JOIN users u ON u.id = sm.approved_by
        WHERE s.id = $1`,
      [sourceId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      label: SUMMARY_APPROVED_LABEL,
      approved: r.at ? `Approved by ${r.by ?? 'someone'} on ${formatDay(r.at)}` : null,
      from: FROM_RESTRICTED_LABEL,
    };
  }

  /**
   * "Drafted by AI from meeting <title>; edited by <names>; published by <name> on <date>" for a version published
   * from a meeting's draft minutes (spec 5.3); null for any other version. A draft no AI wrote reads "Written by".
   */
  async provenance(versionId: string): Promise<string | null> {
    const found = await this.pool.query(
      `SELECT t.title, d.id AS "draftId", e.at AS "at", u.display_name AS "publisher"
         FROM source_versions v
         JOIN minutes_drafts d ON d.id = v.minutes_draft_id
         JOIN discussion_threads t ON t.id = d.thread_id
         LEFT JOIN discussion_events e ON e.thread_id = t.id AND e.action = 'minutes_published'
              AND e.detail->>'sourceId' = v.source_id::text AND (e.detail->>'versionNo')::int = v.version_no
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE v.id = $1`,
      [versionId],
    );
    if (!found.rows[0]) return null;
    const r = found.rows[0];
    const chain = await this.pool.query<{ origin: string; name: string | null }>(
      `WITH RECURSIVE chain AS (
         SELECT id, edited_from_id, origin, created_by, 0 AS depth FROM minutes_drafts WHERE id = $1
         UNION ALL
         SELECT m.id, m.edited_from_id, m.origin, m.created_by, c.depth + 1 FROM minutes_drafts m JOIN chain c ON m.id = c.edited_from_id
       )
       SELECT c.origin, u.display_name AS name FROM chain c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.depth`,
      [r.draftId],
    );
    const editors = [...new Set(chain.rows.filter((c) => c.origin === 'human' && c.name).map((c) => c.name as string))].sort();
    const byAi = chain.rows.some((c) => c.origin === 'ai');
    const parts = [byAi ? `Drafted by AI from meeting ${r.title}` : `Written by ${editors.join(', ')} for meeting ${r.title}`];
    if (byAi && editors.length > 0) parts.push(`edited by ${editors.join(', ')}`);
    // Who published and when come from the publication event, not from whoever created the version (a Member may have submitted it).
    if (r.at) parts.push(`published by ${r.publisher} on ${formatDay(r.at)}`);
    return parts.join('; ');
  }

  async getVersion(sourceId: string, versionNo: number): Promise<VersionSummary & { text: string; provenance: string | null }> {
    const { rows } = await this.pool.query<VersionSummary & { text: string }>(
      `SELECT ${VERSION_COLUMNS.split(',').map((c) => 'v.' + c.trim()).join(', ')}, v.text_content AS text
         FROM source_versions v JOIN sources s ON s.id = v.source_id
        WHERE v.source_id = $1 AND v.version_no = $2 AND s.status = 'active'`,
      [sourceId, versionNo],
    );
    if (!rows[0]) throw new NotFoundException();
    // A discussion transcript keeps its stored text, but messages hidden or deleted since are masked when shown.
    return { ...rows[0], text: await maskedVersionText(this.pool, rows[0].id, rows[0].text), provenance: await this.provenance(rows[0].id) };
  }

  async getOriginal(sourceId: string, versionNo: number): Promise<{ filename: string; mediaType: string; bytes: Buffer }> {
    const { rows } = await this.pool.query<{ filename: string; media_type: string; original_bytes: Buffer }>(
      `SELECT v.filename, v.media_type, v.original_bytes
         FROM source_versions v JOIN sources s ON s.id = v.source_id
        WHERE v.source_id = $1 AND v.version_no = $2 AND s.status = 'active' AND v.origin = 'upload'`,
      [sourceId, versionNo],
    );
    if (!rows[0]) throw new NotFoundException();
    return { filename: rows[0].filename, mediaType: rows[0].media_type, bytes: rows[0].original_bytes };
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "9 Nov 2026" for a moment, as the calendar day in UTC+8. */
export function formatDay(at: Date): string {
  const d = new Date(at.getTime() + 8 * 3600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
