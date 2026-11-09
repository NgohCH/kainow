import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ClosureService } from './closure.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Preparing a project's closure. Close itself is the project transition to Closed. */
@Controller('projects/:id/closure')
export class ClosureController {
  constructor(private readonly closure: ClosureService) {}

  @Get()
  @AnySignedInUser()
  view(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.closure.view(who(req), id);
  }

  /** { recordKind, recordId, disposition, reason, affectsDelivery?, handoverProjectId? } */
  @Post('dispositions')
  @AnySignedInUser()
  @HttpCode(201)
  dispose(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.closure.dispose(who(req), id, body(b));
  }

  /** { reason } — an Owner or Sponsor lets the Project Manager close. */
  @Post('delegation')
  @AnySignedInUser()
  @HttpCode(201)
  delegate(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.closure.delegate(who(req), id, body(b));
  }

  @Post('delegation/revoke')
  @AnySignedInUser()
  @HttpCode(200)
  revoke(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.closure.revoke(who(req), id);
  }
}
