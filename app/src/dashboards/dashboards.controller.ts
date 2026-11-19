import { Controller, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ProjectDashboardService } from './project-dashboard.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Dashboard routes. Access is decided per project inside the service (project.view), as for `GET /projects/:id`. */
@Controller()
export class DashboardsController {
  constructor(private readonly projectDashboard: ProjectDashboardService) {}

  @Get('projects/:id/dashboard')
  @AnySignedInUser()
  project(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.projectDashboard.get(who(req), id);
  }
}
