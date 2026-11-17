import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ReviewService } from './review.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);

/** Review of shared AI answers and drafts after material was removed (spec 5.5, 6.3). PM and Deputy, any project state. */
@Controller()
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get('projects/:projectId/assist-review')
  @AnySignedInUser()
  async list(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return { items: await this.review.list(who(req), projectId) };
  }

  /** `:kind` is `answer` or `draft`; { reason }. */
  @Post('assist-review/:kind/:id/clear')
  @AnySignedInUser()
  @HttpCode(200)
  clear(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.review.clear(who(req), kind, id, { reason: field(body, 'reason') });
  }

  @Post('assist-review/:kind/:id/withdraw')
  @AnySignedInUser()
  @HttpCode(200)
  withdraw(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.review.withdraw(who(req), kind, id, { reason: field(body, 'reason') });
  }
}
