import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { SummariesService } from './summaries.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);

/**
 * Shareable summaries of restricted sources (spec 7). Every route is checked by SummariesService: 404 for anyone
 * outside the original's audience, then the matrix (summary.request, summary.approve, summary.review).
 */
@Controller()
export class SummariesController {
  constructor(private readonly summaries: SummariesService) {}

  /** { intendedAudience: { mode, namedUserIds }, leaveOut } → SummaryView (queued). */
  @Post('sources/:sourceId/summaries')
  @AnySignedInUser()
  @HttpCode(201)
  forSource(@Param('sourceId') sourceId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.summaries.requestForSource(who(req), sourceId, { intendedAudience: field(body, 'intendedAudience'), leaveOut: field(body, 'leaveOut') });
  }

  /** A Restricted meeting, from its visible messages. */
  @Post('threads/:threadId/summaries')
  @AnySignedInUser()
  @HttpCode(201)
  forThread(@Param('threadId') threadId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.summaries.requestForThread(who(req), threadId, { intendedAudience: field(body, 'intendedAudience'), leaveOut: field(body, 'leaveOut') });
  }

  @Get('projects/:projectId/summaries-to-review')
  @AnySignedInUser()
  async toReview(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return { items: await this.summaries.toReview(who(req), projectId) };
  }

  @Get('summaries/:id')
  @AnySignedInUser()
  get(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.summaries.get(who(req), id);
  }

  /** { body, basedOnVersion } → a human version; 409 "Someone changed this since you opened it" with `current` when stale. */
  @Put('summaries/:id')
  @AnySignedInUser()
  edit(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.summaries.edit(who(req), id, { body: field(body, 'body'), basedOnVersion: field(body, 'basedOnVersion') });
  }

  @Get('summaries/:id/versions/:no')
  @AnySignedInUser()
  version(@Param('id') id: string, @Param('no') no: string, @Req() req: HttpRequest) {
    return this.summaries.version(who(req), id, no);
  }

  /** { versionNo } → ticks the mark of that version (it must be the newest) Intended. */
  @Post('summaries/:id/marks/:markId/intended')
  @AnySignedInUser()
  @HttpCode(200)
  intended(@Param('id') id: string, @Param('markId') markId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.summaries.markIntended(who(req), id, markId, { versionNo: field(body, 'versionNo') });
  }

  /** { versionNo } → notifies PM, Owner and Sponsors (title only). */
  @Post('summaries/:id/ask-approval')
  @AnySignedInUser()
  @HttpCode(200)
  askApproval(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.summaries.askApproval(who(req), id, { versionNo: field(body, 'versionNo') });
  }

  /** { versionNo, reason } → publishes the version as the summary source; returns who gained access. */
  @Post('summaries/:id/approve')
  @AnySignedInUser()
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.summaries.approve(who(req), id, { versionNo: field(body, 'versionNo'), reason: field(body, 'reason') });
  }

  /** { reason } → a summary in an access review (or hidden) back to approved; PM, Owner or Sponsor, any project state. */
  @Post('summaries/:id/confirm')
  @AnySignedInUser()
  @HttpCode(200)
  confirm(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.summaries.confirm(who(req), id, { reason: field(body, 'reason') });
  }

  /** { reason } → withdrawn (kept in history); answers and drafts that used it are treated as removed material. */
  @Post('summaries/:id/withdraw')
  @AnySignedInUser()
  @HttpCode(200)
  withdraw(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.summaries.withdraw(who(req), id, { reason: field(body, 'reason') });
  }
}
