import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ChangesService } from './changes.service';
import { DeadlineService } from './deadline.service';
import { FlagsService } from './flags.service';
import type { TargetKind } from './handlers';
import type { ChangeKind } from './rules';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Change requests. Access is decided per project inside the service. */
@Controller()
export class ChangesController {
  constructor(
    private readonly changes: ChangesService,
    private readonly flags: FlagsService,
    private readonly deadline: DeadlineService,
  ) {}

  /** { kind, targetKind, targetId, terms, reason?, batchId?, approve? } — `approve: true` also approves it, for an Owner or Sponsor. */
  @Post('projects/:id/changes')
  @AnySignedInUser()
  @HttpCode(201)
  submit(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    const x = body(b);
    return this.changes.submit(
      who(req),
      id,
      {
        kind: x.kind as ChangeKind,
        targetKind: x.targetKind as TargetKind,
        targetId: typeof x.targetId === 'string' ? x.targetId : '',
        terms: (x.terms ?? {}) as Record<string, unknown>,
        batchId: typeof x.batchId === 'string' ? x.batchId : null,
        reason: typeof x.reason === 'string' ? x.reason : null,
      },
      { approveNow: x.approve === true },
    );
  }

  @Get('projects/:id/changes')
  @AnySignedInUser()
  async list(@Param('id') id: string, @Req() req: HttpRequest) {
    return { requests: await this.changes.list(who(req), id) };
  }

  /** The marked tasks of a Deferred, Closed or Active project, for the Project Manager or a Deputy. */
  @Get('projects/:id/deadline-review')
  @AnySignedInUser()
  deadlineReview(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.deadline.view(who(req), id);
  }

  /** { tasks: [{ taskId, dueOn }] } — one deadline_review request per task, in one batch. */
  @Post('projects/:id/deadline-review')
  @AnySignedInUser()
  @HttpCode(201)
  submitDeadlineReview(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.deadline.submit(who(req), id, body(b));
  }

  /** Approves every waiting request of the batch that the signed-in Owner or Sponsor may approve. */
  @Post('changes/batch/:batchId/approve')
  @AnySignedInUser()
  @HttpCode(200)
  approveBatch(@Param('batchId') batchId: string, @Req() req: HttpRequest) {
    return this.deadline.approveBatch(who(req), batchId);
  }

  /** { note } by the Project Manager or a Deputy. */
  @Post('review-flags/:id/clear')
  @AnySignedInUser()
  @HttpCode(200)
  clearFlag(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.flags.clear(who(req), id, body(b).note);
  }

  /** { version, terms? } */
  @Post('changes/:id/approve')
  @AnySignedInUser()
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.changes.approve(who(req), id, body(b));
  }

  /** { reason } */
  @Post('changes/:id/reject')
  @AnySignedInUser()
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.changes.reject(who(req), id, body(b));
  }

  /** { reason } */
  @Post('changes/:id/withdraw')
  @AnySignedInUser()
  @HttpCode(200)
  withdraw(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.changes.withdraw(who(req), id, body(b));
  }

  /** { terms, reason } */
  @Post('changes/:id/revise')
  @AnySignedInUser()
  @HttpCode(200)
  revise(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.changes.revise(who(req), id, body(b));
  }
}
