import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ProjectsService } from './projects.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Project routes. Access is decided per project by ProjectAccess inside the service, not by organisation role. */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @AnySignedInUser()
  list(@Req() req: HttpRequest) {
    return this.projects.list(who(req));
  }

  @Post()
  @AnySignedInUser()
  @HttpCode(201)
  create(@Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.create(who(req), body(b));
  }

  @Get(':id')
  @AnySignedInUser()
  detail(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.projects.detail(who(req), id);
  }

  @Post(':id/edit')
  @AnySignedInUser()
  @HttpCode(200)
  edit(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.edit(who(req), id, body(b));
  }

  /** { to, reason?, outcome?, stage? } */
  @Post(':id/transition')
  @AnySignedInUser()
  @HttpCode(200)
  transition(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.transition(who(req), id, body(b));
  }

  /** { reason } — Closed projects only. */
  @Post(':id/archive')
  @AnySignedInUser()
  @HttpCode(200)
  archive(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.archive(who(req), id, 'archived', body(b));
  }

  /** { reason } */
  @Post(':id/unarchive')
  @AnySignedInUser()
  @HttpCode(200)
  unarchive(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.archive(who(req), id, 'unarchived', body(b));
  }

  /** { departmentId, reason } — Enterprise Administrator only. */
  @Post(':id/department')
  @AnySignedInUser()
  @HttpCode(200)
  department(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.moveDepartment(who(req), id, body(b));
  }

  /** { stage, substage?, reason? } */
  @Post(':id/stage')
  @AnySignedInUser()
  @HttpCode(200)
  stage(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.changeStage(who(req), id, body(b));
  }
}
