import { Body, Controller, HttpCode, Param, Post, Put, Req, NotFoundException } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ProjectAccess } from '../projects/access.service';
import { parseAudienceChange } from './audience';
import { AudienceService } from './audience.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Changing who may read a meeting, its minutes or a note (spec 6.2). The project comes from the audience row. */
@Controller('audiences')
export class AudienceController {
  constructor(
    private readonly audiences: AudienceService,
    private readonly access: ProjectAccess,
  ) {}

  /** { mode, namedUserIds } → who would gain and who would lose access. */
  @Post(':audienceId/preview')
  @AnySignedInUser()
  @HttpCode(200)
  async preview(@Param('audienceId') audienceId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const { audience } = await this.audiences.visibleTo(who(req), audienceId);
    const ctx = await this.access.authorize(who(req), 'audience.change', audience.projectId as string);
    return this.audiences.preview(ctx, audience, parseAudienceChange(body));
  }

  /** { mode, namedUserIds, reason }. */
  @Put(':audienceId')
  @AnySignedInUser()
  async change(@Param('audienceId') audienceId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    await this.audiences.visibleTo(who(req), audienceId); // 404 before any 400 about the body
    const reason = body && typeof body === 'object' ? (body as Record<string, unknown>).reason : undefined;
    const row = await this.audiences.change(who(req), audienceId, parseAudienceChange(body), reason);
    return { ...row, namedUsers: await this.audiences.people(row.namedUserIds) };
  }
}
