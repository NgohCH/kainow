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
}
