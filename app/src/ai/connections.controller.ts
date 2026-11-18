import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ConnectionsService, parseAddBody, parseOrderBody, parseReasonBody, parseReplaceBody } from './connections.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/**
 * Request bodies of add and replace carry an API key: they are parsed here and never logged, echoed or put in an error text.
 * Access is decided in the service.
 */
@Controller('projects/:projectId/ai/connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  @AnySignedInUser()
  list(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.connections.list(projectId, who(req));
  }

  @Post()
  @AnySignedInUser()
  add(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    return this.connections.add(projectId, parseAddBody(body), user);
  }

  // The literal path is declared before the parameterised ones.
  @Put('order')
  @AnySignedInUser()
  @HttpCode(200)
  order(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const { ids, reason } = parseOrderBody(body);
    return this.connections.reorder(projectId, ids, reason, who(req));
  }

  @Put(':cid/key')
  @AnySignedInUser()
  @HttpCode(200)
  replaceKey(@Param('projectId') projectId: string, @Param('cid') cid: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.connections.replaceKey(projectId, cid, parseReplaceBody(body), who(req));
  }

  @Post(':cid/check')
  @AnySignedInUser()
  @HttpCode(200)
  check(@Param('projectId') projectId: string, @Param('cid') cid: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.connections.check(projectId, cid, parseReasonBody(body), who(req));
  }

  @Post(':cid/disable')
  @AnySignedInUser()
  @HttpCode(200)
  disable(@Param('projectId') projectId: string, @Param('cid') cid: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.connections.disable(projectId, cid, parseReasonBody(body), who(req));
  }

  @Post(':cid/enable')
  @AnySignedInUser()
  @HttpCode(200)
  enable(@Param('projectId') projectId: string, @Param('cid') cid: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.connections.enable(projectId, cid, parseReasonBody(body), who(req));
  }
}
