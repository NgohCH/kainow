import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { normaliseEmail } from '../auth/auth.service';
import { CODE_SENDER, type CodeSender, type SetupKind } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { recoveryNoticeEmail } from '../email/messages';
import { writeOutbox } from '../email/outbox';
import { disableAccount, lockProjectsOf } from '../users/disable';
import { type OpenInvitation, endInvitation } from './setup-accept';

const VALID_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const SETUP_CLOSED = 'Setup is closed: an Enterprise Administrator already exists. Add Administrators from the Administrators screen.';
export const SETUP_REGISTERED = 'Kainow is already set up. To restore Administrator access, use recover-admin.';

const DISPLAY_NAME_REQUIRED = 'A display name of 1 to 200 characters is required';

/** NFC, whitespace collapsed, trimmed; null unless 1 to 200 characters. */
export function cleanDisplayName(v: unknown): string | null {
  const name = typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  return name.length < 1 || name.length > 200 ? null : name;
}

export type SetupState = 'valid' | 'used' | 'expired' | 'superseded';

/** The account a link is for, and what it was before the link (both null when the link created it). */
interface Recipient {
  userId: string;
  priorRole: string | null;
  priorStatus: string | null;
}

type Prior = Pick<Recipient, 'priorRole' | 'priorStatus'>;

/** An Active Enterprise Administrator that recovery disables first. */
export interface DisabledAdministrator {
  id: string;
  displayName: string;
  email: string;
}

/**
 * The one-time setup invitation that creates the first Enterprise Administrator, and the recovery link that restores
 * Administrator access. A reused account is not changed before its link is accepted, except that a disabled one is
 * made Invited so it can sign in; acceptance (setup-accept.ts) makes it an Enterprise Administrator.
 */
