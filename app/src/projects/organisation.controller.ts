import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { AnySignedInUser, RequireAction, BeforeSetup } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { can } from '../auth/permissions';
import { OrganisationService } from './organisation.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: string): string => {
  if (!UUID.test(v)) throw new NotFoundException();
  return v;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);
const actor = (req: HttpRequest): string => {
  const userId = req.auth?.user.id;
  if (!userId) throw new NotFoundException();
  return userId;
};

@BeforeSetup()
@Controller()
export class OrganisationController {
  constructor(private readonly org: OrganisationService) {}

  /** Active departments, for choosing an owning department. Administrators may also list retired ones. */
  @Get('departments')
  @AnySignedInUser()
  async departments(@Query('all') all: string | undefined, @Req() req: HttpRequest) {
    const includeRetired = all === '1' && can(req.auth?.user.role, 'organisation.manage');
    return { departments: await this.org.listDepartments(includeRetired) };
  }

  @Post('departments')
  @RequireAction('organisation.manage')
  @HttpCode(201)
  async addDepartment(@Body() body: unknown, @Req() req: HttpRequest) {
    return { department: await this.org.addDepartment(field(body, 'name'), actor(req)) };
  }

  @Post('departments/:id/rename')
  @RequireAction('organisation.manage')
  @HttpCode(200)
  async renameDepartment(@Param('id') d: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return { department: await this.org.renameDepartment(id(d), field(body, 'name'), actor(req)) };
  }

  @Post('departments/:id/retire')
  @RequireAction('organisation.manage')
  @HttpCode(200)
  async retireDepartment(@Param('id') d: string, @Req() req: HttpRequest) {
    return { department: await this.org.retireDepartment(id(d), actor(req)) };
  }

  @Get('domains')
  @RequireAction('organisation.manage')
  async domains() {
    return { domains: await this.org.listDomains() };
  }

  @Post('domains')
  @RequireAction('organisation.manage')
  @HttpCode(201)
  async addDomain(@Body() body: unknown, @Req() req: HttpRequest) {
    return { domain: await this.org.addDomain(field(body, 'domain'), actor(req)) };
  }

  @Post('domains/:id/remove')
  @RequireAction('organisation.manage')
  @HttpCode(200)
  async removeDomain(@Param('id') d: string, @Req() req: HttpRequest) {
    return this.org.removeDomain(id(d), actor(req));
  }
}
