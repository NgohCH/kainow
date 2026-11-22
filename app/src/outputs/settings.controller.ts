import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { OutputSettingsService, parseOutputSettingsBody } from './output-settings.service';
import { ReportTypesService } from './report-types.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

@Controller()
export class SettingsController {
  constructor(
    private readonly reportTypes: ReportTypesService,
    private readonly outputSettings: OutputSettingsService,
  ) {}

  /** Active types only, for anyone signed in (the choice offered when filing). */
  @Get('report-types')
  @AnySignedInUser()
  async active() {
    return { reportTypes: await this.reportTypes.list(false) };
  }

  @Get('admin/report-types')
  @RequireAction('organisation.manage')
  async all() {
    return { reportTypes: await this.reportTypes.list(true) };
  }

  /** { name, reason } */
  @Post('admin/report-types')
  @RequireAction('organisation.manage')
  async add(@Body() b: unknown, @Req() req: HttpRequest) {
    const body = obj(b);
    return this.reportTypes.add(who(req), body.name, body.reason);
  }

  /** { name, reason } renames; { status: 'retired', reason } retires. */
  @Put('admin/report-types/:id')
  @RequireAction('organisation.manage')
  @HttpCode(200)
  async change(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    const body = obj(b);
    if (!UUID.test(id)) throw new NotFoundException();
    if (body.status === 'retired') return this.reportTypes.retire(who(req), id, body.reason);
    return this.reportTypes.rename(who(req), id, body.name, body.reason);
  }

  @Get('projects/:projectId/output-settings')
  @AnySignedInUser()
  get(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    if (!UUID.test(projectId)) throw new NotFoundException();
    return this.outputSettings.get(who(req), projectId);
  }

  @Put('projects/:projectId/output-settings')
  @AnySignedInUser()
  @HttpCode(200)
  async put(@Param('projectId') projectId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    if (!UUID.test(projectId)) throw new NotFoundException();
    const user = who(req);
    const { patch, reason } = parseOutputSettingsBody(b);
    await this.outputSettings.update(user, projectId, patch, reason);
    return this.outputSettings.get(user, projectId);
  }
}
