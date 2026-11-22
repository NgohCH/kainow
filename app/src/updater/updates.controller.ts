import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Pool } from 'pg';
import { AllowedWhenProtective, AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { runningVersion } from '../common/version';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { EMAIL_NUDGE, type EmailNudge } from '../email/nudge';
import { checkReleases, latestCheck, newestAvailable } from './release-check';
import { approveUpdate, cancelUpdate, currentUpdate, needsRecovery, rescheduleUpdate, scheduledBanner, updateHistory } from './updates.service';

const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

/** Check now: at most once a minute per installation (spec 6.2). */
export const CHECK_NOW_INTERVAL_MS = 60_000;
export const CHECK_NOW_TOO_SOON = { code: 'check_too_soon', message: 'Releases were checked less than a minute ago. Try again in a minute.' };

/** The Updates section of the Operations page (10b spec 6, 11) and the scheduled-update banner for everyone. */
@Controller()
export class UpdatesController {
  private checking = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_NUDGE) private readonly nudge: EmailNudge,
  ) {}

  @Get('admin/updates')
  @RequireAction('operations.view')
  async view() {
    const now = this.now();
    const running = runningVersion();
    const [lastCheck, newest, current, history, recovery, tick] = await Promise.all([
      latestCheck(this.pool, now),
      newestAvailable(this.pool, running),
      currentUpdate(this.pool),
      updateHistory(this.pool),
      needsRecovery(this.pool),
      this.pool.query(`SELECT key_fingerprint FROM updater_ticks ORDER BY at DESC, id DESC LIMIT 1`),
    ]);
    const repo = this.config.release.repo;
    return {
      running,
      keyFingerprint: (tick.rows[0]?.key_fingerprint as string | null | undefined) ?? null,
      lastCheck,
      available: newest ? { tag: newest.tag, commit: newest.commit, releaseUrl: `https://github.com/${repo}/releases/tag/${newest.tag}` } : null,
      current,
      history,
      needsRecovery: recovery,
    };
  }

  /** Runs the release check now; 429 within a minute of the last manual check. It only reads and records, so it runs in protective mode too. */
  @Post('admin/updates/check')
  @HttpCode(200)
  @RequireAction('operations.view')
  @AllowedWhenProtective()
  async check(@Req() req: HttpRequest) {
    const now = this.now();
    const last = (await this.pool.query(`SELECT max(at) AS at FROM release_checks WHERE trigger = 'manual'`)).rows[0]?.at as Date | null;
    if (this.checking || (last && now.getTime() - last.getTime() < CHECK_NOW_INTERVAL_MS)) {
      throw new HttpException(CHECK_NOW_TOO_SOON, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.checking = true;
    try {
      const { repo, api } = this.config.release;
      const result = await checkReleases({ pool: this.pool, fetch, repo, api, runningVersion: runningVersion(), now }, 'manual', who(req).id);
      await this.nudge.nudge();
      return { result, lastCheck: await latestCheck(this.pool, now) };
    } finally {
      this.checking = false;
    }
  }

  /** { tag, startsAt, expectedMinutes, reason } → 201 UpdateView. */
  @Post('admin/updates')
  @RequireAction('operations.manage')
  async approve(@Body() b: unknown, @Req() req: HttpRequest) {
    const view = await approveUpdate(this.pool, who(req).id, body(b), this.now(), runningVersion());
    await this.nudge.nudge();
    return view;
  }

  /** { startsAt, expectedMinutes, reason }; only before the update starts. */
  @Post('admin/updates/:id/reschedule')
  @HttpCode(200)
  @RequireAction('operations.manage')
  async reschedule(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    const view = await rescheduleUpdate(this.pool, who(req).id, id, body(b), this.now());
    await this.nudge.nudge();
    return view;
  }

  /**
   * { reason }; only before the update starts. Allowed in protective mode (final review M7): it touches only the update's
   * own rows and the outbox, and otherwise an update approved before low space would fail at its window instead.
   */
  @Post('admin/updates/:id/cancel')
  @HttpCode(200)
  @RequireAction('operations.manage')
  @AllowedWhenProtective()
  async cancel(@Param('id') id: string, @Body() b: unknown, @Req() req: HttpRequest) {
    const view = await cancelUpdate(this.pool, who(req).id, id, body(b), this.now());
    await this.nudge.nudge();
    return view;
  }

  /** Any signed-in person: the scheduled update, from approval until it starts. */
  @Get('updates/banner')
  @AnySignedInUser()
  async banner() {
    const s = await scheduledBanner(this.pool, this.now());
    return { scheduled: s ? { startsAt: s.startsAt, expectedMinutes: s.expectedMinutes, text: s.text } : null };
  }
}
