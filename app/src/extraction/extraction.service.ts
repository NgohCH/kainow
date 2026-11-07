import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { EXTRACTION_QUEUE, type ExtractionQueue } from './queue';

const RUN_COLUMNS = `id, source_version_id AS "sourceVersionId", status, failure_code AS "failureCode", failure_detail AS "failureDetail",
  attempts, item_count AS "itemCount", unlocated_count AS "unlocatedCount", model_id AS "modelId",
  created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;

@Injectable()
export class ExtractionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(EXTRACTION_QUEUE) private readonly queue: ExtractionQueue,
  ) {}

  /** Starts an extraction of one exact version. The worker does the work later; this only records and queues it. */
  async request(sourceId: string, versionNo: number, actorUserId: string) {
    const found = await this.pool.query<{ id: string }>(
      `SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id
        WHERE v.source_id = $1 AND v.version_no = $2 AND s.status = 'active'`,
      [sourceId, versionNo],
    );
    if (!found.rows[0]) throw new NotFoundException();
    const versionId = found.rows[0].id;

    const at = this.now();
    const runId = uuidv7(at.getTime());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'queued', $4)`,
        [runId, versionId, actorUserId, at],
      );
      await writeAudit(client, {
        at,
        action: 'extraction.requested',
        actorUserId,
        subjectType: 'extraction_run',
        subjectId: runId,
        detail: { sourceVersionId: versionId, sourceId, versionNo },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('An extraction of this version is already queued or running');
      }
      throw err;
    } finally {
      client.release();
    }

    try {
      await this.queue.enqueue(runId);
    } catch {
      await this.pool.query(
        `UPDATE extraction_runs SET status = 'failed', failure_code = 'queue_unavailable',
                failure_detail = 'The job could not be queued. Nothing was sent or charged.', finished_at = $2 WHERE id = $1`,
        [runId, this.now()],
      );
      throw new ServiceUnavailableException('The extraction could not be queued. Try again shortly.');
    }
    return this.getRun(runId);
  }

  async getRun(runId: string) {
    const run = await this.pool.query(`SELECT ${RUN_COLUMNS} FROM extraction_runs WHERE id = $1`, [runId]);
    if (!run.rows[0]) throw new NotFoundException();
    const items = await this.pool.query(
      `SELECT id, position, kind, text, owner, due, quote, quote_start AS "quoteStart", quote_end AS "quoteEnd",
              quote_matches AS "quoteMatches", review_status AS "reviewStatus"
         FROM extraction_items WHERE run_id = $1 ORDER BY position`,
      [runId],
    );
    return { run: run.rows[0], items: items.rows };
  }

  async listForVersion(sourceId: string, versionNo: number) {
    const { rows } = await this.pool.query(
      `SELECT ${RUN_COLUMNS.split(',').map((c) => 'r.' + c.trim()).join(', ')}
         FROM extraction_runs r
         JOIN source_versions v ON v.id = r.source_version_id
         JOIN sources s ON s.id = v.source_id
        WHERE v.source_id = $1 AND v.version_no = $2 AND s.status = 'active'
        ORDER BY r.created_at DESC, r.id DESC`,
      [sourceId, versionNo],
    );
    return { runs: rows };
  }
}
