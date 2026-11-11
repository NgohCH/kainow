import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { normaliseEmail } from '../auth/auth.service';
import { CODE_SENDER, type CodeSender } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';

const VALID_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const SETUP_CLOSED = 'Setup is closed: an Enterprise Administrator already exists. Add Administrators from the Administrators screen.';

const DISPLAY_NAME_REQUIRED = 'A display name of 1 to 200 characters is required';

/** NFC, whitespace collapsed, trimmed; null unless 1 to 200 characters. */
function cleanDisplayName(v: unknown): string | null {
  const name = typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  return name.length < 1 || name.length > 200 ? null : name;
}

export type SetupState = 'valid' | 'used' | 'expired' | 'superseded';

/**
 * The one-time setup invitation that creates the first Enterprise Administrator. It can be issued only while no
 * Administrator is active, and it closes for good when its person signs in (see AuthService.verifyCode).
 */
@Injectable()
export class SetupService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CODE_SENDER) private readonly sender: CodeSender,
  ) {}

  async issue(input: { email: unknown; displayName: unknown }, at: Date): Promise<{ link: string; email: string; expiresAt: Date }> {
    const email = normaliseEmail(input.email);
    if (!email) throw new BadRequestException('A valid email address is required');
    const displayName = cleanDisplayName(input.displayName);
    if (displayName === null) throw new BadRequestException(DISPLAY_NAME_REQUIRED);
    return this.issueLink(email, at, async (c, userId) => {
      await writeAudit(c, { at, action: 'setup.invitation_issued', subjectType: 'user', subjectId: userId, detail: { email } });
    }, SETUP_CLOSED, displayName);
  }

  /**
   * Administrator recovery (O07): the same one-time link, issued when the organisation is registered but no Enterprise
   * Administrator is Active. An existing account is reused (same id), its display name kept unless one is given; its
   * memberships, holds and grants are never touched. Recorded as admin.recovery_issued, by the system, in the same
   * transaction.
   */
  async issueRecovery(
    input: { email: string; displayName?: string; reason: string },
    at: Date,
    refusal: string,
  ): Promise<{ link: string; email: string; expiresAt: Date }> {
    const email = normaliseEmail(input.email);
    if (!email) throw new BadRequestException('A valid email address is required');
    const given = input.displayName === undefined ? null : cleanDisplayName(input.displayName);
    if (input.displayName !== undefined && given === null) throw new BadRequestException(DISPLAY_NAME_REQUIRED);
    return this.issueLink(email, at, async (c, userId) => {
      await writeAudit(c, { at, action: 'admin.recovery_issued', subjectType: 'user', subjectId: userId, detail: { reason: input.reason, userId, email } });
    }, refusal, given);
  }

  private async issueLink(
    email: string,
    at: Date,
    audit: (c: PoolClient, userId: string) => Promise<void>,
    refusal: string,
    displayName: string | null,
  ): Promise<{ link: string; email: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(at.getTime() + VALID_FOR_MS);

    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // One setup at a time: the lock keeps two runs of the command from both issuing.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.setup'))`);
      const active = (await c.query(`SELECT 1 FROM users WHERE role = 'enterprise_administrator' AND status = 'active' LIMIT 1`)).rowCount;
      if (active) throw new ConflictException(refusal);
      await this.supersedeOpen(c, email, at);
      const userId = await this.invitedAdministrator(c, email, displayName, at);
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO setup_invitations (id, user_id, email, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, userId, email, hashToken(token), at, expiresAt],
      );
      await audit(c, userId);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    const link = `${this.config.appUrl}/#/setup/${token}`;
    await this.sender.sendSetupInvitation(email, link, expiresAt);
    return { link, email, expiresAt };
  }

  /** Ends the open invitation, if any; an Invited account it made for a different address is disabled. */
  private async supersedeOpen(c: PoolClient, email: string, at: Date): Promise<void> {
    const open = (
      await c.query(
        `UPDATE setup_invitations SET superseded_at = $1 WHERE accepted_at IS NULL AND superseded_at IS NULL RETURNING id, user_id, email`,
        [at],
      )
    ).rows[0];
    if (!open) return;
    await writeAudit(c, { at, action: 'setup.invitation_superseded', subjectType: 'user', subjectId: open.user_id, detail: { email: open.email } });
    if (open.email !== email) {
      await c.query(`UPDATE users SET status = 'disabled', updated_at = $2 WHERE id = $1 AND status = 'invited'`, [open.user_id, at]);
    }
  }

  /**
   * The account for the invitation: reused when it exists (made an Invited Administrator, its name kept when none is
   * given), created otherwise (a name is then required).
   */
  private async invitedAdministrator(c: PoolClient, email: string, displayName: string | null, at: Date): Promise<string> {
    const existing = (await c.query(`SELECT id FROM users WHERE email = $1 FOR UPDATE`, [email])).rows[0];
    if (existing) {
      await c.query(
        `UPDATE users SET role = 'enterprise_administrator', status = 'invited', display_name = COALESCE($2, display_name), updated_at = $3 WHERE id = $1`,
        [existing.id, displayName, at],
      );
      return existing.id as string;
    }
    if (displayName === null) throw new BadRequestException(DISPLAY_NAME_REQUIRED);
    const id = uuidv7(at.getTime());
    await c.query(
      `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'enterprise_administrator', 'invited', $4, $4)`,
      [id, email, displayName, at],
    );
    return id;
  }

  /** What a setup link shows. The email is given only while the link can still be used. */
  async status(token: string, at: Date): Promise<{ state: SetupState; email: string | null }> {
    const row = (await this.pool.query(`SELECT email, expires_at, accepted_at, superseded_at FROM setup_invitations WHERE token_hash = $1`, [hashToken(token)])).rows[0];
    if (!row) return { state: 'expired', email: null };
    if (row.accepted_at) return { state: 'used', email: null };
    if (row.superseded_at) return { state: 'superseded', email: null };
    if (row.expires_at <= at) return { state: 'expired', email: null };
    return { state: 'valid', email: row.email };
  }
}
