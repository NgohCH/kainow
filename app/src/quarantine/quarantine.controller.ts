import { Body, Controller, Get, Header, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { CasesService } from './cases.service';
import type { ItemKind } from './registry';
import { SecurityService } from './security.service';

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

  /** → { cases }: open cases with places awaiting a decision; PM and Deputy. */
  @Get('projects/:id/possible-copies')
  @AnySignedInUser()
  copiesAwaiting(@Param('id') projectId: string, @Req() req: HttpRequest) {
    return this.cases.copiesAwaiting(who(req), projectId);
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

/**
 * Security reviewers, quarantined-original grants, Reveal original, Release unchanged and the Administrators' case list
 * (history spec 6, 7.6, 7.7). Every check is in SecurityService, with a plain sentence: Administrator actions answer 403
 * to anyone else; reviewer actions answer 403 without a designation or a current grant naming the case.
 */
@Controller('security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  /** → { reviewers }: the Organisation page's Security reviewers section. Administrators only. */
  @Get('reviewers')
  @AnySignedInUser()
  reviewers(@Req() req: HttpRequest) {
    return this.security.reviewers(who(req));
  }

  /** { reason } → designated; never yourself. */
  @Post('reviewers/:userId/designate')
  @AnySignedInUser()
  @HttpCode(200)
  designate(@Param('userId') userId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.security.designate(who(req), userId, { reason: field(body, 'reason') });
  }

  /** { reason } → no longer a reviewer; never yourself. */
  @Post('reviewers/:userId/undesignate')
  @AnySignedInUser()
  @HttpCode(200)
  undesignate(@Param('userId') userId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.security.undesignate(who(req), userId, { reason: field(body, 'reason') });
  }

  /** → { reviewer }: whether the signed-in person is a designated security reviewer (the header's Security review link). */
  @Get('me')
  @AnySignedInUser()
  me(@Req() req: HttpRequest) {
    return this.security.me(who(req));
  }

  /** → { cases }: every case by reference, project and kind, with disclosures; for a security reviewer. */
  @Get('cases')
  @AnySignedInUser()
  cases(@Req() req: HttpRequest) {
    return this.security.cases(who(req));
  }

  /** → { cases }: every case (project, item kind, reporter, state, waiting for the key, disclosures); Administrators. */
  @Get('admin-cases')
  @AnySignedInUser()
  adminCases(@Req() req: HttpRequest) {
    return this.security.adminCases(who(req));
  }

  /** → { grants }: every grant for an Administrator, a reviewer's own otherwise. */
  @Get('grants')
  @AnySignedInUser()
  grants(@Req() req: HttpRequest) {
    return this.security.grants(who(req));
  }

  /** { caseIds, purpose, hours? = 24 } → 201 { grantId }. */
  @Post('grants')
  @AnySignedInUser()
  @HttpCode(201)
  request(@Body() body: unknown, @Req() req: HttpRequest) {
    return this.security.requestGrant(who(req), { caseIds: field(body, 'caseIds'), purpose: field(body, 'purpose'), hours: field(body, 'hours') });
  }

  /** { decision: 'approved' | 'declined', reason } by an Administrator other than the requester. */
  @Post('grants/:id/decide')
  @AnySignedInUser()
  @HttpCode(200)
  decide(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.security.decideGrant(who(req), id, { decision: field(body, 'decision'), reason: field(body, 'reason') });
  }

  /** { hours? = 24, reason } → 201 { grantId }: a fresh approval by an Administrator other than the requester. */
  @Post('grants/:id/extend')
  @AnySignedInUser()
  @HttpCode(201)
  extend(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.security.extendGrant(who(req), id, { hours: field(body, 'hours'), reason: field(body, 'reason') });
  }

  /** { reason }: any Administrator. */
  @Post('grants/:id/revoke')
  @AnySignedInUser()
  @HttpCode(200)
  revoke(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.security.revokeGrant(who(req), id, { reason: field(body, 'reason') });
  }

  /** { confirm: true } → the item's original text values with the removed spans marked. Never cached. */
  @Post('cases/:caseId/items/:kind/:itemId/reveal')
  @AnySignedInUser()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reveal(@Param('caseId') caseId: string, @Param('kind') kind: string, @Param('itemId') itemId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.security.reveal(who(req), caseId, kind, itemId, { confirm: field(body, 'confirm') });
  }

  /** { reason } → { caseId, state: 'released_unchanged', restored, changed }. */
  @Post('cases/:caseId/release-unchanged')
  @AnySignedInUser()
  @HttpCode(200)
  releaseUnchanged(@Param('caseId') caseId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.security.releaseUnchanged(who(req), caseId, { reason: field(body, 'reason') });
  }
}