@Injectable()
export class SetupService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CODE_SENDER) private readonly sender: CodeSender,
  ) {}

  /** setup-invite and golive-init: only before the organisation is registered, and while no Administrator is active. */
  async issue(input: { email: unknown; displayName: unknown }, at: Date): Promise<{ link: string; email: string; expiresAt: Date }> {
    const email = normaliseEmail(input.email);
    if (!email) throw new BadRequestException('A valid email address is required');
    const displayName = cleanDisplayName(input.displayName);
    if (displayName === null) throw new BadRequestException(DISPLAY_NAME_REQUIRED);
    return this.issueLink(email, at, 'setup', displayName, async (c) => {
      if ((await c.query(`SELECT 1 FROM organisation WHERE id = 1 AND registered_at IS NOT NULL`)).rowCount) {
        throw new ConflictException(SETUP_REGISTERED);
      }
      if ((await c.query(`SELECT 1 FROM users WHERE role = 'enterprise_administrator' AND status = 'active' LIMIT 1`)).rowCount) {
        throw new ConflictException(SETUP_CLOSED);
      }
      return async (r: Recipient) => {
        await writeAudit(c, { at, action: 'setup.invitation_issued', subjectType: 'user', subjectId: r.userId, detail: { email } });
      };
    });
  }

  /**
   * Administrator recovery (O07): a recovery link, issued when the organisation is registered. Every still-Active
   * Enterprise Administrator is disabled first through the shared disable path (actor: the system), but only when
   * `disableActive` is given and never when the link would go to one of them; each is sent a notice through the
   * outbox. All of it and the link are one transaction under the setup lock, recorded as admin.recovery_issued.
   * Returns who was disabled and how many emails were queued, so the caller can nudge the email worker.
   */
  async issueRecovery(
    input: { email: string; displayName?: string; reason: string; disableActive: boolean },
    at: Date,
    refusals: { adminActive: string; recipientBeingDisabled: string },
    afterCommit?: (committed: { disabled: DisabledAdministrator[]; queued: number }) => Promise<void>,
  ): Promise<{ link: string; email: string; expiresAt: Date; disabled: DisabledAdministrator[]; queued: number }> {
    const email = normaliseEmail(input.email);
    if (!email) throw new BadRequestException('A valid email address is required');
    const given = input.displayName === undefined ? null : cleanDisplayName(input.displayName);
    if (input.displayName !== undefined && given === null) throw new BadRequestException(DISPLAY_NAME_REQUIRED);
    const appUrl = this.config.appUrl;
    let disabled: DisabledAdministrator[] = [];
    let queued = 0;
    const issued = await this.issueLink(email, at, 'recovery', given, async (c) => {
      disabled = await activeAdministrators(c);
      if (disabled.length > 0 && !input.disableActive) throw new ConflictException(refusals.adminActive);
      if (disabled.some((a) => a.email === email)) throw new ConflictException(refusals.recipientBeingDisabled);
      const notice = recoveryNoticeEmail(at, input.reason);
      for (const a of disabled) {
        queued += await disableAccount(c, a.id, null, at, appUrl, { by: 'recovery', reason: input.reason });
        await writeOutbox(c, {
          toUserId: null,
          toAddress: a.email,
          subject: notice.subject,
          body: notice.body,
          kind: 'recovery_notice',
          projectId: null,
          initiatedBy: 'system',
          now: at,
        });
        queued += 1;
      }
      return async (r: Recipient) => {
        await writeAudit(c, {
          at,
          action: 'admin.recovery_issued',
          subjectType: 'user',
          subjectId: r.userId,
          detail: {
            reason: input.reason,
            userId: r.userId,
            email,
            priorRole: r.priorRole,
            priorStatus: r.priorStatus,
            disabledAdministrators: disabled.map((a) => a.id),
          },
        });
      };
    }, async () => afterCommit?.({ disabled, queued }));
    return { ...issued, disabled, queued };
  }

  /**
   * Issues the link in one transaction under the setup lock: `prepare` checks (and, for recovery, disables) first and
   * returns the audit to write once the recipient is known. After commit, `afterCommit` runs, then the email goes.
   */
  private async issueLink(
    email: string,
    at: Date,
    kind: SetupKind,
    displayName: string | null,
    prepare: (c: PoolClient) => Promise<(r: Recipient) => Promise<void>>,
    afterCommit?: () => Promise<void>,
  ): Promise<{ link: string; email: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(at.getTime() + VALID_FOR_MS);

    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // One setup at a time: the lock keeps two runs of the command from both issuing.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.setup'))`);
      const audit = await prepare(c);
      const carried = await this.supersedeOpen(c, email, at);
      const recipient = await this.recipient(c, email, displayName, at, carried);
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO setup_invitations (id, user_id, email, token_hash, created_at, expires_at, kind, prior_role, prior_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, recipient.userId, email, hashToken(token), at, expiresAt, kind, recipient.priorRole, recipient.priorStatus],
      );
      await audit(recipient);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    await afterCommit?.();
    const link = `${this.config.appUrl}/#/setup/${token}`;
    await this.sender.sendSetupInvitation(email, link, expiresAt, kind);
    return { link, email, expiresAt };
  }

  /**
   * Ends the open link, if any (superseded, or found expired). For a different address its account is put back
   * (endInvitation); for the same address the account is left as it is and its prior state carried to the new link.
   */
  private async supersedeOpen(c: PoolClient, email: string, at: Date): Promise<Prior | undefined> {
    const open = (
      await c.query<OpenInvitation>(
        `SELECT id, user_id, email, kind, prior_role, prior_status FROM setup_invitations
          WHERE accepted_at IS NULL AND superseded_at IS NULL FOR UPDATE`,
      )
    ).rows[0];
    if (!open) return undefined;
    const same = open.email === email;
    await endInvitation(c, open, at, !same);
    return same ? { priorRole: open.prior_role, priorStatus: open.prior_status } : undefined;
  }

  /**
   * The account for the link: reused when it exists (its role kept, and its status too unless it is disabled, which
   * becomes Invited so it can sign in; its name kept when none is given), created otherwise as an Invited
   * Administrator (a name is then required).
   */
  private async recipient(c: PoolClient, email: string, displayName: string | null, at: Date, carried: Prior | undefined): Promise<Recipient> {
    const existing = (await c.query(`SELECT id, role, status FROM users WHERE email = $1 FOR UPDATE`, [email])).rows[0];
    if (existing) {
      await c.query(
        `UPDATE users SET status = CASE WHEN status = 'disabled' THEN 'invited' ELSE status END,
                display_name = COALESCE($2, display_name), updated_at = $3 WHERE id = $1`,
        [existing.id, displayName, at],
      );
      return { userId: existing.id as string, ...(carried ?? { priorRole: existing.role as string, priorStatus: existing.status as string }) };
    }
    if (displayName === null) throw new BadRequestException(DISPLAY_NAME_REQUIRED);
    const id = uuidv7(at.getTime());
    await c.query(
      `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'enterprise_administrator', 'invited', $4, $4)`,
      [id, email, displayName, at],
    );
    return { userId: id, priorRole: null, priorStatus: null };
  }

  /** What a setup link shows, and whether it is a setup or a recovery link. The email is given only while it can be used. */
  async status(token: string, at: Date): Promise<{ state: SetupState; email: string | null; kind: SetupKind }> {
    const row = (
      await this.pool.query(`SELECT email, expires_at, accepted_at, superseded_at, kind FROM setup_invitations WHERE token_hash = $1`, [hashToken(token)])
    ).rows[0];
    if (!row) return { state: 'expired', email: null, kind: 'setup' };
    const kind = row.kind as SetupKind;
    if (row.accepted_at) return { state: 'used', email: null, kind };
    if (row.superseded_at) return { state: 'superseded', email: null, kind };
    if (row.expires_at <= at) return { state: 'expired', email: null, kind };
    return { state: 'valid', email: row.email, kind };
  }
}

/** The Active Enterprise Administrators, locked after the projects they belong to (the disable lock order). */
async function activeAdministrators(c: PoolClient): Promise<DisabledAdministrator[]> {
  const sql = `SELECT id, display_name AS "displayName", email FROM users WHERE role = 'enterprise_administrator' AND status = 'active' ORDER BY id`;
  const seen = (await c.query<DisabledAdministrator>(sql)).rows.map((a) => a.id);
  await lockProjectsOf(c, seen);
  const locked = (await c.query<DisabledAdministrator>(`${sql} FOR UPDATE`)).rows;
  // Anyone made Active in between has their projects locked too.
  await lockProjectsOf(c, locked.map((a) => a.id).filter((id) => !seen.includes(id)));
  return locked;
}
