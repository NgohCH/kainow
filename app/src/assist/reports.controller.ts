import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req, Res } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ReportsService } from './reports.service';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);

/** Draft reports and specifications (spec 6). Every route is checked by ReportsService (404 for anyone who may not see the draft). */
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** { kind, title?, periodFrom?, periodTo?, brief?, chosen?: { sourceIds?, threadIds? } } → ReportView (queued). */
  @Post('projects/:projectId/reports')
  @AnySignedInUser()
  @HttpCode(201)
  create(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.reports.create(who(req), projectId, {
      kind: field(body, 'kind'),
      title: field(body, 'title'),
      periodFrom: field(body, 'periodFrom'),
      periodTo: field(body, 'periodTo'),
      brief: field(body, 'brief'),
      chosen: field(body, 'chosen'),
    });
  }

  @Get('projects/:projectId/reports')
  @AnySignedInUser()
  async list(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return { items: await this.reports.list(who(req), projectId) };
  }

  @Get('reports/:id')
  @AnySignedInUser()
  get(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.reports.get(who(req), id);
  }

  /** { body, basedOnVersion } → a human version; 409 "Someone changed this since you opened it" with `current` when stale. */
  @Put('reports/:id')
  @AnySignedInUser()
  edit(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.reports.edit(who(req), id, { body: field(body, 'body'), basedOnVersion: field(body, 'basedOnVersion') });
  }

  @Post('reports/:id/regenerate')
  @AnySignedInUser()
  @HttpCode(201)
  regenerate(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.reports.regenerate(who(req), id);
  }

  @Post('reports/:id/share')
  @AnySignedInUser()
  @HttpCode(200)
  share(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.reports.share(who(req), id);
  }

  @Post('reports/:id/unshare')
  @AnySignedInUser()
  @HttpCode(200)
  unshare(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.reports.unshare(who(req), id);
  }

  /** One version's text (to compare any two versions). */
  @Get('reports/:id/versions/:no')
  @AnySignedInUser()
  version(@Param('id') id: string, @Param('no') no: string, @Req() req: HttpRequest) {
    return this.reports.version(who(req), id, no);
  }

  /** Download Markdown: an attachment of type text/markdown. */
  @Get('reports/:id/versions/:no/markdown')
  @AnySignedInUser()
  async markdown(@Param('id') id: string, @Param('no') no: string, @Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<string> {
    const file = await this.reports.markdown(who(req), id, no);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return file.text;
  }
}
