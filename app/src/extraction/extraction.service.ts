import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
              quote_matches AS "quoteMatches", review_status AS "reviewStatus",
              reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt"
         FROM extraction_items WHERE run_id = $1 ORDER BY position`,
      [runId],
    );
    const src = await this.pool.query(
      `SELECT s.id AS "sourceId", s.title, v.version_no AS "versionNo"
         FROM extraction_runs r JOIN source_versions v ON v.id = r.source_version_id JOIN sources s ON s.id = v.source_id
        WHERE r.id = $1`,
      [runId],
    );
    return { run: run.rows[0], source: src.rows[0], items: items.rows };
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

  /**
   * Approves or rejects one proposal. The reviewer states which exact source version they were looking at;
   * if the proposal belongs to a different one the decision is refused, so a decision can never be
   * applied to text the reviewer did not see.
   */
  async review(
    runId: string,
    itemId: string,
    input: { decision: unknown; sourceVersionId: unknown; acknowledgeRepeatedQuote?: unknown },
    actorUserId: string,
  ) {
    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      throw new BadRequestException('decision must be "approved" or "rejected"');
    }
    if (typeof input.sourceVersionId !== 'string' || input.sourceVersionId === '') {
      throw new BadRequestException('sourceVersionId is required: the version the reviewer was looking at');
    }
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT i.id, i.source_version_id, i.quote_matches, i.review_status, r.status AS run_status
           FROM extraction_items i JOIN extraction_runs r ON r.id = i.run_id
          WHERE i.id = $1 AND i.run_id = $2 FOR UPDATE OF i`,
        [itemId, runId],
      );
      const item = found.rows[0];
      if (!item) throw new NotFoundException();
      if (item.run_status !== 'succeeded') throw new ConflictException('The extraction has not finished');
      if (item.source_version_id !== input.sourceVersionId) {
        throw new ConflictException('This proposal is for a different version of the notes than the one you reviewed');
      }
      if (input.decision === 'approved') {
        if (item.quote_matches === 0) {
          throw new ConflictException('This proposal quotes text that is not in the notes, so it cannot be approved');
        }
        if (item.quote_matches > 1 && input.acknowledgeRepeatedQuote !== true) {
          throw new ConflictException('The quote appears more than once in the notes. Confirm you checked which passage is meant (acknowledgeRepeatedQuote: true)');
        }
      }
      await client.query(
        `UPDATE extraction_items SET review_status = $2, reviewed_by = $3, reviewed_at = $4 WHERE id = $1`,
        [itemId, input.decision, actorUserId, at],
      );
      await writeAudit(client, {
        at,
        action: input.decision === 'approved' ? 'proposal.approved' : 'proposal.rejected',
        actorUserId,
        subjectType: 'extraction_item',
        subjectId: itemId,
        detail: { runId, sourceVersionId: item.source_version_id, previousStatus: item.review_status },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const view = await this.getRun(runId);
    return { item: view.items.find((i: { id: string }) => i.id === itemId) };
  }
}
