import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { UsersService } from './users.service';

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequireAction('user.manage')
  async list() {
    return { users: await this.users.list() };
  }

  @Post()
  @RequireAction('user.manage')
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: HttpRequest) {
    const user = await this.users.create({
      email: field(body, 'email'),
      displayName: field(body, 'displayName'),
      actorUserId: req.auth?.user.id ?? null,
      requireEligibleDomain: true,
    });
    return { user };
  }

  /** { departmentId | null } → { department }; information only, it gives no access (D134). */
  @Put(':id/department')
  @RequireAction('user.manage')
  async department(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return { department: await this.users.setDepartment(id, field(body, 'departmentId'), req.auth?.user.id ?? null) };
  }

  @Post(':id/disable')
  @RequireAction('user.manage')
  @HttpCode(204)
  async disable(@Param('id') id: string, @Req() req: HttpRequest): Promise<void> {
    await this.users.disable(id, req.auth?.user.id ?? null);
  }

  @Post(':id/enable')
  @RequireAction('user.manage')
  @HttpCode(204)
  async enable(@Param('id') id: string, @Req() req: HttpRequest): Promise<void> {
    await this.users.enable(id, req.auth?.user.id ?? null);
  }
}
