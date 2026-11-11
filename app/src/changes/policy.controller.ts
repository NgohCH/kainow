import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { PolicyService } from './policy.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller()
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  @Get('approval-policy')
  @RequireAction('organisation.manage')
  organisation() {
    return this.policy.organisationView();
  }

  /** How many pending requests a change of the organisation's count would affect. */
  @Get('approval-policy/impact')
  @RequireAction('organisation.manage')
  async impact() {
    return { pending: await this.policy.pendingAffected({}) };
  }

  /** { required?, projectsMayOverride?, reason, pending: 'keep' | 'restart' } */
  @Post('approval-policy')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  async setOrganisation(@Body() b: unknown, @Req() req: HttpRequest) {
    await this.policy.setOrganisation(who(req), body(b));
    return this.policy.organisationView();
  }

  @Get('projects/:id/approval-policy')
  @AnySignedInUser()
  project(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.policy.projectView(who(req), id);
  }

  /** { required: 1 | 2 | 3 | null, reason, pending: 'keep' | 'restart' } */
  @Post('projects/:id/approval-policy')
  @HttpCode(200)
  @AnySignedInUser()
  async setProject(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    await this.policy.setProject(who(req), id, body(b));
    return this.policy.projectView(who(req), id);
  }
}
