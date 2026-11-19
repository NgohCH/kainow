import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { MEASURES_VERSION, MEASURE_DEFINITIONS } from '../dashboards/measures';
import { loadAccessSettings } from '../organisation/access-settings';
import { todayUtc8 } from '../projects/membership';
import { CATALOGUE } from './catalogue';
import { type ExportPanel, type PanelData, exportMeta, panelTable, toCsv } from './csv';
import { DrillService } from './drill.service';
import { type AnalyticsFilters, parseAnalyticsFilters } from './filters';
import { PanelsService } from './panels.service';
import { SystemService } from './system.service';
import { TrendsService } from './trends.service';
import { ViewsService } from './views.service';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

/** The panels served. */
const PANELS = ['progress', 'problems', 'system', 'trends'] as const;
type Panel = (typeof PANELS)[number];

export const EXPORT_OFF = 'Analytics export is turned off.';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Administrator analytics (dashboards spec 7). Counts and project names only, except a drill-down for a participant. */
@Controller('admin/analytics')
export class AnalyticsController {
  constructor(
    private readonly panels: PanelsService,
    private readonly system: SystemService,
    private readonly trends: TrendsService,
    private readonly drills: DrillService,
    private readonly views: ViewsService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private panelOf(query: Record<string, unknown>): Panel {
    const panel = query.panel;
    if (typeof panel !== 'string' || !(PANELS as readonly string[]).includes(panel)) throw new BadRequestException('Choose a panel from the list.');
    return panel as Panel;
  }

  private filtersOf(query: Record<string, unknown>): AnalyticsFilters {
    const filters = parseAnalyticsFilters(query, todayUtc8(this.clock()));
    if ('error' in filters) throw new BadRequestException(filters.error);
    return filters;
  }

  private async load(panel: Panel, filters: AnalyticsFilters): Promise<PanelData> {
    if (panel === 'progress') return { panel, data: await this.panels.progress(filters) };
    if (panel === 'problems') return { panel, data: await this.panels.problems(filters) };
    if (panel === 'system') return { panel, data: await this.system.problems(filters) };
    return { panel, data: await this.trends.weekly(filters) };
  }

  /** `?panel=progress|problems|system|trends&period=&department=&status=&ownership=&includeArchived=` */
  @Get()
  @RequireAction('analytics.view')
  async get(@Query() query: Record<string, unknown>) {
    const panel = this.panelOf(query);
    const { data } = await this.load(panel, this.filtersOf(query));
    return { panel, data, definitionsVersion: MEASURES_VERSION, computedAt: data.computedAt };
  }

  /** `?level=org|department|project&id=&measure=` plus the filters (spec 7.3). Access is rechecked on every request. */
  @Get('drill')
  @RequireAction('analytics.view')
  drill(@Query() query: Record<string, unknown>, @Req() req: HttpRequest) {
    const filters = this.filtersOf(query);
    return this.drills.drill(who(req), { level: query.level, id: query.id, measure: query.measure }, filters);
  }

  /** The Definitions page (spec 7.5): every measure with its definition and version, and the event catalogue. */
  @Get('definitions')
  @RequireAction('analytics.view')
  definitions() {
    return { version: MEASURES_VERSION, measures: MEASURE_DEFINITIONS, events: CATALOGUE };
  }

  /**
   * `?panel=&...filters` (spec 7.6): the panel's table as CSV, built now from the same measures. Rechecks the permission
   * and the organisation setting, and records the panel and filters (never the data) as `analytics.exported`.
   */
  @Get('export')
  @RequireAction('analytics.view')
  async export(@Query() query: Record<string, unknown>, @Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<string> {
    const user = who(req);
    const panel: ExportPanel = this.panelOf(query);
    const filters = this.filtersOf(query);
    if (!(await loadAccessSettings(this.pool)).analyticsExportAllowed) throw new ForbiddenException(EXPORT_OFF);
    const loaded = await this.load(panel, filters);
    const department = filters.departmentId
      ? ((await this.pool.query(`SELECT name FROM departments WHERE id = $1`, [filters.departmentId])).rows[0]?.name as string | undefined) ?? null
      : null;
    const { columns, rows } = panelTable(loaded);
    const text = toCsv(exportMeta(panel, filters, department, loaded.data.computedAt), columns, rows);
    const now = this.clock();
    await writeAudit(this.pool, { at: now, action: 'analytics.exported', actorUserId: user.id, subjectType: 'analytics', detail: { panel, filters } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kainow-${panel}-${todayUtc8(now)}.csv"`);
    return text;
  }

  // ---- Saved views (spec 7.4): own rows only; another person's view is not found. ----

  @Get('views')
  @RequireAction('analytics.view')
  listViews(@Req() req: HttpRequest) {
    return this.views.list(who(req));
  }

  @Get('views/:id')
  @RequireAction('analytics.view')
  getView(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.views.get(who(req), id);
  }

  /** { name, config } */
  @Post('views')
  @RequireAction('analytics.view')
  createView(@Body() b: unknown, @Req() req: HttpRequest) {
    return this.views.create(who(req), body(b));
  }

  /** { name, config } */
  @Put('views/:id')
  @RequireAction('analytics.view')
  updateView(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.views.update(who(req), id, body(b));
  }

  @Delete('views/:id')
  @RequireAction('analytics.view')
  removeView(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.views.remove(who(req), id);
  }
}

