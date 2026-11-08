import { Body, Controller, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { MembershipsService } from './memberships.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Role management. Who may manage each role is decided by the role-management matrix in the service. */
@Controller()
export class MembersController {
  constructor(private readonly memberships: MembershipsService) {}

  /** Appoint an existing account: { userId, role, startsOn, expiresOn? } */
  @Post('projects/:id/members')
  @AnySignedInUser()
  @HttpCode(201)
  appoint(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.memberships.appoint(who(req), id, body(b));
  }

  /** { expiresOn } */
  @Post('memberships/:id/extend')
  @AnySignedInUser()
  @HttpCode(200)
  extend(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.memberships.extend(who(req), id, body(b));
  }

  /** { startsOn, expiresOn? } */
  @Post('memberships/:id/dates')
  @AnySignedInUser()
  @HttpCode(200)
  dates(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.memberships.changeDates(who(req), id, body(b));
  }

  /** { reason } */
  @Post('memberships/:id/revoke')
  @AnySignedInUser()
  @HttpCode(200)
  revoke(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.memberships.revoke(who(req), id, body(b));
  }
}
