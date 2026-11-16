import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { onMaterialRemoved } from '../assist/removal';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type SourceAccessRow, AudienceService } from '../discussion/audience.service';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';

export const TRANSCRIPT_NOT_DELETED = 'A discussion transcript is not deleted directly; delete its messages instead.';
export const ALREADY_DELETED = 'This source is already deleted.';
export const NOT_DELETED = 'This source is not deleted.';
export const HELD = 'Held — suspected credential, under review. It can be deleted or restored once the case is released.';

interface Locked {
  ctx: ProjectContext;
  row: SourceAccessRow;
  status: string;
  heldCaseId: string | null;
  summaryId: string | null;
}

/**
 * Deleting and restoring imported sources: notes, minutes and approved shareable summaries (history spec 4.1, 4.2, 4.4).
 * Nothing is physically removed: the source is marked Deleted with who, when and why, and a source_events row keeps the
 * history. A discussion transcript is never deleted directly (its messages are).
 */
@Injectable()
export class SourcesDeletionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
    private readonly audiences: AudienceService,
  ) {}

  private async inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
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

  /**
   * The source, locked, for someone who may see it: 404 for anyone outside its project or audience (before any 403), then
   * the action's matrix row (403 with its reason). The summary's own state is not part of the audience test here:
   * deleting a summary source withdraws its summary, and restoring must still reach it.
   *
   * Locks: a summary source's summary row first (as approval and Withdraw lock it before the source), then the source row;
   * the removal hook then locks answers and drafts.
   */
  private async locked(db: PoolClient, user: AuthUser, sourceId: string, action: 'source.delete' | 'source.restore'): Promise<Locked> {
    if (!UUID.test(sourceId)) throw new NotFoundException();
    const projectId = await this.access.projectOfSource(sourceId, db);
    const summaryId = (await db.query<{ summaryId: string | null }>(`SELECT summary_id AS "summaryId" FROM sources WHERE id = $1`, [sourceId])).rows[0]?.summaryId ?? null;
    if (summaryId) await db.query(`SELECT 1 FROM summaries WHERE id = $1 FOR UPDATE`, [summaryId]);
    const src = (
      await db.query<{ status: string; heldCaseId: string | null }>(`SELECT status, held_case_id AS "heldCaseId" FROM sources WHERE id = $1 FOR UPDATE`, [sourceId])
    ).rows[0];
    if (!src) throw new NotFoundException();
    const seen = await this.access.authorize(user, 'note.view', projectId, db);
    const row = await this.audiences.sourceAccessRow(sourceId, db);
    if (!this.audiences.canSeeSource(seen, user, row.kind === 'summary' ? { ...row, kind: 'notes' } : row)) throw new NotFoundException();
    const ctx = await this.access.authorize(user, action, projectId, db);
    return { ctx, row, status: src.status, heldCaseId: src.heldCaseId, summaryId };
  }

  /**
   * Delete (spec 4.2): PM, Owner or Sponsor while the project is Draft, Planned or Active, with a reason. In the same
   * transaction the removal hook runs (private AI outputs built on it are withdrawn, shared ones go to review, summaries
   * of it are hidden from their wider audience), and an approved summary source's summary is withdrawn. Queued runs and
   * requests that use it end blocked at start. Proposals from it are flagged when shown; nothing else changes.
   */
  async delete(user: AuthUser, sourceId: string, body: { reason?: unknown }): Promise<{ id: string; status: 'deleted' }> {
    await this.inTransaction(async (db) => {
      const s = await this.locked(db, user, sourceId, 'source.delete');
      if (s.row.kind === 'discussion') throw new ConflictException(TRANSCRIPT_NOT_DELETED);
      if (s.heldCaseId) throw new ConflictException(HELD);
      if (s.status === 'deleted') throw new ConflictException(ALREADY_DELETED);
      const reason = readReason(body.reason);
      const at = this.now();
      await db.query(`UPDATE sources SET status = 'deleted', deleted_by = $2, deleted_at = $3, delete_reason = $4 WHERE id = $1`, [sourceId, user.id, at, reason]);
      await this.event(db, s, sourceId, 'deleted', user, reason, at);
      if (s.summaryId) await this.withdrawSummary(db, s, user, at);
      await onMaterialRemoved(db, { sourceIds: [sourceId] }, 'deleted', at);
      await writeAudit(db, { at, action: 'source.deleted', actorUserId: user.id, subjectType: 'source', subjectId: sourceId, detail: { projectId: s.ctx.project.id, kind: s.row.kind } });
    });
    return { id: sourceId, status: 'deleted' };
  }

  /** Who will be able to see the source again if it is restored: its current audience, by name (spec 4.4). */
  async restorePreview(user: AuthUser, sourceId: string): Promise<{ names: string[] }> {
    return this.inTransaction(async (db) => {
      const s = await this.locked(db, user, sourceId, 'source.restore');
      if (s.heldCaseId) throw new ConflictException(HELD);
      if (s.status !== 'deleted') throw new ConflictException(NOT_DELETED);
      // The real row: a restored summary source whose summary stays withdrawn is shown to nobody, and the preview says so.
      const people = await this.audiences.readersOf(s.ctx, s.row, db);
      return { names: people.map((p) => p.displayName).sort((a, b) => a.localeCompare(b)) };
    });
  }

  /**
   * Restore (spec 4.4): PM, Owner or Sponsor in any project state, with a reason. The source is active again with its
   * versions and history. Nothing restarts: no extraction, analysis or AI request, no notification or email; answers and
   * drafts withdrawn or sent to review stay so, and a summary withdrawn or hidden because of the deletion stays so.
   */
  async restore(user: AuthUser, sourceId: string, body: { reason?: unknown }): Promise<{ id: string; status: 'active' }> {
    await this.inTransaction(async (db) => {
      const s = await this.locked(db, user, sourceId, 'source.restore');
      if (s.heldCaseId) throw new ConflictException(HELD);
      if (s.status !== 'deleted') throw new ConflictException(NOT_DELETED);
      const reason = readReason(body.reason);
      const at = this.now();
      // 'active' is the only other state a source has (0004), so this is exactly its state before the deletion.
      await db.query(`UPDATE sources SET status = 'active', deleted_by = NULL, deleted_at = NULL, delete_reason = NULL WHERE id = $1`, [sourceId]);
      await this.event(db, s, sourceId, 'restored', user, reason, at);
      await writeAudit(db, { at, action: 'source.restored', actorUserId: user.id, subjectType: 'source', subjectId: sourceId, detail: { projectId: s.ctx.project.id, kind: s.row.kind } });
    });
    return { id: sourceId, status: 'active' };
  }

  private async event(db: PoolClient, s: Locked, sourceId: string, kind: 'deleted' | 'restored', user: AuthUser, reason: string, at: Date): Promise<void> {
    await db.query(`INSERT INTO source_events (id, source_id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      uuidv7(at.getTime()),
      sourceId,
      s.ctx.project.id,
      kind,
      user.id,
      reason,
      at,
    ]);
  }

  /** Deleting an approved summary's source withdraws the summary (spec 4.2), recorded like a Withdraw with the cause. */
  private async withdrawSummary(db: PoolClient, s: Locked, user: AuthUser, at: Date): Promise<void> {
    const state = (await db.query<{ state: string }>(`SELECT state FROM summaries WHERE id = $1`, [s.summaryId])).rows[0]?.state;
    if (!state || state === 'withdrawn') return;
    await db.query(`UPDATE summaries SET state = 'withdrawn', review_reason = NULL WHERE id = $1`, [s.summaryId]);
    await db.query(
      `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, detail, at) VALUES ($1, $2, $3, 'summary_withdrawn', 'summary', $4, $5, $6, $7)`,
      [uuidv7(at.getTime()), s.ctx.project.id, user.id, s.summaryId, 'source_deleted', { from: state, cause: 'source_deleted' }, at],
    );
  }
}
