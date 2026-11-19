import { Body, Controller, Get, HttpCode, NotFoundException, Param, Put, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { LimitsService, parseLimitsBody } from './limits.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller('projects/:projectId/ai/limits')
export class LimitsController {
  constructor(private readonly limits: LimitsService) {}

  /** The project's limits, the organisation's numbers and ceiling, and whether this person may edit. Access is decided in the service. */
  @Get()
  @AnySignedInUser()
  get(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.limits.get(projectId, who(req));
  }

  @Put()
  @AnySignedInUser()
  @HttpCode(200)
  async set(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    const { limits, reason } = parseLimitsBody(body);
    await this.limits.set(projectId, limits, reason, user);
    return this.limits.get(projectId, user);
  }
}
