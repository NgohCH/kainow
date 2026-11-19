import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { FinanceService } from './finance.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** The project finance view and spending entries (spec 3.5, 11). Who may read or record is decided in the service. */
@Controller('projects/:projectId/finance')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  @AnySignedInUser()
  read(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.finance.read(who(req), projectId);
  }

  /** { spentOn, amount, currency, description, reference? } */
  @Post('spending')
  @AnySignedInUser()
  @HttpCode(201)
  async record(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return { entry: await this.finance.record(who(req), projectId, body) };
  }
}
