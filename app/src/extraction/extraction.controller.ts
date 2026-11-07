import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { ExtractionService } from './extraction.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string): string => (UUID.test(v) ? v : fail());
const fail = (): never => {
  throw new NotFoundException();
};
const versionNumber = (v: string): number => (/^[1-9][0-9]{0,8}$/.test(v) ? Number(v) : fail());

@Controller()
export class ExtractionController {
  constructor(private readonly extraction: ExtractionService) {}

  /** Asks the AI to propose decisions, actions, questions and risks from one exact version. Returns at once (202). */
  @Post('notes/:id/versions/:n/extractions')
  @RequireAction('extraction.run')
  @HttpCode(202)
  start(@Param('id') id: string, @Param('n') n: string, @Req() req: HttpRequest) {
    const userId = req.auth?.user.id;
    if (!userId) throw new NotFoundException();
    return this.extraction.request(uuid(id), versionNumber(n), userId);
  }

  @Get('notes/:id/versions/:n/extractions')
  @RequireAction('note.view')
  list(@Param('id') id: string, @Param('n') n: string) {
    return this.extraction.listForVersion(uuid(id), versionNumber(n));
  }

  /** The run's state and, once finished, its proposals. */
  @Get('extractions/:runId')
  @RequireAction('note.view')
  get(@Param('runId') runId: string) {
    return this.extraction.getRun(uuid(runId));
  }

  /** Approve or reject one proposal: { decision, sourceVersionId, occurrence? } (occurrence is needed to approve a quote that repeats). */
  @Post('extractions/:runId/items/:itemId/review')
  @RequireAction('proposal.review')
  @HttpCode(200)
  review(@Param('runId') runId: string, @Param('itemId') itemId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const userId = req.auth?.user.id;
    if (!userId) throw new NotFoundException();
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return this.extraction.review(uuid(runId), uuid(itemId), {
      decision: b.decision,
      sourceVersionId: b.sourceVersionId,
      occurrence: b.occurrence,
    }, userId);
  }

  /** Replace a proposal's wording: { sourceVersionId, text, owner?, due? }. Sends it back to review. */
  @Post('extractions/:runId/items/:itemId/edit')
  @RequireAction('proposal.review')
  @HttpCode(200)
  edit(@Param('runId') runId: string, @Param('itemId') itemId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const userId = req.auth?.user.id;
    if (!userId) throw new NotFoundException();
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return this.extraction.edit(uuid(runId), uuid(itemId), { sourceVersionId: b.sourceVersionId, text: b.text, owner: b.owner, due: b.due }, userId);
  }
}
