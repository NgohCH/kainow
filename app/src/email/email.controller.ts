import { ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { Pool } from 'pg';
import { AnySignedInUser, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { cursorTime, parseCursor } from '../common/cursor';
import { UUID } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { NotResendable, OutboxRowNotFound, resend } from './dispatcher';
import { EMAIL_NUDGE, type EmailNudge } from './nudge';
import { writeOutbox } from './outbox';

const PAGE = 50;
export const TEST_SUBJECT = 'Kainow test email';
export const TEST_BODY = 'This is a test email from Kainow. If you received it, email delivery works.';

const who = (req: HttpRequest): AuthUser => {
  const user = req.auth?.user;
  if (!user) throw new NotFoundException();
  return user;
};

@Controller()
export class EmailController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_NUDGE) private readonly emailNudge: EmailNudge,
    private readonly access: ProjectAccess,
  ) {}

  /** The nudge only hurries things along: the outbox row is already committed, so a failure here changes nothing. */
  private async nudge(): Promise<void> {
    try {
      await this.emailNudge.nudge();
    } catch {
      console.error('Could not nudge the email worker.');
    }
  }

  private async history(where: string, params: unknown[], before: string | undefined) {
    const cursor = parseCursor(before);
    const n = params.length;
    const { rows } = await this.pool.query(
      `SELECT o.id, COALESCE(u.display_name, o.to_address) AS "recipientName", o.to_address AS "toAddress", o.kind, o.subject,
              o.created_at AS "createdAt", o.status, o.attempts, o.last_reason AS "lastReason", o.possible_duplicate AS "possibleDuplicate",
              o.resend_of AS "resendOf", o.replaces, ${cursorTime('o.created_at')} AS cur
         FROM email_outbox o LEFT JOIN users u ON u.id = o.to_user_id
        WHERE ${where} AND ($${n + 1}::timestamptz IS NULL OR (o.created_at, o.id) < ($${n + 1}::timestamptz, $${n + 2}::uuid))
        ORDER BY o.created_at DESC, o.id DESC LIMIT ${PAGE + 1}`,
      [...params, cursor?.at ?? null, cursor?.id ?? null],
    );
    const more = rows.length > PAGE;
    const items = rows.slice(0, PAGE).map(({ cur: _cur, ...r }) => r);
    return { items, more, next: more ? `${rows[PAGE - 1].cur}|${rows[PAGE - 1].id}` : null };
  }

  /** Project Manager, Owner or Sponsor of the project. Other readers get 403, non-readers 404. */
  @Get('projects/:id/deliveries')
  @AnySignedInUser()
  async projectDeliveries(@Param('id') id: string, @Query('before') before: string | undefined, @Req() req: HttpRequest) {
    const ctx = await this.access.load(id, who(req));
    if (!ctx || (ctx.roles.length === 0 && ctx.grantKinds.length === 0)) throw new NotFoundException();
    if (!ctx.roles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor')) throw new ForbiddenException('Only the Project Manager, Owner or Sponsor can see email delivery.');
    return this.history('o.project_id = $1', [id], before);
  }

  @Get('deliveries')
  @RequireAction('organisation.manage')
  organisationDeliveries(@Query('before') before: string | undefined) {
    return this.history('TRUE', [], before);
  }

  @Post('deliveries/:id/resend')
  @RequireAction('organisation.manage')
  async resend(@Param('id') id: string, @Req() req: HttpRequest) {
    if (!UUID.test(id)) throw new NotFoundException();
    let newId: string;
    try {
      newId = await resend(this.pool, id, who(req).id, this.now());
    } catch (err) {
      if (err instanceof OutboxRowNotFound) throw new NotFoundException(err.message);
      if (err instanceof NotResendable) throw new ConflictException(err.message);
      throw err;
    }
    await this.nudge();
    return { id: newId };
  }

  @Post('email/test')
  @RequireAction('organisation.manage')
  async test(@Req() req: HttpRequest) {
    const user = who(req);
    const id = await writeOutbox(this.pool, {
      toUserId: user.id,
      toAddress: user.email,
      subject: TEST_SUBJECT,
      body: TEST_BODY,
      kind: 'test',
      projectId: null,
      initiatedBy: 'person',
      initiatedByUser: user.id,
      relevance: { kind: 'none', scope: 'account' },
      now: this.now(),
    });
    await this.nudge();
    return { id };
  }

  @Get('email/status')
  @RequireAction('organisation.manage')
  async status() {
    const e = this.config.email;
    const last = (
      await this.pool.query(
        `SELECT o.status, COALESCE(o.sent_at, (SELECT max(a.finished_at) FROM email_attempts a WHERE a.outbox_id = o.id), o.created_at) AS at
           FROM email_outbox o WHERE o.status IN ('sent', 'failed') ORDER BY 2 DESC, o.id DESC LIMIT 1`,
      )
    ).rows[0];
    return { provider: e.provider, from: e.provider === 'log' ? null : e.from, lastOutcome: last ? { status: last.status as string, at: last.at as Date } : null };
  }
}
