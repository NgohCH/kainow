import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Put, Query, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { can } from '../auth/permissions';
import { ProjectAccess } from '../projects/access.service';
import { decide } from '../projects/matrix';
import { formatMicro } from './money';
import { SpendService, type PeriodSummary } from './spend.service';
import { SpendSettingsService, describeSettings, parseSettingsBody } from './spend.settings';

export function describePeriod(p: PeriodSummary | null) {
  if (!p) return null;
  return {
    start: p.period.start.toISOString(),
    end: p.period.end.toISOString(),
    limitMyr: p.limitMicroMyr === null ? null : formatMicro(p.limitMicroMyr),
    usedMyr: formatMicro(p.usedMicroMyr),
    reservedMyr: formatMicro(p.reservedMicroMyr),
    uncertainMyr: formatMicro(p.uncertainMicroMyr),
    remainingMyr: formatMicro(p.remainingMicroMyr),
  };
}

@Controller('ai')
export class SpendController {
  constructor(
    private readonly spend: SpendService,
    private readonly settings: SpendSettingsService,
    private readonly access: ProjectAccess,
  ) {}

  /**
   * Where the allowance stands. Amounts are decimal MYR strings with six places. Without `?projectId=` this is the
   * Administrator's view. With it, it is the header meter for that project, for anyone in the project (404 for an
   * outsider): `meter` is the project's monthly figures for someone who manages its AI usage (Project Manager, Owner,
   * Sponsor), otherwise the person's own remaining allowance there (project level, else organisation level), or null
   * when no personal limit applies. The organisation settings are shown to the Administrator only.
   */
  @Get('spend')
  @AnySignedInUser()
  async view(@Req() req: HttpRequest, @Query('projectId') projectId?: string) {
    const user = req.auth?.user;
    if (!user) throw new NotFoundException();
    const isAdmin = can(user.role, 'spend.view');
    if (!projectId) {
      if (!isAdmin) throw new ForbiddenException();
      return this.administratorView(user.id);
    }
    const ctx = await this.access.context(user, projectId);
    const summary = await this.spend.summary(user.id, projectId);
    const manages = decide({ action: 'ai.usage.view', roles: ctx.roles, status: ctx.project.status }).allowed;
    const mine = summary.projectMine ?? summary.mine;
    // No figures (AI settings not saved yet) means no meter, never a meter without numbers.
    const projectPeriod = describePeriod(summary.project);
    const minePeriod = describePeriod(mine);
    const meter = manages ? (projectPeriod ? { kind: 'project' as const, ...projectPeriod } : null) : minePeriod ? { kind: 'personal' as const, ...minePeriod } : null;
    const base = isAdmin ? await this.administratorView(user.id, projectId) : { configured: summary.configured, settings: null };
    return {
      ...base,
      projectId,
      meter,
      // The project's own totals are for those who manage its AI usage (and the Administrator), not for every member.
      project: manages || isAdmin ? describePeriod(summary.project) : null,
      projectDay: manages || isAdmin ? describePeriod(summary.projectDaily) : null,
      projectMine: describePeriod(summary.projectMine),
    };
  }

  private async administratorView(userId: string, projectId?: string) {
    const [summary, settings] = await Promise.all([this.spend.summary(userId, projectId), this.settings.get()]);
    return {
      configured: summary.configured,
      settings: settings ? describeSettings(settings) : null,
      month: describePeriod(summary.monthly),
      day: describePeriod(summary.daily),
      mine: describePeriod(summary.mine),
    };
  }

  /** Saves the approved model, prices, exchange rate and limits. Every field must be given. */
  @Put('spend-settings')
  @RequireAction('ai.settings.manage')
  @HttpCode(200)
  async save(@Body() body: unknown, @Req() req: HttpRequest) {
    const input = parseSettingsBody(body);
    await this.settings.apply(input, req.auth?.user.id ?? null);
    return { settings: describeSettings(input) };
  }
}
