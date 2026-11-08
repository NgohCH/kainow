import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { normaliseEmail } from '../auth/auth.service';
import { CLOCK, CODE_SENDER, type AuthUser, type Clock, type CodeSender } from '../auth/tokens';
import { APP_CONFIG, type AppConfig } from '../config';
import { alertRecipients, holdMembershipsOf } from '../projects/holds';
import { todayUtc8 } from '../projects/membership';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class UsersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(CODE_SENDER) private readonly sender?: CodeSender,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
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
    const alerts: Array<{ email: string; projectId: string; projectName: string }> = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
      await client.query(`UPDATE users SET status = 'disabled', updated_at = $2 WHERE id = $1`, [id, now]);
      await client.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [id, now]);
      await client.query('UPDATE login_codes SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL', [id, now]);
      // Current project memberships go On Hold for investigation (V1.0 account lifecycle §4).
      const today = todayUtc8(now);
      const held = await holdMembershipsOf(client, id, actorUserId, now, today);
      for (const h of held) {
        for (const email of await alertRecipients(client, h.projectId, id, today)) alerts.push({ email, ...h });
      }
      await writeAudit(client, { at: now, action: 'user.disabled', actorUserId, subjectType: 'user', subjectId: id, detail: { heldProjects: held.length } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    // Alerts go out after the change is committed; a failed email does not undo the disable.
    if (this.sender) {
      const appUrl = this.config?.appUrl ?? 'http://localhost:3000';
      for (const a of alerts) {
        await this.sender
          .sendHoldAlert(a.email, a.projectName, `${appUrl}/#/projects/${a.projectId}/people`)
          .catch((err: Error) => new Logger('UsersService').warn(`Hold alert to a project manager was not sent: ${err.message}`));
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
