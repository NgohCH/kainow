import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { DuplicateService } from './duplicate.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Duplicating a project (D140). Access is decided per project inside the service. */
@Controller('projects/:id/duplicate')
export class DuplicateController {
  constructor(private readonly duplicates: DuplicateService) {}

  /** Everything offered for the new project, with a key per text. Nothing is created. */
  @Get()
  @AnySignedInUser()
  offer(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.duplicates.offer(who(req), id);
  }

  /**
   * { asOf (as GET gave it), name, plannedEnd | noPlannedEnd, purpose, purposeConfirmed?, owningDepartmentId, contributingDepartmentIds,
   *   stages: [{ id?, name, substages: [{ key?, name }] }], holidays: [{ id?, date, name }],
   *   settings?: { requiredApprovals?, notifications?, outputs? },
   *   tasks: [{ id, title, description?, due?, subtasks: [{ id, title, description?, due? }] }], risks: [{ id, text }],
   *   resources: [{ id, quantity?, unit?, description? }], oldTerms, confirmedKeys } → the new project's details.
   * 409 when the original is under review or changed under review since `asOf`, or the same Create was just made.
   * Another refusal (400) carries `problems`, and `terms` ([{ key, term }]) for texts that still hold an old term.
   */
  @Post()
  @AnySignedInUser()
  @HttpCode(201)
  duplicate(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.duplicates.duplicate(who(req), id, b);
  }
}
