import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { AllowedWhenProtective, AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { LinesService } from './lines.service';
import { ResourcesReportService } from './report.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const uuid = (id: string): string => {
  if (!UUID.test(id)) throw new NotFoundException();
  return id;
};

/** The project Resources tab (spec 4, 11): `resource.view` reads, `resource.edit` changes; both decided in the service. */
@Controller('projects/:projectId/resources')
export class LinesController {
  constructor(
    private readonly lines: LinesService,
    private readonly report: ResourcesReportService,
  ) {}

  @Get()
  @AnySignedInUser()
  list(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.lines.list(who(req), projectId);
  }

  /** The resources report as JSON, or `?format=csv` as a download (spec 4, 13); needs `resource.view`. */
  @Get('report')
  @AnySignedInUser()
  // GET audit (spec 7.3): the resources.report_exported record of a CSV download is kept in protective mode.
  @AllowedWhenProtective()
  async reportOf(@Param('projectId') projectId: string, @Query('format') format: string | undefined, @Req() req: HttpRequest, @Res({ passthrough: true }) res: { setHeader(n: string, v: string): void }) {
    if (format !== 'csv') return this.report.build(who(req), projectId);
    const { text, filename } = await this.report.exportCsv(who(req), projectId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return text;
  }

  /** { itemId } or { oneOffKind, description }, with quantity?, unit?, startsOn?, endsOn?, neededBy?, notes? */
  @Post('lines')
  @AnySignedInUser()
  async create(@Param('projectId') projectId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return { line: await this.lines.create(who(req), projectId, b) };
  }

  @Put('lines/:lineId')
  @AnySignedInUser()
  async edit(@Param('projectId') projectId: string, @Param('lineId') lineId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return { line: await this.lines.edit(who(req), projectId, uuid(lineId), b) };
  }

  /** { status }: needed, arranged, in_use or finished */
  @Post('lines/:lineId/status')
  @HttpCode(200)
  @AnySignedInUser()
  async setStatus(@Param('projectId') projectId: string, @Param('lineId') lineId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return { line: await this.lines.setStatus(who(req), projectId, uuid(lineId), body(b).status) };
  }

  /** { reason } */
  @Post('lines/:lineId/cancel')
  @HttpCode(200)
  @AnySignedInUser()
  async cancel(@Param('projectId') projectId: string, @Param('lineId') lineId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return { line: await this.lines.cancel(who(req), projectId, uuid(lineId), body(b).reason) };
  }

  @Get('lines/:lineId/history')
  @AnySignedInUser()
  history(@Param('projectId') projectId: string, @Param('lineId') lineId: string, @Req() req: HttpRequest) {
    return this.lines.history(who(req), projectId, uuid(lineId));
  }
}
