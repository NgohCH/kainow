import { Controller, Get, Inject, Param } from '@nestjs/common';
import { BeforeSetup, Public } from '../auth/access';
import { CLOCK, type Clock } from '../auth/tokens';
import { SetupService } from './setup.service';

/** What a setup link shows before sign-in. */
@BeforeSetup()
@Controller('setup')
export class SetupController {
  constructor(
    private readonly setup: SetupService,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  @Get(':token')
  @Public()
  async status(@Param('token') token: string) {
    return this.setup.status(token, this.now());
  }
}
