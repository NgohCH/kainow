import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { FeedbackService } from './feedback.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);

/** Every route is checked by FeedbackService against the project, the audience and the matrix. */
@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** { targetKind, targetId, category, note } */
  @Post('projects/:projectId/feedback')
  @AnySignedInUser()
  @HttpCode(201)
  create(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.feedback.create(who(req), projectId, {
      targetKind: field(body, 'targetKind'),
      targetId: field(body, 'targetId'),
      category: field(body, 'category'),
      note: field(body, 'note'),
    });
  }

  @Get('projects/:projectId/feedback')
  @AnySignedInUser()
  list(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.feedback.list(who(req), projectId);
  }

  /** { status, note } */
  @Post('feedback/:id/status')
  @AnySignedInUser()
  @HttpCode(200)
  setStatus(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.feedback.setStatus(who(req), id, { status: field(body, 'status'), note: field(body, 'note') });
  }

  /** { note } */
  @Post('feedback/:id/escalate')
  @AnySignedInUser()
  @HttpCode(200)
  escalate(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.feedback.escalate(who(req), id, { note: field(body, 'note') });
  }

  @Get('admin/feedback')
  @RequireAction('ai.settings.manage')
  adminList(@Req() req: HttpRequest) {
    return this.feedback.adminList(who(req));
  }
}
