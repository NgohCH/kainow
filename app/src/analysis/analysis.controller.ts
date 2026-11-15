import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { AnalysisService } from './analysis.service';

function who(req: HttpRequest): AuthUser {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

/** Every route is checked by AnalysisService against the thread's project and audience (404 outside, 403 when not allowed). */
@Controller('threads/:threadId')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Get('analysis')
  @AnySignedInUser()
  status(@Param('threadId') threadId: string, @Req() req: HttpRequest) {
    return this.analysis.status(who(req), threadId);
  }

  @Post('analyse')
  @AnySignedInUser()
  @HttpCode(202)
  analyse(@Param('threadId') threadId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.analysis.analyseNow(who(req), threadId, { confirmRepeat: field(body, 'confirmRepeat') });
  }

  @Post('analyse-selected')
  @AnySignedInUser()
  @HttpCode(202)
  analyseSelected(@Param('threadId') threadId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.analysis.analyseSelected(who(req), threadId, { messageIds: field(body, 'messageIds') });
  }

  @Post('minutes/draft')
  @AnySignedInUser()
  @HttpCode(202)
  draftMinutes(@Param('threadId') threadId: string, @Req() req: HttpRequest) {
    return this.analysis.draftMinutes(who(req), threadId);
  }
}
