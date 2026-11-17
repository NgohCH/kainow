import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { CasesService } from './cases.service';
import type { ItemKind } from './registry';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);

/**
 * Reporting a suspected secret and deciding its possible copies (history spec 7.1, 7.4). Every route checks the
 * project (404) and the item's audience (404) before the matrix (403). No answer ever carries the marked text.
 */
@Controller()
export class QuarantineController {
  constructor(private readonly cases: CasesService) {}

  /** { kind, id, marked: string[], reason, holderUserId? } → 201 { caseId }. */
  @Post('projects/:id/secret-reports')
  @AnySignedInUser()
  @HttpCode(201)
  report(@Param('id') projectId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const holder = field(body, 'holderUserId');
    return this.cases.report(who(req), {
      projectId,
      kind: field(body, 'kind') as ItemKind,
      id: typeof field(body, 'id') === 'string' ? (field(body, 'id') as string) : '',
      marked: field(body, 'marked') as string[],
      reason: (field(body, 'reason') ?? null) as string | null,
      ...(holder === undefined || holder === null ? {} : { holderUserId: String(holder) }),
    });
  }

  /** → { cases }: the Held for review list; PM, Owner and Sponsor, each seeing the cases whose item they can read. */
  @Get('projects/:id/held')
  @AnySignedInUser()
  held(@Param('id') projectId: string, @Req() req: HttpRequest) {
    return this.cases.heldForReview(who(req), projectId);
  }

  /** → the case with the item's cleaned text and the place of each [credential removed]; never the original. */
  @Get('quarantine/cases/:id')
  @AnySignedInUser()
  view(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.cases.cleanedView(who(req), id);
  }

  /** { marked: string[] } → { caseId, rows, places }: further text cleaned into the same case. */
  @Post('quarantine/cases/:id/mark-more')
  @AnySignedInUser()
  @HttpCode(200)
  markMore(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.cases.markMore(who(req), id, field(body, 'marked'));
  }

  /** { reason } → { caseId, state: 'released', copies }. */
  @Post('quarantine/cases/:id/release')
  @AnySignedInUser()
  @HttpCode(200)
  release(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.cases.release(who(req), id, { reason: field(body, 'reason') });
  }

  /** → { copies }: the places found holding the same text; PM and Deputy only. */
  @Get('quarantine/cases/:id/copies')
  @AnySignedInUser()
  copies(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.cases.copies(who(req), id);
  }

  /** { decisions: [{ kind, id, decision: 'confirmed' | 'dismissed' }] } → { decided }. */
  @Post('quarantine/cases/:id/copies')
  @AnySignedInUser()
  @HttpCode(200)
  decide(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.cases.decideCopies(who(req), id, field(body, 'decisions') as never);
  }
}
