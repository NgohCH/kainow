import { Body, Controller, Get, HttpCode, Put, Req } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { formatMicro } from './money';
import { SpendService, type PeriodSummary } from './spend.service';
import { SpendSettingsService, describeSettings, parseSettingsBody } from './spend.settings';

function describePeriod(p: PeriodSummary | null) {
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
  ) {}

  /** Where the allowance stands. Amounts are decimal MYR strings with six places. */
  @Get('spend')
  @RequireAction('spend.view')
  async view() {
    const [summary, settings] = await Promise.all([this.spend.summary(), this.settings.get()]);
    return {
      configured: summary.configured,
      settings: settings ? describeSettings(settings) : null,
      month: describePeriod(summary.monthly),
      day: describePeriod(summary.daily),
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
