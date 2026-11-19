import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
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
  ) {}

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
