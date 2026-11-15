import { Body, Controller, Get, NotFoundException, Param, Put, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { AnalysisSettingsService } from './settings.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller()
export class AnalysisSettingsController {
  constructor(private readonly settings: AnalysisSettingsService) {}

  @Get('settings/analysis')
  @RequireAction('organisation.manage')
  organisation() {
    return this.settings.organisationView();
  }

  /** { automatic?, quietMinutes?, projectsMayChange?, reason } */
  @Put('settings/analysis')
  @RequireAction('organisation.manage')
  async setOrganisation(@Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.setOrganisation(who(req), body(b));
    return this.settings.organisationView();
  }

  @Get('projects/:projectId/settings/analysis')
  @AnySignedInUser()
  project(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.settings.projectView(who(req), projectId);
  }

  /** { automatic?: boolean | null, quietMinutes?: number | null, reason } */
  @Put('projects/:projectId/settings/analysis')
  @AnySignedInUser()
  async setProject(@Param('projectId') projectId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.setProject(who(req), projectId, body(b));
    return this.settings.projectView(who(req), projectId);
  }
}
