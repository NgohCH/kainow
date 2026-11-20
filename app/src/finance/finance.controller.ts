import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ChangesService } from '../changes/changes.service';
import { FinanceService } from './finance.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};
const fields = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The project finance view and spending entries (spec 3.5, 11). Who may read or record is decided in the service. */
@Controller('projects/:projectId/finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly changes: ChangesService,
  ) {}

  @Get()
  @AnySignedInUser()
  read(@Param('projectId') projectId: string, @Req() req: HttpRequest) {
    return this.finance.read(who(req), projectId);
  }

  /** { spentOn, amount, currency, description, reference? } */
  @Post('spending')
  @AnySignedInUser()
  @HttpCode(201)
  async record(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return { entry: await this.finance.record(who(req), projectId, body) };
  }

  /**
   * { amount, reason }: a set_budget change request (spec 3.6). An Owner or Sponsor submitting counts as the first
   * approval, so with a policy of 1 the budget is approved at once. Approve, reject, withdraw and revise use the
   * change-request routes.
   */
  @Post('budget')
  @AnySignedInUser()
  @HttpCode(201)
  proposeBudget(@Param('projectId') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const b = fields(body);
    return this.changes.submit(
      who(req),
      projectId,
      { kind: 'set_budget', targetKind: 'project_budget', targetId: projectId, terms: { amount: b.amount, reason: b.reason }, reason: text(b.reason) },
      { approveNow: true },
    );
  }

  /** { type: correction | refund | conversion, amount, rate?, rateOn?, refundOn?, reason }: a finance_adjustment change request. */
  @Post('spending/:entryId/adjust')
  @AnySignedInUser()
  @HttpCode(201)
  adjust(@Param('projectId') projectId: string, @Param('entryId') entryId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const b = fields(body);
    const terms: Record<string, unknown> = { type: b.type, amount: b.amount, reason: b.reason };
    for (const k of ['rate', 'rateOn', 'refundOn'] as const) if (b[k] !== undefined) terms[k] = b[k];
    return this.changes.submit(who(req), projectId, { kind: 'finance_adjustment', targetKind: 'expenditure', targetId: entryId, terms, reason: text(b.reason) });
  }
}
