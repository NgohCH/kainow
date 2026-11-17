import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { membershipState } from '../projects/membership';
import { endRecordDelegation, openRecordDelegation } from './delegation';

export const ALREADY_DELEGATED = 'The Project Manager is already allowed to delete and restore records.';
export const NOT_DELEGATED = 'The Project Manager has not been allowed to delete and restore records.';
export const NO_PM = 'The project has no active Project Manager.';

/** An Owner or Sponsor lets the Project Manager delete and restore authorised records (D83), and takes it back. */
@Injectable()
export class RecordDelegationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await work(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** { reason } by an Owner or Sponsor: the current Project Manager (never a Deputy) may delete and restore records. */
  async delegate(user: AuthUser, projectId: string, body: { reason?: unknown }) {
    return this.tx(async (c) => {
      const ctx = await this.access.authorize(user, 'record.delegate_deletion', projectId, c, true);
      const reason = readReason(body.reason);
      const pm = ctx.rows.find((m) => m.role === 'pm' && membershipState(m, ctx.today) === 'active');
      if (!pm) throw new ConflictException(NO_PM);
      if (await openRecordDelegation(c, projectId)) throw new ConflictException(ALREADY_DELEGATED);
      const at = this.now();
      const id = uuidv7(at.getTime());
      await c.query(`INSERT INTO record_deletion_delegations (id, project_id, pm_user_id, delegated_by, reason, at) VALUES ($1, $2, $3, $4, $5, $6)`, [
        id, projectId, pm.userId, user.id, reason, at,
      ]);
      await writeAudit(c, { at, action: 'record_deletion.delegated', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { delegationId: id, pmUserId: pm.userId } });
      return { delegated: true as const, pmUserId: pm.userId };
    });
  }

  /** { reason } by any Owner or Sponsor. */
  async revoke(user: AuthUser, projectId: string, body: { reason?: unknown }) {
    return this.tx(async (c) => {
      await this.access.authorize(user, 'record.delegate_deletion', projectId, c, true);
      const reason = readReason(body.reason);
      if (!(await endRecordDelegation(c, projectId, user.id, this.now(), reason))) throw new ConflictException(NOT_DELEGATED);
      return { delegated: false as const };
    });
  }
}
