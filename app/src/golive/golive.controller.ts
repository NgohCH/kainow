import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { GoLiveService } from './golive.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller('go-live')
export class GoLiveController {
  constructor(private readonly service: GoLiveService) {}

  @Get()
  @AnySignedInUser()
  view(@Req() req: HttpRequest) {
    return this.service.view(who(req));
  }

  @Get('summary')
  @AnySignedInUser()
  summary(@Req() req: HttpRequest) {
    return this.service.summary(who(req));
  }

  /** Declared before the :key routes so "logos/skip" is not read as a step. */
  @Post('steps/logos/skip')
  @HttpCode(200)
  @AnySignedInUser()
  skip(@Body() b: unknown, @Req() req: HttpRequest) {
    return this.service.change(who(req), 'logos', 'skip', body(b));
  }

  @Post('steps/:key/tick')
  @HttpCode(200)
  @AnySignedInUser()
  tick(@Param('key') key: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.service.change(who(req), key, 'tick', body(b));
  }

  @Post('steps/:key/untick')
  @HttpCode(200)
  @AnySignedInUser()
  untick(@Param('key') key: string, @Req() req: HttpRequest) {
    return this.service.change(who(req), key, 'untick', {});
  }
}
