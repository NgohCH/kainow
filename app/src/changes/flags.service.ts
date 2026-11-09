import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from '../projects/access.service';
import { GRANT_READ_ONLY } from '../projects/matrix';

export const CANNOT_CLEAR = 'Only the Project Manager or a Deputy can clear a review flag.';
export const FLAG_CLEARED = 'This flag is already cleared.';
export const NOTE_NEEDED = 'Write a note about what was reviewed.';

/** Review flags raised when a decision changes: cleared by the PM or a Deputy with a note. They never block work. */
@Injectable()
export class FlagsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  async clear(user: AuthUser, flagId: string, note: unknown): Promise<{ flag: { id: string; clearedAt: Date; note: string } }> {
    if (!UUID.test(flagId)) throw new NotFoundException();
    const peek = (await this.pool.query(`SELECT project_id FROM review_flags WHERE id = $1`, [flagId])).rows[0];
    if (!peek) throw new NotFoundException();
    const text = typeof note === 'string' ? note.trim() : '';
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ctx = await this.access.load(peek.project_id, user, client, true);
      if (!ctx || (ctx.roles.length === 0 && ctx.grantKinds.length === 0)) throw new NotFoundException();
      if (ctx.roles.length === 0) throw new ForbiddenException(GRANT_READ_ONLY);
      if (!ctx.roles.some((r) => r === 'pm' || r === 'deputy_pm')) throw new ForbiddenException(CANNOT_CLEAR);
      if (text === '') throw new BadRequestException(NOTE_NEEDED);
      const flag = (await client.query(`SELECT id, cleared_at, record_kind, record_id FROM review_flags WHERE id = $1 FOR UPDATE`, [flagId])).rows[0];
      if (flag.cleared_at) throw new ConflictException(FLAG_CLEARED);
      await client.query(`UPDATE review_flags SET cleared_by = $2, cleared_at = $3, note = $4 WHERE id = $1`, [flagId, user.id, at, text]);
      await writeAudit(client, {
        at, action: 'review_flag.cleared', actorUserId: user.id, subjectType: 'project', subjectId: ctx.project.id,
        detail: { flagId, recordKind: flag.record_kind, recordId: flag.record_id },
      });
      await client.query('COMMIT');
      return { flag: { id: flagId, clearedAt: at, note: text } };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
