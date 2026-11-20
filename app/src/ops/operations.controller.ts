import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Put, Req } from '@nestjs/common';
import type { Pool } from 'pg';
import { AllowedWhenProtective, AnySignedInUser, BeforeSetup, Public, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { can } from '../auth/permissions';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { OperationsService } from './operations.service';
import { OPS_BOUNDS } from './settings';
import { OpsSettingsService } from './settings.service';
import { resume } from './resume';
import { OperationsState } from './state';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** The Operations page (spec 10): Enterprise Administrators only, except the two banner routes. */
@Controller()
export class OperationsController {
  constructor(
    private readonly operations: OperationsService,
    private readonly settings: OpsSettingsService,
    private readonly state: OperationsState,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  @Get('admin/operations')
  @RequireAction('operations.view')
  view() {
    return this.operations.view();
  }

  /** The settings, their bounds and history. The critical level must also be above the warning level (not only at least 51). */
  private async settingsView() {
    const s = await this.settings.get();
    return {
      ...s,
      rules: {
        criticalAboveWarning: true as const,
        /** The lowest critical level allowed with the warning level as it is now. */
        storageCriticalEffectiveMin: Math.max(OPS_BOUNDS.storageCriticalPct.min, s.settings.storageWarningPct + 1),
      },
    };
  }

  @Get('admin/operations/settings')
  @RequireAction('operations.manage')
  getSettings() {
    return this.settingsView();
  }

  /** { backupRetentionDays?, storageWarningPct?, storageCriticalPct?, safeFloorGb?, diagnosticRetentionDays?, reason } */
  @Put('admin/operations/settings')
  @RequireAction('operations.manage')
  async updateSettings(@Body() b: unknown, @Req() req: HttpRequest) {
    await this.settings.update(who(req).id, body(b));
    return this.settingsView();
  }

  /** { reason }. 409 `{ code: 'resume_checks_failed', failing: [check names] }` while a check fails. */
  @Post('admin/operations/resume')
  @HttpCode(200)
  @RequireAction('operations.manage')
  @AllowedWhenProtective()
  async resume(@Body() b: unknown, @Req() req: HttpRequest) {
    return resume(this.pool, who(req).id, body(b).reason, this.now(), { state: this.state });
  }

  /** Any signed-in person: protective mode. Enterprise Administrators also get the backup and storage warning. */
  @Get('operations/banner')
  @AnySignedInUser()
  banner(@Req() req: HttpRequest) {
    return this.operations.banner(can(who(req).role, 'operations.view'));
  }

  /** Before sign-in: only whether protective mode is on, for the sign-in page text. */
  @Get('operations/public-state')
  @Public()
  @BeforeSetup()
  async publicState() {
    return { protective: await this.state.isProtective() };
  }
}
