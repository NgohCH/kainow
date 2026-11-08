import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ProjectAccess } from '../projects/access.service';
import type { ProjectAction } from '../projects/matrix';
import { MAX_UPLOAD_BYTES } from './text';
import { NotesService } from './notes.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Memory storage with hard limits: one file, one small text field set, nothing written to disk. */
const upload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 64 * 1024, parts: 8 },
});

type UploadedBuffer = { originalname: string; buffer: Buffer } | undefined;

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

function id(value: string): string {
  if (!UUID.test(value)) throw new NotFoundException();
  return value;
}

function versionNumber(value: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new NotFoundException();
  return Number(value);
}

function who(req: HttpRequest): AuthUser {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
}

/** Notes live in projects; every route is checked against the note's project (ProjectAccess). */
@Controller()
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly access: ProjectAccess,
  ) {}

  /** Checks the action against the project the note belongs to (404 for notes outside the person's projects). */
  private async forSource(req: HttpRequest, sourceId: string, action: ProjectAction): Promise<string> {
    const projectId = await this.access.projectOfSource(id(sourceId));
    await this.access.authorize(who(req), action, projectId);
    return sourceId;
  }

  /** Paste: { title, text }. */
  @Post('projects/:projectId/notes')
  @AnySignedInUser()
  @HttpCode(201)
  async create(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    await this.access.authorize(who(req), 'note.import', projectId);
    return this.notes.createSource({ projectId, title: field(body, 'title'), content: { text: field(body, 'text') ?? '' }, actorUserId: who(req).id });
  }

  /** Upload: multipart with a `file` and an optional `title` (the file name is the default). */
  @Post('projects/:projectId/notes/upload')
  @AnySignedInUser()
  @HttpCode(201)
  @UseInterceptors(upload)
  async createFromFile(@Param('projectId') projectId: string, @UploadedFile() file: UploadedBuffer, @Body() body: unknown, @Req() req: HttpRequest) {
    await this.access.authorize(who(req), 'note.import', projectId);
    return this.notes.createSource({ projectId, title: field(body, 'title'), content: { file }, actorUserId: who(req).id });
  }

  @Get('projects/:projectId/notes')
  @AnySignedInUser()
  async list(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    await this.access.authorize(who(req), 'note.view', projectId);
    return { sources: await this.notes.list(projectId) };
  }

  /** New version by paste: { text }. */
  @Post('notes/:id/versions')
  @AnySignedInUser()
  @HttpCode(201)
  async addVersion(@Param('id') sourceId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    await this.forSource(req, sourceId, 'note.import');
    return { version: await this.notes.addVersion(sourceId, { text: field(body, 'text') ?? '' }, who(req).id) };
  }

  /** New version by upload. */
  @Post('notes/:id/versions/upload')
  @AnySignedInUser()
  @HttpCode(201)
  @UseInterceptors(upload)
  async addVersionFromFile(@Param('id') sourceId: string, @UploadedFile() file: UploadedBuffer, @Req() req: HttpRequest) {
    await this.forSource(req, sourceId, 'note.import');
    return { version: await this.notes.addVersion(sourceId, { file }, who(req).id) };
  }

  @Get('notes/:id')
  @AnySignedInUser()
  async get(@Param('id') sourceId: string, @Req() req: HttpRequest) {
    await this.forSource(req, sourceId, 'note.view');
    return this.notes.get(sourceId);
  }

  @Get('notes/:id/versions/:n')
  @AnySignedInUser()
  async getVersion(@Param('id') sourceId: string, @Param('n') n: string, @Req() req: HttpRequest) {
    await this.forSource(req, sourceId, 'note.view');
    return { version: await this.notes.getVersion(sourceId, versionNumber(n)) };
  }

  /** The uploaded file exactly as received. Always a download, never rendered by the browser. */
  @Get('notes/:id/versions/:n/original')
  @AnySignedInUser()
  async original(@Param('id') sourceId: string, @Param('n') n: string, @Req() req: HttpRequest, @Res() res: Response): Promise<void> {
    await this.forSource(req, sourceId, 'note.view');
    const file = await this.notes.getOriginal(sourceId, versionNumber(n));
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_');
    res.set({
      'Content-Type': file.mediaType,
      'Content-Length': String(file.bytes.length),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    res.end(file.bytes);
  }
}
