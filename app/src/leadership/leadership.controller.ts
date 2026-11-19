import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { LeadershipGrantsService } from './grants.service';
import { LeadershipSummaryService } from './summary.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Leadership grants (D89), managed only by an Enterprise Administrator. */
@Controller('admin/leadership-grants')
export class LeadershipController {
  constructor(private readonly grants: LeadershipGrantsService) {}

  @Get()
  @RequireAction('organisation.manage')
  list() {
    return this.grants.list();
  }

  /** { userId, scope: { kind, departmentIds?, projectIds? }, startsOn, expiresOn?, reason } */
  @Post()
  @RequireAction('organisation.manage')
  grant(@Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.grant(who(req), body(b));
  }

  /** { expiresOn (or null for no end), reason } */
  @Post(':id/end')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  end(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    const input = body(b);
    return this.grants.changeEnd(who(req), id, input.expiresOn, input.reason);
  }

  /** { reason } */
  @Post(':id/revoke')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  revoke(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.revoke(who(req), id, body(b).reason);
  }
}

/** The leadership summary (dashboards spec 6.2). A 404 for anyone without an Active grant. It adds no project access. */
@Controller()
export class LeadershipSummaryController {
  constructor(private readonly summary: LeadershipSummaryService) {}

  /** For the main menu: whether to show "Leadership". */
  @Get('leadership/me')
  @AnySignedInUser()
  async me(@Req() req: HttpRequest) {
    return { hasGrant: await this.summary.hasGrant(who(req)) };
  }

  /** `?status=draft,closed` (default planned, active, deferred), `?department=<id>`, `?includeArchived=1`. */
  @Get('dashboard/leadership')
  @AnySignedInUser()
  get(
    @Query('status') status: string | undefined,
    @Query('department') department: string | undefined,
    @Query('includeArchived') includeArchived: string | undefined,
    @Req() req: HttpRequest,
  ) {
    return this.summary.get(who(req), { status, department, includeArchived: includeArchived === '1' });
  }
}
