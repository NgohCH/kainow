import { Body, Controller, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { GrantsService } from './grants.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Audit and Oversight access. Who may act is decided in the service. */
@Controller()
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  /** { userId, kind: 'audit' | 'oversight', purpose, scope, startsOn, expiresOn? } */
  @Post('projects/:id/grants')
  @AnySignedInUser()
  @HttpCode(201)
  request(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.request(who(req), id, body(b));
  }

  @Post('grants/:id/approve')
  @AnySignedInUser()
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.decide(who(req), id, 'approved', body(b));
  }

  /** { reason } */
  @Post('grants/:id/decline')
  @AnySignedInUser()
  @HttpCode(200)
  decline(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.decide(who(req), id, 'declined', body(b));
  }

  /** { expiresOn } */
  @Post('grants/:id/extend')
  @AnySignedInUser()
  @HttpCode(200)
  extend(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.extend(who(req), id, body(b));
  }

  /** { reason } */
  @Post('grants/:id/suspend')
  @AnySignedInUser()
  @HttpCode(200)
  suspend(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.suspend(who(req), id, body(b));
  }

  /** { reason } */
  @Post('grants/:id/restore')
  @AnySignedInUser()
  @HttpCode(200)
  restore(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.restore(who(req), id, body(b));
  }

  /** { reason } */
  @Post('grants/:id/revoke')
  @AnySignedInUser()
  @HttpCode(200)
  revoke(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.grants.revoke(who(req), id, body(b));
  }
}
