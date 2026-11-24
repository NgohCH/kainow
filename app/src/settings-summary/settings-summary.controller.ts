import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { SettingsSummaryService } from './settings-summary.service';

/** The Settings hub's boxes (spec 7.8): read-only, Enterprise Administrators only. */
@Controller('admin/settings')
export class SettingsSummaryController {
  constructor(private readonly summary: SettingsSummaryService) {}

  @Get('summary')
  @RequireAction('organisation.manage')
  get(@Req() req: HttpRequest) {
    const user = req.auth?.user;
    if (!user) throw new NotFoundException();
    return this.summary.summary(user);
  }
}
