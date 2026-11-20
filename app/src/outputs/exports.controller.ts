import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { ExportsService, parseExportFilters, parseExportKind } from './exports';
import { OutputsService } from './outputs.service';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

/** Project exports (D106, spec 7): the CSV, and saving it as an output. Who may export is decided in the service. */
@Controller('projects/:projectId')
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly outputs: OutputsService,
  ) {}

  /** `?kind=tasks|decisions|questions|risks|outputs&status=&assigneeId=&overdue=&severity=&reportTypeId=` */
  @Get('export')
  @AnySignedInUser()
  async download(@Param('projectId') projectId: string, @Query() query: Record<string, unknown>, @Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<string> {
    if (!UUID.test(projectId)) throw new NotFoundException();
    const built = await this.exports.download(who(req), projectId, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return built.csv.toString('utf8');
  }

  /** `{ kind, filters?, outputId?, title?, reportTypeId? }`: a submitted output, or a new version of the chosen registered one. */
  @Post('export/save')
  @AnySignedInUser()
  @HttpCode(201)
  save(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    if (!UUID.test(projectId)) throw new NotFoundException();
    const b = obj(body);
    const kind = parseExportKind(b.kind);
    const filters = parseExportFilters(kind, b.filters);
    if (b.outputId !== undefined && b.outputId !== null) {
      if (typeof b.outputId !== 'string' || !UUID.test(b.outputId)) throw new BadRequestException('Choose a registered output from the list.');
      return this.outputs.addVersion(who(req), projectId, b.outputId, { kind: 'export', exportKind: kind, filters });
    }
    const title = typeof b.title === 'string' && b.title.trim() !== '' ? b.title : undefined;
    const reportTypeId = typeof b.reportTypeId === 'string' && UUID.test(b.reportTypeId) ? b.reportTypeId : undefined;
    return this.outputs.submit(who(req), projectId, { kind: 'export', exportKind: kind, filters, title, reportTypeId });
  }
}
