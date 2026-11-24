import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { can } from '../auth/permissions';
import type { AuthUser } from '../auth/tokens';
import { StageTemplatesService } from './stage-templates.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

/** Stage templates (D131, spec 14): anyone signed in reads the active ones; the Enterprise Administrator manages them. */
@Controller('stage-templates')
export class StageTemplatesController {
  constructor(private readonly templates: StageTemplatesService) {}

  /** Active templates with their stages (the new-project form). `?all=1`: the Administrator's list, retired included, with counts. */
  @Get()
  @AnySignedInUser()
  async list(@Query('all') all: string | undefined, @Req() req: HttpRequest) {
    const everything = all === '1';
    if (everything && !can(who(req).role, 'organisation.manage')) throw new ForbiddenException();
    return { templates: await this.templates.list(everything) };
  }

  /** { name, description?, stages: { name, substages }[], reason } */
  @Post()
  @RequireAction('organisation.manage')
  create(@Body() b: unknown, @Req() req: HttpRequest) {
    return this.templates.create(who(req), obj(b));
  }

  /** The same body: replaces the name, description and stage list. */
  @Put(':id')
  @RequireAction('organisation.manage')
  @HttpCode(200)
  change(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.templates.change(who(req), id, obj(b));
  }

  /** { reason } */
  @Post(':id/retire')
  @RequireAction('organisation.manage')
  @HttpCode(200)
  retire(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.templates.retire(who(req), id, obj(b).reason);
  }

  /** { reason } */
  @Post(':id/restore')
  @RequireAction('organisation.manage')
  @HttpCode(200)
  restore(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.templates.restore(who(req), id, obj(b).reason);
  }
}
