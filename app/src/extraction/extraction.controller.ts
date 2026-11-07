import { Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
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
}
