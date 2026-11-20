import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { noteUpload } from '../notes/notes.controller';
import { parsePatchBody, parseRegisterBody, parseSubmitBody } from './outputs-input';
import { type OutputAudienceInput, OutputAudienceService } from './audience';
import { OutputFilesService } from './output-files.service';
import { OutputsService } from './outputs.service';

type UploadedBuffer = { originalname: string; buffer: Buffer } | undefined;

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const ids = (...values: string[]): void => {
  for (const v of values) if (!UUID.test(v)) throw new NotFoundException();
};
const STATUSES = ['submitted', 'registered', 'declined', 'withdrawn'];
const AUDIENCE_BODY = 'Choose Project-wide, or Restricted with the people who may read it.';
const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);
const MAX_LINK = 2048;
const LINK_BODY = 'Give the link to where the file is now, or nothing to relink the same file.';
/** A version number from the path: 404 for anything else. */
const versionNo = (n: string): number => {
  if (!/^[1-9][0-9]{0,8}$/.test(n)) throw new NotFoundException();
  return Number(n);
};

/** `{ mode: 'project' }` or `{ mode: 'restricted', userIds }`. */
function parseAudienceBody(body: unknown): OutputAudienceInput {
  const mode = field(body, 'mode');
  if (mode === 'project') return { kind: 'project' };
  const userIds = field(body, 'userIds');
  if (mode === 'restricted' && Array.isArray(userIds) && userIds.every((u) => typeof u === 'string' && UUID.test(u))) return { kind: 'restricted', userIds };
  throw new BadRequestException(AUDIENCE_BODY);
}

/** The output register (spec 14). Who may do what is decided in the service: 404 for anyone who may not see, then 403. */
@Controller('projects/:projectId/outputs')
export class OutputsController {
  constructor(
    private readonly outputs: OutputsService,
    private readonly audiences: OutputAudienceService,
    private readonly files: OutputFilesService,
  ) {}

  @Get()
  @AnySignedInUser()
  async list(@Param('projectId') projectId: string, @Query('status') status: string | undefined, @Query('reportTypeId') reportTypeId: string | undefined, @Req() req: HttpRequest) {
    ids(projectId);
    const filters = {
      status: status && STATUSES.includes(status) ? status : undefined,
      reportTypeId: reportTypeId && UUID.test(reportTypeId) ? reportTypeId : undefined,
    };
    return { outputs: await this.outputs.list(who(req), projectId, filters) };
  }

  @Get(':outputId')
  @AnySignedInUser()
  get(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    return this.outputs.get(who(req), projectId, outputId);
  }

