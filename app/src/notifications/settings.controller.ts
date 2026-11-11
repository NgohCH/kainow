import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { NotificationSettingsService } from './settings.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller()
export class NotificationSettingsController {
  constructor(private readonly settings: NotificationSettingsService) {}

  @Get('notification-settings')
  @RequireAction('organisation.manage')
  organisation() {
    return this.settings.organisationView();
  }

  /** { changes: { leadDays, ... }, reason } */
  @Put('notification-settings')
  @RequireAction('organisation.manage')
  async setOrganisation(@Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.setOrganisation(who(req), body(b));
    return this.settings.organisationView();
  }

  @Post('notification-settings/preview')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  previewOrganisation(@Body() b: unknown, @Req() req: HttpRequest) {
    return this.settings.previewOrganisation(who(req), body(b));
  }

  /** { add?: { date }, removeId? } */
  @Post('notification-settings/holidays/preview')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  previewOrgHoliday(@Body() b: unknown, @Req() req: HttpRequest) {
    return this.settings.previewOrganisationHoliday(who(req), body(b));
  }

  @Get('notification-settings/holidays')
  @RequireAction('organisation.manage')
  holidays() {
    return this.settings.listHolidays();
  }

  /** { date: 'YYYY-MM-DD', name } */
  @Post('notification-settings/holidays')
  @RequireAction('organisation.manage')
  async addHoliday(@Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.addOrgHoliday(who(req), body(b));
    return this.settings.listHolidays();
  }

  /** { reason } */
  @Delete('notification-settings/holidays/:id')
  @RequireAction('organisation.manage')
  async removeHoliday(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.removeOrgHoliday(who(req), id, body(b));
    return this.settings.listHolidays();
  }

  @Get('projects/:id/notification-settings')
  @AnySignedInUser()
  project(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.settings.projectView(who(req), id);
  }

  /** { changes: { leadDays: [5, 1] | null, ... }, reason } */
  @Put('projects/:id/notification-settings')
  @AnySignedInUser()
  async setProject(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.setProject(who(req), id, body(b));
    return this.settings.projectView(who(req), id);
  }

  @Post('projects/:id/notification-settings/preview')
  @HttpCode(200)
  @AnySignedInUser()
  previewProject(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.settings.previewProject(who(req), id, body(b));
  }

  @Post('projects/:id/holidays/preview')
  @HttpCode(200)
  @AnySignedInUser()
  previewProjectHoliday(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.settings.previewProjectHoliday(who(req), id, body(b));
  }

  @Get('projects/:id/holidays')
  @AnySignedInUser()
  projectHolidays(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.settings.projectHolidays(who(req), id);
  }

  @Post('projects/:id/holidays')
  @AnySignedInUser()
  async addProjectHoliday(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.addProjectHoliday(who(req), id, body(b));
    return this.settings.projectHolidays(who(req), id);
  }

  @Delete('projects/:id/holidays/:holidayId')
  @AnySignedInUser()
  async removeProjectHoliday(@Param('id') id: string, @Param('holidayId') holidayId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.removeProjectHoliday(who(req), id, holidayId, body(b));
    return this.settings.projectHolidays(who(req), id);
  }
}
