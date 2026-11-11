import { Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { DigestsService } from './digests.service';

const who = (req: HttpRequest) => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller()
export class DigestsController {
  constructor(private readonly digests: DigestsService) {}

  @Get('projects/:id/digest/preview')
  @AnySignedInUser()
  preview(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.digests.preview(who(req), id);
  }

  @Post('projects/:id/digest')
  @HttpCode(201)
  @AnySignedInUser()
  send(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.digests.send(who(req), id);
  }
}
