import { Body, Controller, Get, HttpCode, NotFoundException, Post, Req } from '@nestjs/common';
import { BeforeSetup, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { OrganisationProfileService } from './organisation.service';

const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);
const actor = (req: HttpRequest): string => {
  const userId = req.auth?.user.id;
  if (!userId) throw new NotFoundException();
  return userId;
};

/** The organisation's name and setup. Open before setup: this is where setup happens. */
@BeforeSetup()
@Controller('organisation')
export class OrganisationProfileController {
  constructor(private readonly organisation: OrganisationProfileService) {}

  @Get()
  @RequireAction('organisation.manage')
  async get() {
    return this.organisation.get();
  }

  @Post('name')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  async setName(@Body() body: unknown, @Req() req: HttpRequest) {
    return this.organisation.setName(field(body, 'name'), actor(req));
  }

  @Post('finish')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  async finish(@Req() req: HttpRequest) {
    return this.organisation.finish(actor(req));
  }
}
