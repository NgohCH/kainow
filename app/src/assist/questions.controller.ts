import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { QuestionsService } from './questions.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);

/** Every route is checked by QuestionsService against the project, the matrix and the answer's visibility (404 outside). */
@Controller()
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  /** { question } → AnswerView, with the sources found already listed. */
  @Post('projects/:projectId/questions')
  @AnySignedInUser()
  @HttpCode(201)
  ask(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.questions.ask(who(req), projectId, { question: field(body, 'question') });
  }

  /** The caller's own questions in the project, newest first. */
  @Get('projects/:projectId/questions')
  @AnySignedInUser()
  async list(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return { items: await this.questions.list(who(req), projectId) };
  }

  @Get('questions/:requestId')
  @AnySignedInUser()
  get(@Param('requestId') requestId: string, @Req() req: HttpRequest) {
    return this.questions.get(who(req), requestId);
  }

  /** { threadId } → the shared AnswerView; 409 with canReanswer when some thread readers could not read what it used. */
  @Post('questions/:requestId/share')
  @AnySignedInUser()
  @HttpCode(200)
  share(@Param('requestId') requestId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.questions.share(who(req), requestId, { threadId: field(body, 'threadId') });
  }

  /** { threadId } → the new thread-scope question; it is shared into the thread when answered. */
  @Post('questions/:requestId/reanswer')
  @AnySignedInUser()
  @HttpCode(201)
  reanswer(@Param('requestId') requestId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.questions.reanswer(who(req), requestId, { threadId: field(body, 'threadId') });
  }

  @Post('questions/:requestId/hide')
  @AnySignedInUser()
  @HttpCode(200)
  hide(@Param('requestId') requestId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.questions.hide(who(req), requestId, { reason: field(body, 'reason') });
  }

  @Post('questions/:requestId/unhide')
  @AnySignedInUser()
  @HttpCode(200)
  unhide(@Param('requestId') requestId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.questions.unhide(who(req), requestId, { reason: field(body, 'reason') });
  }
}
