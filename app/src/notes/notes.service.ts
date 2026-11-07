import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { UploadRejected, readUpload } from './readers';
import { NoteTextError, normaliseText, sha256Hex } from './text';

export interface NewContent {
  /** Pasted text. Exactly one of text or file is given. */
  text?: unknown;
  file?: { originalname: string; buffer: Buffer };
}

interface Prepared {
  origin: 'paste' | 'upload';
  text: string;
  filename: string | null;
  mediaType: string | null;
  original: Buffer | null;
}

export interface SourceSummary {
  id: string;
  title: string;
  createdAt: Date;
  latestVersion: number;
  versionCount: number;
}

export interface VersionSummary {
  id: string;
  sourceId: string;
  versionNo: number;
  origin: 'paste' | 'upload';
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

  async createSource(input: { title?: unknown; content: NewContent; actorUserId: string }): Promise<{ source: SourceSummary; version: VersionSummary }> {
    const prepared = await this.prepare(input.content);
    const title = this.checkTitle(input.title ?? (prepared.filename ? prepared.filename.replace(/\.[^.]*$/, '') || prepared.filename : undefined));
    const at = this.now();
    const sourceId = uuidv7(at.getTime());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO sources (id, title, created_by, created_at) VALUES ($1, $2, $3, $4)', [sourceId, title, input.actorUserId, at]);
      const version = await this.insertVersion(client, sourceId, 1, prepared, input.actorUserId, at);
      await writeAudit(client, {
        at,
        action: 'note.created',
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
      const src = await client.query('SELECT id FROM sources WHERE id = $1 AND status = \'active\' FOR UPDATE', [sourceId]);
      if (src.rowCount === 0) throw new NotFoundException();
      const latest = await client.query<{ version_no: number; text_sha256: string }>(
        'SELECT version_no, text_sha256 FROM source_versions WHERE source_id = $1 ORDER BY version_no DESC LIMIT 1',
        [sourceId],
      );
      if (latest.rows[0]?.text_sha256 === sha256Hex(prepared.text)) {
        throw new ConflictException('This text is identical to the latest version, so no new version was made');
      }
      const versionNo = (latest.rows[0]?.version_no ?? 0) + 1;
      const version = await this.insertVersion(client, sourceId, versionNo, prepared, actorUserId, at);
      await writeAudit(client, {
        at,
        action: 'note.version_added',
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
  ): Promise<VersionSummary> {
    const id = uuidv7(at.getTime());
    const { rows } = await client.query<VersionSummary>(
      `INSERT INTO source_versions
         (id, source_id, version_no, origin, filename, media_type, original_bytes, original_sha256,
          text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${VERSION_COLUMNS}`,
      [
        id, sourceId, versionNo, p.origin, p.filename, p.mediaType, p.original,
        p.original ? sha256Hex(p.original) : null,
        p.text, sha256Hex(p.text), p.text.length, actorUserId, at,
      ],
    );
    return rows[0];
  }

  async list(): Promise<SourceSummary[]> {
    const { rows } = await this.pool.query<SourceSummary>(
      `SELECT s.id, s.title, s.created_at AS "createdAt",
              max(v.version_no)::int AS "latestVersion", count(v.id)::int AS "versionCount"
         FROM sources s JOIN source_versions v ON v.source_id = s.id
        WHERE s.status = 'active'
        GROUP BY s.id ORDER BY s.created_at DESC, s.id DESC`,
    );
    return rows;
  }

  async get(sourceId: string): Promise<{ source: Pick<SourceSummary, 'id' | 'title' | 'createdAt'>; versions: VersionSummary[] }> {
    const src = await this.pool.query<{ id: string; title: string; createdAt: Date }>(
      `SELECT id, title, created_at AS "createdAt" FROM sources WHERE id = $1 AND status = 'active'`,
      [sourceId],
    );
    if (src.rowCount === 0) throw new NotFoundException();
    const { rows } = await this.pool.query<VersionSummary>(
      `SELECT ${VERSION_COLUMNS} FROM source_versions WHERE source_id = $1 ORDER BY version_no`,
      [sourceId],
    );
    return { source: src.rows[0], versions: rows };
  }

  async getVersion(sourceId: string, versionNo: number): Promise<VersionSummary & { text: string }> {
    const { rows } = await this.pool.query<VersionSummary & { text: string }>(
      `SELECT ${VERSION_COLUMNS.split(',').map((c) => 'v.' + c.trim()).join(', ')}, v.text_content AS text
         FROM source_versions v JOIN sources s ON s.id = v.source_id
        WHERE v.source_id = $1 AND v.version_no = $2 AND s.status = 'active'`,
      [sourceId, versionNo],
    );
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
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
