import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { ProjectAccess } from '../projects/access.service';
import { type ProjectAction, decide } from '../projects/matrix';
import { ExtractionService } from './extraction.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string): string => (UUID.test(v) ? v : fail());
const fail = (): never => {
  throw new NotFoundException();
};
const versionNumber = (v: string): number => (/^[1-9][0-9]{0,8}$/.test(v) ? Number(v) : fail());
const who = (req: HttpRequest): AuthUser => req.auth?.user ?? fail();
const bodyOf = (body: unknown): Record<string, unknown> => (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

export const MISSING_ACCOUNTABILITY = 'The project is missing a required role, so proposals cannot be approved until it is repaired.';

/** Extraction and review. Every route is checked against the project the note or run belongs to. */
@Controller()
export class ExtractionController {
  constructor(
    private readonly extraction: ExtractionService,
    private readonly access: ProjectAccess,
  ) {}

  private async forSource(req: HttpRequest, sourceId: string, action: ProjectAction) {
    return this.access.authorize(who(req), action, await this.access.projectOfSource(uuid(sourceId)));
  }

  private async forRun(req: HttpRequest, runId: string, action: ProjectAction) {
    return this.access.authorize(who(req), action, await this.access.projectOfRun(uuid(runId)));
  }

  /** Asks the AI to propose decisions, actions, questions and risks from one exact version. Returns at once (202). */
  @Post('notes/:id/versions/:n/extractions')
  @AnySignedInUser()
  @HttpCode(202)
  async start(@Param('id') id: string, @Param('n') n: string, @Req() req: HttpRequest) {
    await this.forSource(req, id, 'extraction.run');
    return this.extraction.request(id, versionNumber(n), who(req).id);
  }

  @Get('notes/:id/versions/:n/extractions')
  @AnySignedInUser()
  async list(@Param('id') id: string, @Param('n') n: string, @Req() req: HttpRequest) {
    await this.forSource(req, id, 'note.view');
    return this.extraction.listForVersion(id, versionNumber(n));
  }

  /** The run's state and, once finished, its proposals. */
  @Get('extractions/:runId')
  @AnySignedInUser()
  async get(@Param('runId') runId: string, @Req() req: HttpRequest) {
    const ctx = await this.forRun(req, runId, 'note.view');
    const view = await this.extraction.getRun(runId);
    // What this viewer may do here, so the page offers only those controls and says why not.
    const review = decide({ action: 'proposal.review', roles: ctx.roles, status: ctx.project.status });
    const edit = decide({ action: 'proposal.edit', roles: ctx.roles, status: ctx.project.status });
    const approve = review.allowed && !ctx.missingAccountability;
    const note = !review.allowed ? review.reason : ctx.missingAccountability ? MISSING_ACCOUNTABILITY : null;
    return { ...view, projectId: ctx.project.id, permissions: { approve, reject: review.allowed, edit: edit.allowed, note } };
  }

  /** Approve or reject one proposal: { decision, sourceVersionId, occurrence? } (occurrence is needed to approve a quote that repeats). */
  @Post('extractions/:runId/items/:itemId/review')
  @AnySignedInUser()
  @HttpCode(200)
  async review(@Param('runId') runId: string, @Param('itemId') itemId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    const ctx = await this.forRun(req, runId, 'proposal.review');
    // No new authorisations while a required role is missing (V1.0 role rules); rejection is allowed.
    const b = bodyOf(body);
    if (ctx.missingAccountability && b.decision === 'approved') throw new ConflictException(MISSING_ACCOUNTABILITY);
    return this.extraction.review(runId, uuid(itemId), { decision: b.decision, sourceVersionId: b.sourceVersionId, occurrence: b.occurrence }, who(req).id);
  }

  /** The meeting date for one note version, when the notes do not give it or give it wrongly: { meetingDate: 'YYYY-MM-DD' }. */
  @Post('notes/:id/versions/:n/meeting-date')
  @AnySignedInUser()
  @HttpCode(200)
  async setMeetingDate(@Param('id') id: string, @Param('n') n: string, @Body() body: unknown, @Req() req: HttpRequest) {
    await this.forSource(req, id, 'meeting_date.set');
    return this.extraction.setMeetingDate(id, versionNumber(n), bodyOf(body).meetingDate, who(req).id);
  }

  /** Replace a proposal's wording: { sourceVersionId, text, owner?, due?, dueEarliest?, dueLatest?, dueEvent?, ignoreModelEvent? }. Sends it back to review. */
  @Post('extractions/:runId/items/:itemId/edit')
  @AnySignedInUser()
  @HttpCode(200)
  async edit(@Param('runId') runId: string, @Param('itemId') itemId: string, @Body() body: unknown, @Req() req: HttpRequest) {
    await this.forRun(req, runId, 'proposal.edit');
    const b = bodyOf(body);
    return this.extraction.edit(
      runId,
      uuid(itemId),
      { sourceVersionId: b.sourceVersionId, text: b.text, owner: b.owner, due: b.due, dueEarliest: b.dueEarliest, dueLatest: b.dueLatest, dueEvent: b.dueEvent, ignoreModelEvent: b.ignoreModelEvent },
      who(req).id,
    );
  }
}
