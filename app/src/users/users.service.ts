import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { normaliseEmail } from '../auth/auth.service';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { APP_CONFIG, type AppConfig } from '../config';
import { EMAIL_NUDGE, type EmailNudge } from '../email/nudge';
import { disableAccount, lockProjectsOf } from './disable';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class UsersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
    @Optional() @Inject(EMAIL_NUDGE) private readonly nudge?: EmailNudge,
  ) {}

  /** MVP: every user is an Enterprise Administrator (decision R03). */
  async create(input: { email: unknown; displayName: unknown; actorUserId?: string | null }): Promise<AuthUser> {
    const email = normaliseEmail(input.email);
    if (!email) {
      throw new BadRequestException('A valid email address is required');
    }
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (displayName.length < 1 || displayName.length > 200) {
      throw new BadRequestException('A display name of 1 to 200 characters is required');
    }
    const now = this.clock();
    const id = uuidv7(now.getTime());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, email, display_name, role, created_at, updated_at)
         VALUES ($1, $2, $3, 'enterprise_administrator', $4, $4)`,
        [id, email, displayName, now],
      );
      await writeAudit(client, { at: now, action: 'user.created', actorUserId: input.actorUserId ?? null, subjectType: 'user', subjectId: id });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('A user with this email already exists');
      }
      throw err;
    } finally {
      client.release();
    }
    return { id, email, displayName, role: 'enterprise_administrator' };
  }

  /**
   * Disables a user: they can no longer sign in, and their sessions and unused codes stop working.
   * Users are never deleted. The last active administrator cannot be disabled, because nobody
   * would be left to recover access (decision log, 7 November 2026, item 3 on recovery).
   */
  async list(): Promise<Array<{ id: string; email: string; displayName: string; role: string; status: string; lockedUntil: Date | null; createdAt: Date }>> {
    const { rows } = await this.pool.query(
      `SELECT id, email, display_name AS "displayName", role, status, locked_until AS "lockedUntil", created_at AS "createdAt"
         FROM users ORDER BY created_at, id`,
    );
    return rows;
  }

  async disable(id: string, actorUserId: string | null): Promise<void> {
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException();
    }
    const now = this.clock();
    let alerted = 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockProjectsOf(client, [id]);
      const admins = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE role = 'enterprise_administrator' AND status = 'active' ORDER BY id FOR UPDATE`,
      );
      const target = await client.query<{ status: string; role: string }>('SELECT status, role FROM users WHERE id = $1', [id]);
      if (!target.rows[0]) {
        throw new NotFoundException();
      }
      if (target.rows[0].status === 'disabled') {
        await client.query('COMMIT');
        return;
      }
      if (target.rows[0].role === 'enterprise_administrator' && admins.rows.length <= 1) {
        throw new ConflictException('The last active administrator cannot be disabled');
      }
      alerted = await disableAccount(client, id, actorUserId, now, this.config?.appUrl ?? 'http://localhost:3000');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (alerted > 0 && this.nudge) {
      try {
        await this.nudge.nudge();
      } catch {
        // The alerts are committed; the scheduled email tick still sends them.
        new Logger('UsersService').warn('Could not nudge the email worker after hold alerts; the scheduled tick still sends them');
      }
    }
  }

  /**
   * Re-enables a disabled user. Their old sessions and codes stay revoked, so they sign in again with
   * a new code. Any lock from failed attempts is cleared. Enabling someone already active changes nothing.
   */
  async enable(id: string, actorUserId: string | null): Promise<void> {
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException();
    }
    const now = this.clock();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{ status: string }>('SELECT status FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!target.rows[0]) {
        throw new NotFoundException();
      }
      if (target.rows[0].status === 'disabled') {
        await client.query(
          `UPDATE users SET status = 'active', locked_until = NULL, failed_code_attempts = 0, updated_at = $2 WHERE id = $1`,
          [id, now],
        );
        await writeAudit(client, { at: now, action: 'user.enabled', actorUserId, subjectType: 'user', subjectId: id });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
