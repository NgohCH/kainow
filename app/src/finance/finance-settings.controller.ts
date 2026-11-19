import { Body, Controller, Get, HttpCode, NotFoundException, Param, Put, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { FinanceSettingsService } from './finance-settings.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Project Settings › Finance (spec 8.2). Who may read or change is decided in the service. */
@Controller('projects/:projectId/settings/finance')
export class FinanceSettingsController {
  constructor(private readonly settings: FinanceSettingsService) {}

  @Get()
  @AnySignedInUser()
  get(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.settings.get(who(req), projectId);
  }

  /** { tracking?, currency?, warnFirstPct?, warnSecondPct?, membersRead?, grantsRead?, reason } */
  @Put()
  @AnySignedInUser()
  @HttpCode(200)
  async set(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    const { reason, ...next } = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    await this.settings.set(user, projectId, next, reason);
    return this.settings.get(user, projectId);
  }

  /** Counts for the turn-off wording: entries, budget versions and pending approvals. */
  @Get('preview')
  @AnySignedInUser()
  preview(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.settings.preview(who(req), projectId);
  }
}
