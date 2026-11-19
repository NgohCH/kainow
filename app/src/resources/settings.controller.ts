import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Post, Put, Req } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { MaintainersService, ResourceSettingsService } from './settings.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller('admin/resources/settings')
export class ResourceSettingsController {
  constructor(private readonly settings: ResourceSettingsService) {}

  @Get()
  @RequireAction('resources.settings.manage')
  get() {
    return this.settings.get();
  }

  /** { projectsMayManageFinance?, defaultCurrency?, enabledCurrencies?, warnFirstPct?, warnSecondPct?, reason } */
  @Put()
  @RequireAction('resources.settings.manage')
  async update(@Body() b: unknown, @Req() req: HttpRequest) {
    const { reason, ...next } = body(b);
    await this.settings.update(who(req), next, reason);
    return this.settings.get();
  }
}

@Controller('admin/resources/maintainers')
export class MaintainersController {
  constructor(private readonly maintainers: MaintainersService) {}

  @Get()
  @RequireAction('resources.settings.manage')
  async list() {
    return { maintainers: await this.maintainers.list() };
  }

  /** { userId, reason } */
  @Post()
  @RequireAction('resources.settings.manage')
  async add(@Body() b: unknown, @Req() req: HttpRequest) {
    const { userId, reason } = body(b);
    await this.maintainers.add(who(req), userId, reason);
    return { maintainers: await this.maintainers.list() };
  }

  /** { userId, reason } */
  @Delete()
  @HttpCode(200)
  @RequireAction('resources.settings.manage')
  async remove(@Body() b: unknown, @Req() req: HttpRequest) {
    const { userId, reason } = body(b);
    await this.maintainers.remove(who(req), userId, reason);
    return { maintainers: await this.maintainers.list() };
  }
}