  /** JSON `{ kind: 'draft' | 'link', ... }`, or multipart with a `file` and fields `title`, `reportTypeId` (an upload). */
  @Post()
  @AnySignedInUser()
  @HttpCode(201)
  @UseInterceptors(noteUpload)
  submit(@Param('projectId') projectId: string, @UploadedFile() file: UploadedBuffer, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId);
    return this.outputs.submit(who(req), projectId, parseSubmitBody(body, file));
  }

  @Post(':outputId/register')
  @AnySignedInUser()
  @HttpCode(200)
  register(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    return this.outputs.register(who(req), projectId, outputId, parseRegisterBody(body));
  }

  /** `{ reason }` */
  @Post(':outputId/decline')
  @AnySignedInUser()
  @HttpCode(200)
  decline(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    const reason = body && typeof body === 'object' ? (body as Record<string, unknown>).reason : undefined;
    return this.outputs.decline(who(req), projectId, outputId, reason);
  }

  /** `{ targetOutputId }`: a Submitted output's versions become new versions of a Registered one (spec 4.3). */
  @Post(':outputId/accept-into')
  @AnySignedInUser()
  @HttpCode(200)
  acceptInto(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    const target = body && typeof body === 'object' ? (body as Record<string, unknown>).targetOutputId : undefined;
    if (typeof target !== 'string' || !UUID.test(target)) throw new BadRequestException('Choose the registered output to add this submission to.');
    return this.outputs.acceptInto(who(req), projectId, outputId, target);
  }

  /** Any of `{ title, reportTypeId, categoryIds, issueDate, contributors }`, with an optional `reason`. */
  @Put(':outputId')
  @AnySignedInUser()
  @HttpCode(200)
  update(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    const { patch, reason } = parsePatchBody(body);
    return this.outputs.update(who(req), projectId, outputId, patch, reason);
  }

  /** A new version: the same bodies as submitting, without a title (the output keeps its own). */
  @Post(':outputId/versions')
  @AnySignedInUser()
  @HttpCode(201)
  @UseInterceptors(noteUpload)
  addVersion(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @UploadedFile() file: UploadedBuffer, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    return this.outputs.addVersion(who(req), projectId, outputId, parseSubmitBody(body, file, true));
  }

  /** Files a version (or files it again after a failure) in the project's output destination (spec 5.4). */
  @Post(':outputId/versions/:n/file')
  @AnySignedInUser()
  @HttpCode(200)
  file(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Param('n') n: string, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    if (!/^[1-9][0-9]{0,8}$/.test(n)) throw new NotFoundException();
    return this.outputs.file(who(req), projectId, outputId, Number(n));
  }

  /** Puts a version for approval (PM or Deputy); an Owner or Sponsor approves it through the project's change requests. */
  @Post(':outputId/versions/:n/approval')
  @AnySignedInUser()
  @HttpCode(201)
  requestApproval(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Param('n') n: string, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    if (!/^[1-9][0-9]{0,8}$/.test(n)) throw new NotFoundException();
    return this.outputs.requestApproval(who(req), projectId, outputId, Number(n));
  }

  /**
   * Opens a filed or linked version (spec 5.7): 303 to the file's web URL after a quick check. A file found Changed,
   * Missing or Access denied (or a version with no file) answers 409 with `{ state, label, actions }` instead.
   */
  @Get(':outputId/versions/:n/open')
  @AnySignedInUser()
  async open(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Param('n') n: string, @Req() req: HttpRequest, @Res() res: Response): Promise<void> {
    ids(projectId, outputId);
    const target = await this.files.open(who(req), projectId, outputId, versionNo(n));
    res.set({ 'Cache-Control': 'private, no-store' });
    res.redirect(303, target);
  }

  /** "Download a copy" (readers): the file streamed through Kainow from the provider, always as a download. */
  @Get(':outputId/versions/:n/download')
  @AnySignedInUser()
  async download(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Param('n') n: string, @Req() req: HttpRequest, @Res() res: Response): Promise<void> {
    ids(projectId, outputId);
    const file = await this.files.download(who(req), projectId, outputId, versionNo(n));
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
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

  /** `{ url? }` (PM or Deputy): a moved or missing file linked to where it is now (spec 5.8). */
  @Post(':outputId/versions/:n/relink')
  @AnySignedInUser()
  @HttpCode(200)
  relink(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Param('n') n: string, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    const url = field(body, 'url');
    if (url !== undefined && url !== null && (typeof url !== 'string' || url.trim() === '' || url.length > MAX_LINK)) throw new BadRequestException(LINK_BODY);
    return this.files.relink(who(req), projectId, outputId, versionNo(n), typeof url === 'string' ? url.trim() : null);
  }

  /** PM or Deputy: a changed file's content registered as a new Draft version, the original restored where possible (spec 5.8). */
  @Post(':outputId/versions/:n/register-changed')
  @AnySignedInUser()
  @HttpCode(200)
  registerChanged(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Param('n') n: string, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    return this.files.registerChanged(who(req), projectId, outputId, versionNo(n));
  }

  /**
   * `{ mode, userIds?, reason, preview? }` (spec 4.5): the PM, Owner or a Sponsor changes who may read the output. With
   * `preview: true` nothing is saved: `{ gaining, losing }` says who would gain and who would lose access.
   */
  @Put(':outputId/audience')
  @AnySignedInUser()
  @HttpCode(200)
  async audience(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    const user = who(req);
    const input = parseAudienceBody(body);
    return this.audiences.setOutputAudience(user, projectId, outputId, input, field(body, 'reason'), field(body, 'preview') === true);
  }

  /** `{ reason }`: "Access review required" cleared; the output goes back to its audience. */
  @Post(':outputId/review/clear')
  @AnySignedInUser()
  @HttpCode(200)
  async clearReview(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    await this.audiences.clearReview(who(req), projectId, outputId, field(body, 'reason'));
    try {
      return await this.outputs.get(who(req), projectId, outputId);
    } catch (err) {
      // Someone outside a Restricted audience may clear it (spec 11) but does not read it afterwards.
      if (err instanceof NotFoundException) return { id: outputId, reviewState: 'cleared', readable: false };
      throw err;
    }
  }

  /** `{ reason }`: "Access review required" ended by withdrawing the output (final). */
  @Post(':outputId/review/withdraw')
  @AnySignedInUser()
  @HttpCode(200)
  async withdrawForReview(@Param('projectId') projectId: string, @Param('outputId') outputId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    ids(projectId, outputId);
    await this.audiences.withdrawForReview(who(req), projectId, outputId, field(body, 'reason'));
    try {
      return await this.outputs.get(who(req), projectId, outputId);
    } catch (err) {
      // An Owner or Sponsor, or anyone outside its audience, does not read a withdrawn output (spec 4.6): they are told only that it was withdrawn.
      if (err instanceof NotFoundException) return { id: outputId, status: 'withdrawn', readable: false };
      throw err;
    }
  }
}
