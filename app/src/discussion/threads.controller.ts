import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, BadRequestException } from '@nestjs/common';
import { AllowedWhenProtective, AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ThreadsService } from './threads.service';

function who(req: HttpRequest): AuthUser {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

/** Every route is checked by ThreadsService against the thread's project and audience (404 outside, 403 when read-only). */
@Controller()
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Post('projects/:projectId/threads')
  @AnySignedInUser()
  @HttpCode(201)
  start(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.threads.start(who(req), projectId, {
      kind: field(body, 'kind'),
      title: field(body, 'title'),
      meetingDate: field(body, 'meetingDate'),
      audience: field(body, 'audience'),
    });
  }

  @Get('projects/:projectId/discussion')
  @AnySignedInUser()
  async list(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return { items: await this.threads.list(who(req), projectId) };
  }

  @Get('threads/:threadId')
  @AnySignedInUser()
  // GET audit (spec 7.3): each Deleted message shown is recorded (deleted.inspected), in protective mode too.
  @AllowedWhenProtective()
  get(@Param('threadId') threadId: string, @Query('afterNo') afterNo: string | undefined, @Req() req: HttpRequest) {
    if (afterNo !== undefined && !/^\d{1,9}$/.test(afterNo)) throw new BadRequestException('afterNo must be a message number.');
    return this.threads.get(who(req), threadId, afterNo === undefined ? 0 : Number(afterNo));
  }

  @Post('threads/:threadId/messages')
  @AnySignedInUser()
  @HttpCode(201)
  post(@Param('threadId') threadId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.threads.post(who(req), threadId, { body: field(body, 'body'), replyToId: field(body, 'replyToId') });
  }

  @Put('messages/:messageId')
  @AnySignedInUser()
  edit(@Param('messageId') messageId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.threads.edit(who(req), messageId, { body: field(body, 'body'), basedOnVersion: field(body, 'basedOnVersion') });
  }

  @Get('messages/:messageId/versions')
  @AnySignedInUser()
  async versions(@Param('messageId') messageId: string, @Req() req: HttpRequest) {
    return { versions: await this.threads.versions(who(req), messageId) };
  }

  @Post('messages/:messageId/hide')
  @AnySignedInUser()
  @HttpCode(200)
  hide(@Param('messageId') messageId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.threads.hide(who(req), messageId, { reason: field(body, 'reason') });
  }

  @Post('messages/:messageId/unhide')
  @AnySignedInUser()
  @HttpCode(200)
  unhide(@Param('messageId') messageId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.threads.unhide(who(req), messageId, { reason: field(body, 'reason') });
  }

  @Post('messages/:messageId/delete')
  @AnySignedInUser()
  @HttpCode(200)
  delete(@Param('messageId') messageId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.threads.delete(who(req), messageId, { reason: field(body, 'reason') });
  }

  @Post('messages/:messageId/restore')
  @AnySignedInUser()
  @HttpCode(200)
  restore(@Param('messageId') messageId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.threads.restore(who(req), messageId, { reason: field(body, 'reason') });
  }
}
