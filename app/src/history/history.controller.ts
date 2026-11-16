import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
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
  ) {}

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
}
