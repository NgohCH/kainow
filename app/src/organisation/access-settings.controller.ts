import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Put, Req } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { todayUtc8 } from '../projects/membership';
import { AccessSettingsService } from './access-settings.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller('admin/access-settings')
export class AccessSettingsController {
  constructor(
    private readonly settings: AccessSettingsService,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  @Get()
  @RequireAction('organisation.manage')
  get() {
    return this.settings.get();
  }

  /** The new values (any subset); lists every Closed project whose archive state they would change. */
  @Post('preview')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  async preview(@Body() b: unknown) {
    return { projects: await this.settings.preview(body(b) as never, todayUtc8(this.now())) };
  }

  /** { archiveAfterMonths?, grantDefaultDays?, grantMaxDays?, invitationValidDays?, analyticsExportAllowed?, reason } */
  @Put()
  @RequireAction('organisation.manage')
  async update(@Body() b: unknown, @Req() req: HttpRequest) {
    const { reason, ...next } = body(b);
    await this.settings.update(who(req), next as never, reason);
    return this.settings.get();
  }
}
