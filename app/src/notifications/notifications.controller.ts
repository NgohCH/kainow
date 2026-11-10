import { Controller, Get, Inject, NotFoundException, Param, Req } from '@nestjs/common';
import type { Pool } from 'pg';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { todayUtc8 } from '../projects/membership';
import { escalationFlags } from './escalation-flags';

@Controller()
export class NotificationsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  /** Tasks shown with "No independent escalation recipient": anyone who can view the project. */
  @Get('projects/:id/escalation-flags')
  @AnySignedInUser()
  async flags(@Param('id') id: string, @Req() req: HttpRequest) {
    const user = req.auth?.user;
    if (!user) throw new NotFoundException();
    await this.access.context(user, id);
    return escalationFlags(this.pool, id, todayUtc8(this.now()));
  }
}
