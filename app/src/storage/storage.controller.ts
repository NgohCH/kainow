import { Body, Controller, Get, HttpCode, NotFoundException, Post, Put, Req } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { StorageSettingsService, parseSecretBody, parseSettingsBody } from './settings.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Enterprise Administrator only. The secret body is parsed here and never logged, echoed or put in an error text. */
@Controller('admin/storage')
export class StorageController {
  constructor(private readonly settings: StorageSettingsService) {}

  @Get()
  @RequireAction('storage.manage')
  view() {
    return this.settings.view();
  }

  @Put()
  @RequireAction('storage.manage')
  @HttpCode(200)
  change(@Body() body: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    const { reason, patch } = parseSettingsBody(body);
    return this.settings.change(patch, reason, user);
  }

  @Post('secret')
  @RequireAction('storage.manage')
  @HttpCode(200)
  secret(@Body() body: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    const { reason, clientSecret } = parseSecretBody(body);
    return this.settings.saveSecret(clientSecret, reason, user);
  }

  @Post('check')
  @RequireAction('storage.manage')
  @HttpCode(200)
  check() {
    return this.settings.check();
  }
}
