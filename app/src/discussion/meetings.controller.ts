import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { MeetingsService } from './meetings.service';

function who(req: HttpRequest): AuthUser {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

/** Every route is checked by MeetingsService against the meeting's project and audience (404 outside, 403 when not allowed). */
@Controller('threads/:threadId')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Put('present')
  @AnySignedInUser()
  present(@Param('threadId') threadId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.meetings.setPresent(who(req), threadId, { userIds: field(body, 'userIds') });
  }

  @Post('end')
  @AnySignedInUser()
  @HttpCode(200)
  end(@Param('threadId') threadId: string, @Req() req: HttpRequest) {
    return this.meetings.end(who(req), threadId);
  }

  @Get('minutes')
  @AnySignedInUser()
  minutes(@Param('threadId') threadId: string, @Req() req: HttpRequest) {
    return this.meetings.minutes(who(req), threadId);
  }

  @Get('minutes/:versionNo')
  @AnySignedInUser()
  minutesVersion(@Param('threadId') threadId: string, @Param('versionNo') versionNo: string, @Req() req: HttpRequest) {
    if (!/^\d{1,9}$/.test(versionNo)) throw new BadRequestException('versionNo must be a version number.');
    return this.meetings.minutesVersion(who(req), threadId, Number(versionNo));
  }

  @Post('minutes')
  @AnySignedInUser()
  @HttpCode(201)
  saveMinutes(@Param('threadId') threadId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.meetings.saveMinutes(who(req), threadId, { body: field(body, 'body'), basedOnVersion: field(body, 'basedOnVersion') });
  }
}
