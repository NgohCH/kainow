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
import { queueUserSharing } from '../outputs/sharing-queue';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A person's department as shown (D134): information only, nothing that decides access reads it. */
export interface PersonDepartment {
  id: string;
  name: string;
  /** Retired since it was chosen; it stays until changed. */
  retired: boolean;
}

const CHOOSE_DEPARTMENT = 'Choose an active department from the list, or none.';

/** SQL: the department `d` (left-joined) as PersonDepartment, or null. */
const DEPARTMENT_SQL = `CASE WHEN d.id IS NULL THEN NULL ELSE json_build_object('id', d.id, 'name', d.name, 'retired', d.status = 'retired') END AS department`;

@Injectable()
export class UsersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
    @Optional() @Inject(EMAIL_NUDGE) private readonly nudge?: EmailNudge,
  ) {}

  /** MVP: every user is an Enterprise Administrator (decision R03). */
  async create(input: { email: unknown; displayName: unknown; actorUserId?: string | null; requireEligibleDomain?: boolean }): Promise<AuthUser> {
    const email = normaliseEmail(input.email);
    if (!email) {
      throw new BadRequestException('A valid email address is required');
    }
    // Like invitations and recovery: once the organisation is registered, an Administrator must be on one of its domains.
    if (input.requireEligibleDomain && !(await this.domainAllowed(email))) {
      throw new BadRequestException("That email is not on one of the organisation's email domains");
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

  private async domainAllowed(email: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>(
      `SELECT NOT EXISTS (SELECT 1 FROM organisation WHERE id = 1 AND registered_at IS NOT NULL)
           OR EXISTS (SELECT 1 FROM eligible_domains WHERE domain = $1 AND removed_at IS NULL) AS ok`,
      [email.split('@')[1]],
    );
    return rows[0].ok;
  }

  async list(): Promise<Array<{ id: string; email: string; displayName: string; role: string; status: string; lockedUntil: Date | null; createdAt: Date; department: PersonDepartment | null }>> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.role, u.status, u.locked_until AS "lockedUntil", u.created_at AS "createdAt",
              ${DEPARTMENT_SQL}
         FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.created_at, u.id`,
    );
    return rows;
  }

  async department(userId: string): Promise<PersonDepartment | null> {
    const { rows } = await this.pool.query(`SELECT ${DEPARTMENT_SQL} FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = $1`, [userId]);
    return rows[0]?.department ?? null;
  }

  /**
   * Sets a person's department to an active one from the central list, or to none (null). Saving the one already held
   * changes and audits nothing; a retired one is refused even when already held.
   */
  async setDepartment(id: string, departmentId: unknown, actorUserId: string | null): Promise<PersonDepartment | null> {
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException();
    }
    if (departmentId !== null && (typeof departmentId !== 'string' || !UUID_PATTERN.test(departmentId))) {
      throw new BadRequestException(CHOOSE_DEPARTMENT);
    }
    const now = this.clock();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{ departmentId: string | null }>(
        `SELECT department_id AS "departmentId" FROM users WHERE id = $1 FOR NO KEY UPDATE`,
        [id],
      );
      if (!target.rows[0]) {
        throw new NotFoundException();
      }
      let department: PersonDepartment | null = null;
      if (departmentId !== null) {
        // Locked, so it cannot be retired between this check and the save.
        const found = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM departments WHERE id = $1 AND status = 'active' FOR SHARE`,
          [departmentId],
        );
        if (!found.rows[0]) {
          throw new BadRequestException(CHOOSE_DEPARTMENT);
        }
        department = { ...found.rows[0], retired: false };
      }
      const before = target.rows[0].departmentId;
      if (before !== departmentId) {
        await client.query(`UPDATE users SET department_id = $2, updated_at = $3 WHERE id = $1`, [id, departmentId, now]);
        await writeAudit(client, {
          at: now,
          action: 'person.department_changed',
          actorUserId,
          subjectType: 'user',
          subjectId: id,
          detail: { fromDepartmentId: before, toDepartmentId: departmentId },
        });
      }
      await client.query('COMMIT');
      return department;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Disables a user: they can no longer sign in, and their sessions and unused codes stop working.
   * Users are never deleted. The last active administrator cannot be disabled, because nobody
   * would be left to recover access (decision log, 7 November 2026, item 3 on recovery).
   */
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
        // Access in SharePoint follows once their memberships are restored; any Audit/Oversight grant counts again now.
        await queueUserSharing(client, id, 'normal');
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
