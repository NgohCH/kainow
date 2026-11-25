import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { DepartmentTransferService } from './department-transfer.service';
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
  constructor(
    private readonly projects: ProjectsService,
    private readonly transfers: DepartmentTransferService,
  ) {}

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

  /** → { department, filedFiles, transfer } — Enterprise Administrator only (spec 10). */
  @Get(':id/owning-department')
  @AnySignedInUser()
  owningDepartment(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.transfers.view(who(req), id);
  }

  /** { departmentId, reason, folderChoice?: 'move' | 'keep' } → { transferId, state } — Enterprise Administrator only (spec 10, D108). */
  @Put(':id/owning-department')
  @AnySignedInUser()
  transferDepartment(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    const input = body(b);
    return this.transfers.transferDepartment(who(req), id, { departmentId: input.departmentId, reason: input.reason, folderChoice: input.folderChoice });
  }

  /** Try again after "Files not moved" → { transferId, state } — Enterprise Administrator only. */
  @Post(':id/owning-department/retry')
  @AnySignedInUser()
  @HttpCode(200)
  retryTransfer(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.transfers.retry(who(req), id);
  }

  /** { stage, substage?, reason? } */
  @Post(':id/stage')
  @AnySignedInUser()
  @HttpCode(200)
  stage(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.changeStage(who(req), id, body(b));
  }

  /** { name, substages?, position, reason } — the project's own stages (D131): Project Manager, Owner or Sponsor. */
  @Post(':id/stages')
  @AnySignedInUser()
  @HttpCode(200)
  addStage(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.addStage(who(req), id, body(b));
  }

  /** { ids, reason } — every stage of the project, once, in the new order. */
  @Post(':id/stages/order')
  @AnySignedInUser()
  @HttpCode(200)
  orderStages(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.reorderStages(who(req), id, body(b));
  }

  /** { reason } — not the current stage. */
  @Post(':id/stages/:stageId/retire')
  @AnySignedInUser()
  @HttpCode(200)
  retireStage(@Param('id') id: string, @Param('stageId') stageId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.setStageStatus(who(req), id, stageId, 'retired', body(b));
  }

  /** { reason } */
  @Post(':id/stages/:stageId/restore')
  @AnySignedInUser()
  @HttpCode(200)
  restoreStage(@Param('id') id: string, @Param('stageId') stageId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.setStageStatus(who(req), id, stageId, 'active', body(b));
  }

  /** { name, reason } — past periods follow; the template keeps its name. */
  @Post(':id/stages/:stageId/rename')
  @AnySignedInUser()
  @HttpCode(200)
  renameStage(@Param('id') id: string, @Param('stageId') stageId: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.projects.renameStage(who(req), id, stageId, body(b));
  }
}
