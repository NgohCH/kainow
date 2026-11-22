import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { refuseSecrets } from '../discussion/messages';

export interface ReportType {
  id: string;
  name: string;
  status: 'active' | 'retired';
  position: number;
}

export const MAX_REPORT_TYPE_NAME = 100;

export function readReportTypeName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim() : '';
  if (name === '' || name.length > MAX_REPORT_TYPE_NAME) throw new BadRequestException(`Give a report type name of 1 to ${MAX_REPORT_TYPE_NAME} characters.`);
  refuseSecrets(name);
  return name;
}

const TAKEN = 'There is already a report type with that name.';

@Injectable()
export class ReportTypesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Ordered by position, name, id. Retired types are listed only when asked for (the Administrator's page). */
  async list(includeRetired: boolean): Promise<ReportType[]> {
    const { rows } = await this.pool.query<ReportType>(
      `SELECT id, name, status, position FROM report_types ${includeRetired ? '' : `WHERE status = 'active'`} ORDER BY position, lower(name), id`,
    );
    return rows;
  }

  /** A new type goes to the end of the list. */
  async add(user: AuthUser, nameInput: unknown, reasonInput: unknown): Promise<ReportType> {
    const name = readReportTypeName(nameInput);
    const reason = readReason(reasonInput);
    const at = this.clock();
    const id = uuidv7(at.getTime());
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`LOCK TABLE report_types IN SHARE ROW EXCLUSIVE MODE`);
      await this.assertFree(c, name, null);
      const pos = (await c.query<{ p: number }>(`SELECT COALESCE(max(position), 0) + 1 AS p FROM report_types`)).rows[0].p;
      await c.query(`INSERT INTO report_types (id, name, status, position, created_by, created_at) VALUES ($1, $2, 'active', $3, $4, $5)`, [id, name, pos, user.id, at]);
      await writeAudit(c, { at, action: 'report_type.added', actorUserId: user.id, subjectType: 'report_type', subjectId: id, detail: { name, reason } });
      await c.query('COMMIT');
      return { id, name, status: 'active', position: pos };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async rename(user: AuthUser, id: string, nameInput: unknown, reasonInput: unknown): Promise<ReportType> {
    const name = readReportTypeName(nameInput);
    const reason = readReason(reasonInput);
    return this.change(id, async (c, current, at) => {
      if (current.name === name) return current;
      await this.assertFree(c, name, id);
      await c.query(`UPDATE report_types SET name = $2, updated_by = $3, updated_at = $4 WHERE id = $1`, [id, name, user.id, at]);
      await writeAudit(c, { at, action: 'report_type.renamed', actorUserId: user.id, subjectType: 'report_type', subjectId: id, detail: { previous: current.name, next: name, reason } });
      return { ...current, name };
    });
  }

  /** Retiring keeps history and blocks new selection (D54). */
  async retire(user: AuthUser, id: string, reasonInput: unknown): Promise<ReportType> {
    const reason = readReason(reasonInput);
    return this.change(id, async (c, current, at) => {
      if (current.status === 'retired') throw new ConflictException('That report type is already retired.');
      await c.query(`UPDATE report_types SET status = 'retired', updated_by = $2, updated_at = $3 WHERE id = $1`, [id, user.id, at]);
      await writeAudit(c, { at, action: 'report_type.retired', actorUserId: user.id, subjectType: 'report_type', subjectId: id, detail: { name: current.name, reason } });
      return { ...current, status: 'retired' };
    });
  }

  private async change(id: string, fn: (c: PoolClient, current: ReportType, at: Date) => Promise<ReportType>): Promise<ReportType> {
    if (!UUID.test(id)) throw new NotFoundException();
    const at = this.clock();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`LOCK TABLE report_types IN SHARE ROW EXCLUSIVE MODE`);
      const current = (await c.query<ReportType>(`SELECT id, name, status, position FROM report_types WHERE id = $1`, [id])).rows[0];
      if (!current) throw new NotFoundException();
      const result = await fn(c, current, at);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  private async assertFree(c: PoolClient, name: string, exceptId: string | null): Promise<void> {
    const { rowCount } = await c.query(`SELECT 1 FROM report_types WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)`, [name, exceptId]);
    if (rowCount) throw new ConflictException(TAKEN);
  }
}
