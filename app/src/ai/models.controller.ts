import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { RequireAction, RequireAnyAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { readReason } from '../common/reason';
import { ModelsService, describeModel, parseModelBody } from './models.service';

@Controller('ai/models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  /** The catalogue. Project managers read it to pick a model, so spend.view is enough. */
  @Get()
  @RequireAnyAction('ai.settings.manage', 'spend.view')
  async list() {
    return { models: (await this.models.list()).map(describeModel) };
  }

  @Post()
  @RequireAction('ai.settings.manage')
  async approve(@Body() body: unknown, @Req() req: HttpRequest) {
    const { input, reason } = parseModelBody(body);
    return { model: describeModel(await this.models.approve(input, reason, req.auth?.user.id ?? null)) };
  }

  @Put(':id')
  @RequireAction('ai.settings.manage')
  @HttpCode(200)
  async change(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const { input, reason } = parseModelBody(body);
    return { model: describeModel(await this.models.change(id, input, reason, req.auth?.user.id ?? null)) };
  }

  @Post(':id/withdraw')
  @RequireAction('ai.settings.manage')
  @HttpCode(200)
  async withdraw(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const reason = readReason((body as { reason?: unknown } | null | undefined)?.reason);
    return { model: describeModel(await this.models.withdraw(id, reason, req.auth?.user.id ?? null)) };
  }
}
