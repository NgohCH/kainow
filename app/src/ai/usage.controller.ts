import { Controller, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { UsageService } from './usage.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Read-only. No view here shows a prompt, question, title, answer text or key. */
@Controller()
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  /** Any signed-in person: their own usage by project this month. */
  @Get('ai/usage/mine')
  @AnySignedInUser()
  mine(@Req() req: HttpRequest) {
    return this.usage.mine(who(req));
  }

  /** The Enterprise Administrator. */
  @Get('ai/usage')
  @RequireAction('spend.view')
  organisation() {
    return this.usage.organisation();
  }

  /** Project Manager, Owner or Sponsor of the project. Access is decided in the service. */
  @Get('projects/:projectId/ai/usage')
  @AnySignedInUser()
  project(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.usage.project(projectId, who(req));
  }
}
