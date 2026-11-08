import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser, Public } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { InvitationsService } from './invitations.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /** { email, role, startsOn, expiresOn?, displayName? } */
  @Post('projects/:id/invitations')
  @AnySignedInUser()
  @HttpCode(201)
  invite(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.invitations.invite(who(req), id, body(b));
  }

  @Post('invitations/:id/resend')
  @AnySignedInUser()
  @HttpCode(201)
  resend(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.invitations.resend(who(req), id);
  }

  @Post('invitations/:id/revoke')
  @AnySignedInUser()
  @HttpCode(200)
  revoke(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.invitations.revoke(who(req), id);
  }

  /** Shown on the invitation page before sign-in: the invitation only. */
  @Get('invitations/by-token/:token')
  @Public()
  byToken(@Param('token') token: string) {
    return this.invitations.byToken(token);
  }

  @Post('invitations/by-token/:token/accept')
  @AnySignedInUser()
  @HttpCode(200)
  accept(@Param('token') token: string, @Req() req: HttpRequest) {
    return this.invitations.accept(who(req), token);
  }

  @Post('invitations/by-token/:token/decline')
  @AnySignedInUser()
  @HttpCode(200)
  decline(@Param('token') token: string, @Req() req: HttpRequest) {
    return this.invitations.decline(who(req), token);
  }
}
