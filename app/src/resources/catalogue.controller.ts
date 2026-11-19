import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { CatalogueService } from './catalogue.service';

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

/** Every route needs a signed-in person; the changes check catalogue maintenance in the service (403 otherwise). */
@Controller('resources/catalogue')
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get()
  @AnySignedInUser()
  list(@Query('all') all: string | undefined, @Req() req: HttpRequest) {
    return this.catalogue.list(who(req), { all: all === '1' || all === 'true' });
  }

  /** { kind, reference, name, categoryId, description? } */
  @Post('items')
  @AnySignedInUser()
  async addItem(@Body() b: unknown, @Req() req: HttpRequest) {
    return { item: await this.catalogue.addItem(who(req), b) };
  }

  @Put('items/:id')
  @AnySignedInUser()
  async editItem(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return { item: await this.catalogue.editItem(who(req), uuid(id), b) };
  }

  /** { reason } */
  @Post('items/:id/retire')
  @HttpCode(200)
  @AnySignedInUser()
  async retireItem(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    await this.catalogue.retireItem(who(req), uuid(id), body(b).reason);
    return { ok: true };
  }

  /** { name } */
  @Post('categories')
  @AnySignedInUser()
  async addCategory(@Body() b: unknown, @Req() req: HttpRequest) {
    return { category: await this.catalogue.addCategory(who(req), b) };
  }

  @Put('categories/:id')
  @AnySignedInUser()
  async renameCategory(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return { category: await this.catalogue.renameCategory(who(req), uuid(id), b) };
  }

  /** { reason } */
  @Post('categories/:id/retire')
  @HttpCode(200)
  @AnySignedInUser()
  async retireCategory(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    await this.catalogue.retireCategory(who(req), uuid(id), body(b).reason);
    return { ok: true };
  }
}
