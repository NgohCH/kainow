import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { noteUpload } from '../notes/notes.controller';
import { parsePatchBody, parseRegisterBody, parseSubmitBody } from './outputs-input';
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

/** The output register (spec 14). Who may do what is decided in the service: 404 for anyone who may not see, then 403. */
@Controller('projects/:projectId/outputs')
export class OutputsController {
  constructor(private readonly outputs: OutputsService) {}

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
}
