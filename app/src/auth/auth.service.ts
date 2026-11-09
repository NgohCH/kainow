import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { acceptSetupOnSignIn } from '../organisation/setup-accept';
import { CODE_SENDER, CLOCK, type AuthContext, type AuthUser, type Clock, type CodeSender } from './tokens';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  locked_until: Date | null;
  failed_code_attempts: number;
}

/** Account states that may sign in: Active, and Invited (an invitee who has not signed in yet). */
const SIGN_IN_STATUSES = ['active', 'invited'];

export interface SignInResult {
  token: string;
  expiresAt: Date;
  user: AuthUser;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and lower-cases an address. Returns null if it is not plausibly an email address. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const addMinutes = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * 60_000);

@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CODE_SENDER) private readonly sender: CodeSender,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Starts a sign-in. The caller always gets the same answer, whether or not the address belongs
   * to an active account, so the endpoint cannot be used to discover who has an account.
   */
  async requestCode(rawEmail: unknown): Promise<void> {
    const now = this.clock();
    const email = normaliseEmail(rawEmail);
    const user = email ? ((await this.findUser(this.pool, email)) ?? (await this.accountForInvitee(email, now))) : null;
    if (!user || !SIGN_IN_STATUSES.includes(user.status)) {
      await this.ignored(now, 'unknown_or_disabled');
      return;
    }
    if (user.locked_until && user.locked_until > now) {
      await this.ignored(now, 'locked', user.id);
      return;
    }
    const since = new Date(now.getTime() - this.config.auth.codeResendSeconds * 1000);
    const recent = await this.pool.query('SELECT 1 FROM login_codes WHERE user_id = $1 AND created_at > $2 LIMIT 1', [
      user.id,
      since,
    ]);
    if (recent.rowCount) {
      await this.ignored(now, 'too_soon', user.id);
      return;
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const { codeTtlMinutes } = this.config.auth;
    await this.tx(async (c) => {
      // A newer code replaces any earlier unused one.
      await c.query('UPDATE login_codes SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL', [user.id, now]);
      await c.query(
        'INSERT INTO login_codes (id, user_id, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
        [uuidv7(now.getTime()), user.id, this.hashCode(user.id, code), addMinutes(now, codeTtlMinutes), now],
      );
      await writeAudit(c, { at: now, action: 'auth.code_requested', actorUserId: user.id, subjectType: 'user', subjectId: user.id });
    });

    try {
      await this.sender.send(user.email, code, codeTtlMinutes);
    } catch {
      // The response must stay the same, so the failure is recorded and logged without the code.
      console.error('A sign-in code could not be delivered');
      await writeAudit(this.pool, { at: now, action: 'auth.code_send_failed', actorUserId: user.id, subjectType: 'user', subjectId: user.id });
    }
  }

  /** Checks a code. Returns a session on success and null on any failure, for the same reason as above. */
  async verifyCode(rawEmail: unknown, rawCode: unknown): Promise<SignInResult | null> {
    const now = this.clock();
    const email = normaliseEmail(rawEmail);
    const code = typeof rawCode === 'string' ? rawCode.trim() : '';
    if (!email || !/^\d{6}$/.test(code)) {
      return null;
    }
    const { maxCodeAttempts, lockoutMinutes, sessionHours } = this.config.auth;

    return this.tx(async (c) => {
      // Lock the account row so concurrent guesses are counted one at a time.
      const user = await this.findUser(c, email, true);
      if (!user || !SIGN_IN_STATUSES.includes(user.status)) {
        await writeAudit(c, { at: now, action: 'auth.sign_in_failed', detail: { reason: 'unknown_or_disabled' } });
        return null;
      }
      if (user.locked_until && user.locked_until > now) {
        await writeAudit(c, { at: now, action: 'auth.sign_in_failed', actorUserId: user.id, detail: { reason: 'locked' } });
        return null;
      }
      const open = await c.query<{ id: string; code_hash: string }>(
        `SELECT id, code_hash FROM login_codes
          WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > $2
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [user.id, now],
      );
      const current = open.rows[0];
      if (!current) {
        await writeAudit(c, { at: now, action: 'auth.sign_in_failed', actorUserId: user.id, detail: { reason: 'no_valid_code' } });
        return null;
      }

      if (!safeEqual(current.code_hash, this.hashCode(user.id, code))) {
        await c.query('UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1', [current.id]);
        const failures = user.failed_code_attempts + 1;
        if (failures >= maxCodeAttempts) {
          await c.query('UPDATE users SET failed_code_attempts = 0, locked_until = $2, updated_at = $3 WHERE id = $1', [
            user.id,
            addMinutes(now, lockoutMinutes),
            now,
          ]);
          await c.query('UPDATE login_codes SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL', [user.id, now]);
          await writeAudit(c, { at: now, action: 'auth.locked_out', actorUserId: user.id, subjectType: 'user', subjectId: user.id, detail: { lockoutMinutes } });
        } else {
          await c.query('UPDATE users SET failed_code_attempts = $2, updated_at = $3 WHERE id = $1', [user.id, failures, now]);
          await writeAudit(c, { at: now, action: 'auth.sign_in_failed', actorUserId: user.id, detail: { reason: 'wrong_code' } });
        }
        return null;
      }

      await c.query('UPDATE login_codes SET consumed_at = $2 WHERE id = $1', [current.id, now]);
      // The first successful sign-in of an invitee's account makes it Active.
      await c.query(`UPDATE users SET failed_code_attempts = 0, status = 'active', updated_at = $2 WHERE id = $1`, [user.id, now]);
      await acceptSetupOnSignIn(c, user.id, now);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + sessionHours * 3_600_000);
      const sessionId = uuidv7(now.getTime());
      await c.query('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)', [
        sessionId,
        user.id,
        sha256(token),
        now,
        expiresAt,
      ]);
      await writeAudit(c, { at: now, action: 'auth.signed_in', actorUserId: user.id, subjectType: 'session', subjectId: sessionId });
      return { token, expiresAt, user: toAuthUser(user) };
    });
  }

  /** Finds the signed-in person for a session token, or null if it is unknown, expired, revoked or the account is disabled. */
  async resolveSession(token: string): Promise<AuthContext | null> {
    const { rows } = await this.pool.query<UserRow & { session_id: string }>(
      `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.role, u.status, u.locked_until, u.failed_code_attempts
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'active'`,
      [sha256(token), this.clock()],
    );
    const row = rows[0];
    return row ? { user: toAuthUser(row), sessionId: row.session_id } : null;
  }

  /** The anti-forgery token for one session. Derived, so nothing more is stored; useless without the secret. */
  csrfToken(sessionId: string): string {
    return createHmac('sha256', this.config.authSecret).update(`csrf:${sessionId}`).digest('hex');
  }

  /** Ends every session of the signed-in person (V1.0: "Sign out all sessions"). */
  async signOutAll(auth: AuthContext): Promise<void> {
    const now = this.clock();
    await this.pool.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [auth.user.id, now]);
    await writeAudit(this.pool, { at: now, action: 'auth.signed_out_everywhere', actorUserId: auth.user.id, subjectType: 'user', subjectId: auth.user.id });
  }

  async signOut(auth: AuthContext): Promise<void> {
    const now = this.clock();
    await this.pool.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [auth.sessionId, now]);
    await writeAudit(this.pool, { at: now, action: 'auth.signed_out', actorUserId: auth.user.id, subjectType: 'session', subjectId: auth.sessionId });
  }

  private hashCode(userId: string, code: string): string {
    return createHmac('sha256', this.config.authSecret).update(`${userId}:${code}`).digest('hex');
  }

  /**
   * The only way a new account is made outside the administrator screens: an address with an open project
   * invitation (not answered, not replaced or revoked, not expired) on a currently eligible domain gets an
   * ordinary member account when it first asks for a code. Any other unknown address gets nothing.
   */
  private async accountForInvitee(email: string, now: Date): Promise<UserRow | null> {
    const { rows } = await this.pool.query<{ display_name: string | null }>(
      `SELECT i.display_name FROM invitations i
         JOIN eligible_domains d ON d.domain = split_part(i.email, '@', 2) AND d.removed_at IS NULL
        WHERE i.email = $1 AND i.status = 'invited' AND i.expires_at > $2
        ORDER BY i.issued_at DESC LIMIT 1`,
      [email, now],
    );
    if (!rows[0]) return null;
    const id = uuidv7(now.getTime());
    const displayName = rows[0].display_name?.trim() || email.split('@')[0];
    await this.pool.query(
      `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'member', 'invited', $4, $4)
       ON CONFLICT DO NOTHING`,
      [id, email, displayName, now],
    );
    await writeAudit(this.pool, { at: now, action: 'user.created_for_invitation', subjectType: 'user', subjectId: id });
    return this.findUser(this.pool, email);
  }

  private async findUser(db: Pool | PoolClient, email: string, forUpdate = false): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>(
      `SELECT id, email, display_name, role, status, locked_until, failed_code_attempts
         FROM users WHERE email = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [email],
    );
    return rows[0] ?? null;
  }

  /** Records that a request was not acted on. Never records the submitted address. */
  private async ignored(at: Date, reason: string, userId?: string): Promise<void> {
    await writeAudit(this.pool, { at, action: 'auth.code_request_ignored', actorUserId: userId ?? null, detail: { reason } });
  }

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function toAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
}
