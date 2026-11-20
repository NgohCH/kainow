import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req, Res } from '@nestjs/common';
import { RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import type { AuthUser } from '../auth/tokens';
import { StorageAdminsService } from './admins.service';
import { DestinationsService, parseAddBody } from './destinations.service';
import { ManifestService } from './manifest';
import { SourceAreaMoveService } from './relocate';
import { StorageSummaryService } from './summary.service';
import { StorageSettingsService, parseSecretBody, parseSettingsBody } from './settings.service';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Enterprise Administrator only. The secret body is parsed here and never logged, echoed or put in an error text. */
@Controller('admin/storage')
export class StorageController {
  constructor(
    private readonly settings: StorageSettingsService,
    private readonly destinations: DestinationsService,
    private readonly admins: StorageAdminsService,
    private readonly moves: SourceAreaMoveService,
    private readonly manifest: ManifestService,
    private readonly summaryService: StorageSummaryService,
  ) {}

  /** Everything the Storage page shows at a glance (spec 8.6). */
  @Get('summary')
  @RequireAction('storage.manage')
  summary() {
    return this.summaryService.summary();
  }

  @Get()
  @RequireAction('storage.manage')
  view() {
    return this.settings.view();
  }

  @Put()
  @RequireAction('storage.manage')
  @HttpCode(200)
  change(@Body() body: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    const { reason, patch } = parseSettingsBody(body);
    return this.settings.change(patch, reason, user);
  }

  @Post('secret')
  @RequireAction('storage.manage')
  @HttpCode(200)
  secret(@Body() body: unknown, @Req() req: HttpRequest) {
    const user = who(req);
    const { reason, clientSecret } = parseSecretBody(body);
    return this.settings.saveSecret(clientSecret, reason, user);
  }

  @Post('check')
  @RequireAction('storage.manage')
  @HttpCode(200)
  check() {
    return this.settings.check();
  }

  @Get('destinations')
  @RequireAction('storage.manage')
  listDestinations() {
    return this.destinations.list();
  }

  @Post('destinations')
  @RequireAction('storage.manage')
  addDestination(@Body() body: unknown, @Req() req: HttpRequest) {
    return this.destinations.add(who(req), parseAddBody(body));
  }

  @Post('destinations/:id/check')
  @RequireAction('storage.manage')
  @HttpCode(200)
  checkDestination(@Param('id') id: string, @Req() req: HttpRequest) {
    return this.destinations.check(who(req), id);
  }

  @Post('destinations/:id/approve')
  @RequireAction('storage.manage')
  @HttpCode(200)
  approveDestination(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.destinations.approve(who(req), id, (body as { reason?: unknown } | null)?.reason as string);
  }

  @Get('admins')
  @RequireAction('storage.manage')
  listAdmins() {
    return this.admins.list();
  }

  @Post('admins')
  @RequireAction('storage.manage')
  designateAdmin(@Body() body: unknown, @Req() req: HttpRequest) {
    const b = (body ?? {}) as { userId?: unknown; reason?: unknown };
    return this.admins.designate(who(req), b.userId, b.reason);
  }

  @Post('admins/:id/end')
  @RequireAction('storage.manage')
  @HttpCode(200)
  endAdmin(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.admins.end(who(req), id, (body as { reason?: unknown } | null)?.reason);
  }

  /** The current source area with its file count and size (for the confirmation), and the move in progress with its counts. */
  @Get('source-area/move')
  @RequireAction('storage.manage')
  sourceAreaMove() {
    return this.moves.view();
  }

  /** `{ destinationId, reason, confirm: { files, bytes } }` (spec 9.3). */
  @Post('source-area/move')
  @RequireAction('storage.manage')
  @HttpCode(200)
  moveSourceArea(@Body() body: unknown, @Req() req: HttpRequest) {
    const b = (body ?? {}) as { destinationId?: unknown; reason?: unknown; confirm?: unknown };
    return this.moves.moveSourceArea(who(req), b.destinationId, b.reason, b.confirm);
  }

  /** The storage manifest (spec 9.4): CSV of every stored file's references; the download is recorded. */
  @Get('manifest')
  @RequireAction('storage.manage')
  async downloadManifest(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<string> {
    const built = await this.manifest.download(who(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return built.csv.toString('utf8');
  }

  @Post('destinations/:id/withdraw')
  @RequireAction('storage.manage')
  @HttpCode(200)
  withdrawDestination(@Param('id') id: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.destinations.withdraw(who(req), id, (body as { reason?: unknown } | null)?.reason as string);
  }
}
