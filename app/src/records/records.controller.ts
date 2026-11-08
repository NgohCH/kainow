import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { RecordsService } from './records.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Authorised records. Access is decided per project by ProjectAccess inside the service. */
@Controller()
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  /**
   * Authorise one proposal into its record. 201 when created; 200 with the existing record when the proposal
   * was already authorised (a repeated click). Body by kind: task { assigneeId | inviteEmail, dueOn, subtasks? },
   * question { requesterId? }, risk { severity, responsibleId?, reviewOn? }, decision { rationale? }.
   */
  @Post('extractions/:runId/items/:itemId/authorise')
  @AnySignedInUser()
  async authorise(
    @Param('runId') runId: string,
    @Param('itemId') itemId: string,
    @Body() b: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: { status: (n: number) => void },
  ) {
    const { created, ...out } = await this.records.authoriseItem(who(req), runId, itemId, body(b));
    res.status(created ? 201 : 200);
    return out;
  }

  /** A person's own proposal: { kind: 'action' | 'decision' | 'question' | 'risk', text, owner?, due? } */
  @Post('projects/:id/proposals')
  @AnySignedInUser()
  @HttpCode(201)
  propose(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.records.propose(who(req), id, body(b));
  }

  @Get('projects/:id/proposals')
  @AnySignedInUser()
  proposals(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.records.proposals(who(req), id);
  }

  /** Same body as authorising an extraction proposal; 201 when created, 200 when already authorised. */
  @Post('proposals/:id/authorise')
  @AnySignedInUser()
  async authoriseProposal(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest, @Res({ passthrough: true }) res: { status: (n: number) => void }) {
    const { created, ...out } = await this.records.authoriseProposal(who(req), id, body(b));
    res.status(created ? 201 : 200);
    return out;
  }

  /** { reason } */
  @Post('proposals/:id/reject')
  @AnySignedInUser()
  @HttpCode(200)
  rejectProposal(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    return this.records.rejectProposal(who(req), id, body(b));
  }

  @Get('projects/:id/records')
  @AnySignedInUser()
  list(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.records.list(who(req), id);
  }
}
