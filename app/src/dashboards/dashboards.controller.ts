import { Body, Controller, Get, NotFoundException, Param, Put, Query, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { PersonalDashboardService } from './personal.service';
import { PreferencesService } from './preferences.service';
import { ProjectDashboardService } from './project-dashboard.service';
import { TimelineService } from './timeline.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Dashboard routes. Access is decided per project inside the service (project.view), as for `GET /projects/:id`. */
@Controller()
export class DashboardsController {
  constructor(
    private readonly projectDashboard: ProjectDashboardService,
    private readonly timeline: TimelineService,
    private readonly preferences: PreferencesService,
    private readonly personal: PersonalDashboardService,
  ) {}

  /** The personal dashboard (spec §4). The web passes its saved home toggles as `?includeArchived=1` and `?showCompleted=1`. */
  @Get('dashboard/me')
  @AnySignedInUser()
  me(@Query('includeArchived') includeArchived: string | undefined, @Query('showCompleted') showCompleted: string | undefined, @Req() req: HttpRequest) {
    return this.personal.get(who(req), { includeArchived: includeArchived === '1', showCompleted: showCompleted === '1' });
  }

  @Get('me/preferences')
  @AnySignedInUser()
  myPreferences(@Req() req: HttpRequest) {
    return this.preferences.get(who(req));
  }

  @Put('me/preferences')
  @AnySignedInUser()
  savePreferences(@Body() body: unknown, @Req() req: HttpRequest) {
    return this.preferences.put(who(req), body);
  }

  @Get('projects/:id/dashboard')
  @AnySignedInUser()
  project(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.projectDashboard.get(who(req), id);
  }

  @Get('projects/:id/timeline')
  @AnySignedInUser()
  projectTimeline(@Param('id') id: string, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @Req() req: HttpRequest) {
    return this.timeline.get(who(req), id, { from, to });
  }
}
