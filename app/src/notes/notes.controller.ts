import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
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

function actor(req: HttpRequest): string {
  const userId = req.auth?.user.id;
  if (!userId) throw new NotFoundException();
  return userId;
}

@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  /** Paste: { title, text }. */
  @Post()
  @RequireAction('note.import')
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: HttpRequest) {
    return this.notes.createSource({ title: field(body, 'title'), content: { text: field(body, 'text') ?? '' }, actorUserId: actor(req) });
  }

  /** Upload: multipart with a `file` and an optional `title` (the file name is the default). */
  @Post('upload')
  @RequireAction('note.import')
  @HttpCode(201)
  @UseInterceptors(upload)
  createFromFile(@UploadedFile() file: UploadedBuffer, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.notes.createSource({ title: field(body, 'title'), content: { file }, actorUserId: actor(req) });
  }

  /** New version by paste: { text }. */
  @Post(':id/versions')
  @RequireAction('note.import')
  @HttpCode(201)
  async addVersion(@Param('id') sourceId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return { version: await this.notes.addVersion(id(sourceId), { text: field(body, 'text') ?? '' }, actor(req)) };
  }

  /** New version by upload. */
  @Post(':id/versions/upload')
  @RequireAction('note.import')
  @HttpCode(201)
  @UseInterceptors(upload)
  async addVersionFromFile(@Param('id') sourceId: string, @UploadedFile() file: UploadedBuffer, @Req() req: HttpRequest) {
    return { version: await this.notes.addVersion(id(sourceId), { file }, actor(req)) };
  }

  @Get()
  @RequireAction('note.view')
  async list() {
    return { sources: await this.notes.list() };
  }

  @Get(':id')
  @RequireAction('note.view')
  get(@Param('id') sourceId: string) {
    return this.notes.get(id(sourceId));
  }

  @Get(':id/versions/:n')
  @RequireAction('note.view')
  async getVersion(@Param('id') sourceId: string, @Param('n') n: string) {
    return { version: await this.notes.getVersion(id(sourceId), versionNumber(n)) };
  }

  /** The uploaded file exactly as received. Always a download, never rendered by the browser. */
  @Get(':id/versions/:n/original')
  @RequireAction('note.view')
  async original(@Param('id') sourceId: string, @Param('n') n: string, @Res() res: Response): Promise<void> {
    const file = await this.notes.getOriginal(id(sourceId), versionNumber(n));
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
