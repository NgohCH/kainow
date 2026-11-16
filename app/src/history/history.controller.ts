import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { AnySignedInUser } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
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
  constructor(private readonly sources: SourcesDeletionService) {}

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
}
