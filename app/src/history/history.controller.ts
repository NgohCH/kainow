import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AllowedWhenProtective, AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { RecordDelegationService } from './delegation.service';
import { HistoryService } from './history.service';
import { RecordsDeletionService } from './records-deletion.service';
import { SourcesDeletionService } from './sources-deletion.service';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

const reasonOf = (body: unknown): { reason?: unknown } => ({ reason: body && typeof body === 'object' ? (body as Record<string, unknown>).reason : undefined });

/** Deleting and restoring (history spec 4). Every route checks the item's project and audience first (404), then the matrix (403). */
@Controller()
export class HistoryController {
  constructor(
    private readonly sources: SourcesDeletionService,
    private readonly records: RecordsDeletionService,
    private readonly delegation: RecordDelegationService,
    private readonly history: HistoryService,
  ) {}

  /** → { lines }: the project's deletions, restorations and credential reports, newest first (spec 4.6). */
  @Get('projects/:id/history/deletions')
  @AnySignedInUser()
  async deletions(@Param('id') id: string, @Req() req: HttpRequest) {
    return { lines: await this.history.deletions(who(req), id) };
  }

  /** → { items }: Deleted items, for holders of Inspect Deleted Content only (404 otherwise) (spec 4.7). */
  @Get('projects/:id/deleted-items')
  @AnySignedInUser()
  async deletedItems(@Param('id') id: string, @Req() req: HttpRequest) {
    return { items: await this.history.deletedItems(who(req), id) };
  }

  /** One Deleted item, read-only; each opening is recorded (deleted.inspected). :kind is message, note, minutes, summary, task, decision, question or risk. */
  @Get('projects/:id/deleted-items/:kind/:itemId')
  @AnySignedInUser()
  // GET audit (spec 7.3): the opening is recorded (deleted.inspected), in protective mode too.
  @AllowedWhenProtective()
  deletedItem(@Param('id') id: string, @Param('kind') kind: string, @Param('itemId') itemId: string, @Req() req: HttpRequest) {
    return this.history.deletedItem(who(req), id, kind, itemId);
  }

  /** { reason } → { id, status: 'deleted' }. */
  @Post('sources/:id/delete')
  @AnySignedInUser()
  @HttpCode(200)
  deleteSource(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.sources.delete(who(req), id, reasonOf(body));
  }

  /** → { names }: who will be able to see the source again. */
  @Get('sources/:id/restore-preview')
  @AnySignedInUser()
  restorePreview(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.sources.restorePreview(who(req), id);
  }

  /** { reason } → { id, status: 'active' }. */
  @Post('sources/:id/restore')
  @AnySignedInUser()
  @HttpCode(200)
  restoreSource(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.sources.restore(who(req), id, reasonOf(body));
  }

  /** :kind is task, decision, question or risk. { reason } → { kind, id, deleted: true }. */
  @Post('records/:kind/:id/delete')
  @AnySignedInUser()
  @HttpCode(200)
  deleteRecord(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.records.delete(who(req), kind, id, reasonOf(body));
  }

  /** → { names }: everyone who will be able to see the record again. */
  @Get('records/:kind/:id/restore-preview')
  @AnySignedInUser()
  recordRestorePreview(@Param('kind') kind: string, @Param('id') id: string, @Req() req: HttpRequest) {
    return this.records.restorePreview(who(req), kind, id);
  }

  /** { reason } → { kind, id, deleted: false, status }. */
  @Post('records/:kind/:id/restore')
  @AnySignedInUser()
  @HttpCode(200)
  restoreRecord(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.records.restore(who(req), kind, id, reasonOf(body));
  }

  /** { reason } by an Owner or Sponsor: the Project Manager may delete and restore authorised records (D83). */
  @Post('projects/:id/record-deletion-delegation')
  @AnySignedInUser()
  @HttpCode(200)
  delegate(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.delegation.delegate(who(req), id, reasonOf(body));
  }

  /** { reason } by any Owner or Sponsor. */
  @Post('projects/:id/record-deletion-delegation/revoke')
  @AnySignedInUser()
  @HttpCode(200)
  revokeDelegation(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.delegation.revoke(who(req), id, reasonOf(body));
  }
}
