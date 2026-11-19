import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import { CLOCK, type Clock } from '../auth/tokens';
import { MEASURES_VERSION } from '../dashboards/measures';
import { todayUtc8 } from '../projects/membership';
import { parseAnalyticsFilters } from './filters';
import { PanelsService } from './panels.service';
import { SystemService } from './system.service';
import { TrendsService } from './trends.service';

/** The panels served. */
const PANELS = ['progress', 'problems', 'system', 'trends'] as const;

/** Administrator analytics (dashboards spec 7). Counts and project names only. */
@Controller('admin/analytics')
export class AnalyticsController {
  constructor(
    private readonly panels: PanelsService,
    private readonly system: SystemService,
    private readonly trends: TrendsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `?panel=progress|problems&period=&department=&status=&ownership=&includeArchived=` */
  @Get()
  @RequireAction('analytics.view')
  async get(@Query() query: Record<string, unknown>) {
    const panel = query.panel;
    if (typeof panel !== 'string' || !(PANELS as readonly string[]).includes(panel)) throw new BadRequestException('Choose a panel from the list.');
    const filters = parseAnalyticsFilters(query, todayUtc8(this.clock()));
    if ('error' in filters) throw new BadRequestException(filters.error);
    const data =
      panel === 'progress' ? await this.panels.progress(filters)
      : panel === 'problems' ? await this.panels.problems(filters)
      : panel === 'system' ? await this.system.problems(filters)
      : await this.trends.weekly(filters);
    return { panel, data, definitionsVersion: MEASURES_VERSION, computedAt: data.computedAt };
  }
}
