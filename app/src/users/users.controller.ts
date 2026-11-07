import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { UsersService } from './users.service';

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @RequireAction('user.manage')
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: HttpRequest) {
    const user = await this.users.create({
      email: field(body, 'email'),
      displayName: field(body, 'displayName'),
      actorUserId: req.auth?.user.id ?? null,
    });
    return { user };
  }

  @Post(':id/disable')
  @RequireAction('user.manage')
  @HttpCode(204)
  async disable(@Param('id') id: string, @Req() req: HttpRequest): Promise<void> {
    await this.users.disable(id, req.auth?.user.id ?? null);
  }
}
