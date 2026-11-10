import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { EMAIL_NUDGE, type EmailNudge } from '../email/nudge';
import { inTransaction } from '../notifications/fire';
import { ProjectAccess } from '../projects/access.service';
import { todayUtc8 } from '../projects/membership';
import { NOTHING_TO_SEND, SEND_REFUSAL, buildDigest, countOpen, digestRecipients, queueDigestRun } from './digest';

@Injectable()
export class DigestsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_NUDGE) private readonly nudge: EmailNudge,
    private readonly access: ProjectAccess,
  ) {}

  /** 404 for people who cannot see the project; 403 unless PM, Owner or Sponsor of an Active project. */
  private async authorise(user: AuthUser, projectId: string): Promise<void> {
    const ctx = await this.access.context(user, projectId);
    const may = ctx.roles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor');
    if (!may || ctx.project.status !== 'active') throw new ForbiddenException(SEND_REFUSAL);
  }

  /** The caller's own copy, the recipient count and the as-at time. Writes nothing. */
  async preview(user: AuthUser, projectId: string) {
    await this.authorise(user, projectId);
    const asAt = this.now();
    const mine = await buildDigest(this.pool, projectId, user.id, asAt, this.config.appUrl);
    if (mine.openCount === 0) throw new ConflictException(NOTHING_TO_SEND);
    const recipients = await digestRecipients(this.pool, projectId, todayUtc8(asAt));
    return { recipients: recipients.length, asAt: asAt.toISOString(), subject: mine.subject, body: mine.body };
  }

  async send(user: AuthUser, projectId: string) {
    await this.authorise(user, projectId);
    const asAt = this.now();
    if ((await countOpen(this.pool, projectId)) === 0) throw new ConflictException(NOTHING_TO_SEND);
    const recipients = await digestRecipients(this.pool, projectId, todayUtc8(asAt));
    const digestRunId = await inTransaction(this.pool, (c) =>
      queueDigestRun(c, { projectId, recipients, asAt, scheduled: false, initiatedBy: user.id, appUrl: this.config.appUrl }),
    );
    await this.nudge.nudge();
    return { digestRunId, recipients: recipients.length };
  }
}
