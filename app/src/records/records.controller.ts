import { Body, Controller, Get, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
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

  @Get('projects/:id/records')
  @AnySignedInUser()
  list(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.records.list(who(req), id);
  }
}
