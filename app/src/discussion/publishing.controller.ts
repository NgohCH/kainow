import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { noteUpload } from '../notes/notes.controller';
import { PublishingService } from './publishing.service';

type UploadedBuffer = { originalname: string; buffer: Buffer } | undefined;

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);
const versionNo = (v: string): number => {
  if (!/^[1-9][0-9]{0,8}$/.test(v)) throw new BadRequestException('versionNo must be a version number.');
  return Number(v);
};

/** Every route is checked by PublishingService against the project, the audience and the matrix. */
@Controller()
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Post('threads/:threadId/minutes/:versionNo/publish')
  @AnySignedInUser()
  @HttpCode(200)
  publish(@Param('threadId') threadId: string, @Param('versionNo') n: string, @Req() req: HttpRequest) {
    return this.publishing.publishDraft(who(req), threadId, versionNo(n));
  }

  @Post('threads/:threadId/minutes/:versionNo/submit')
  @AnySignedInUser()
  @HttpCode(201)
  submitDraft(@Param('threadId') threadId: string, @Param('versionNo') n: string, @Req() req: HttpRequest) {
    return this.publishing.submitDraft(who(req), threadId, versionNo(n));
  }

  /** Paste: { title, text, intendedMode }. */
  @Post('projects/:projectId/notes/submissions')
  @AnySignedInUser()
  @HttpCode(201)
  submit(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.publishing.submit(who(req), projectId, { text: field(body, 'text') ?? '' }, { title: field(body, 'title'), intendedMode: field(body, 'intendedMode') });
  }

  /** Upload: multipart with a `file`, an optional `title` and `intendedMode`. */
  @Post('projects/:projectId/notes/submissions/upload')
  @AnySignedInUser()
  @HttpCode(201)
  @UseInterceptors(noteUpload)
  submitFile(@Param('projectId') projectId: string, @UploadedFile() file: UploadedBuffer, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.publishing.submit(who(req), projectId, { file }, { title: field(body, 'title'), intendedMode: field(body, 'intendedMode') });
  }

  /** { audience: { mode, namedUserIds } } for a pasted or uploaded submission; omitted for minutes from a meeting. */
  @Post('notes/:sourceId/publish')
  @AnySignedInUser()
  @HttpCode(200)
  publishSubmission(@Param('sourceId') sourceId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.publishing.publishSubmission(who(req), sourceId, { audience: field(body, 'audience') });
  }

  @Post('notes/:sourceId/return')
  @AnySignedInUser()
  @HttpCode(200)
  returnSubmission(@Param('sourceId') sourceId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.publishing.returnSubmission(who(req), sourceId, { reason: field(body, 'reason') });
  }
}
