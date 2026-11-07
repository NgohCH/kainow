import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { locateQuote } from '../notes/text';
import { EXTRACTION_QUEUE, type ExtractionQueue } from './queue';

/** A quote that repeats more often than this lists only its first places for choosing. */
export const MAX_OCCURRENCE_CHOICES = 100;

export const MAX_PROPOSAL_TEXT = 2000;
export const MAX_PROPOSAL_FIELD = 200;

/** A typed value: NFC, line ends as LF, trimmed. Blank owner or due becomes null; blank text is refused. */
function cleanWording(value: unknown, name: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be text`);
  const v = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (v === '') {
    if (required) throw new BadRequestException(`${name} must not be blank`);
    return null;
  }
  if (v.length > max) throw new BadRequestException(`${name} must be at most ${max} characters`);
  return v;
}

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
      `SELECT i.id, i.position, i.kind,
              COALESCE(e.text, i.text) AS text,
              CASE WHEN e.id IS NULL THEN i.owner ELSE e.owner END AS owner,
              CASE WHEN e.id IS NULL THEN i.due ELSE e.due END AS due,
              e.id IS NOT NULL AS edited, i.text AS "originalText", i.owner AS "originalOwner", i.due AS "originalDue",
              i.quote, i.quote_start AS "quoteStart", i.quote_end AS "quoteEnd",
              i.quote_matches AS "quoteMatches", i.review_status AS "reviewStatus",
              i.chosen_occurrence AS "chosenOccurrence",
              i.reviewed_by AS "reviewedBy", i.reviewed_at AS "reviewedAt"
         FROM extraction_items i
         LEFT JOIN LATERAL (
           SELECT id, text, owner, due FROM extraction_item_edits WHERE item_id = i.id ORDER BY edited_at DESC, id DESC LIMIT 1
         ) e ON true
        WHERE i.run_id = $1 ORDER BY i.position`,
      [runId],
    );
    const shaped = items.rows.map(({ originalText, originalOwner, originalDue, ...item }) =>
      item.edited ? { ...item, original: { text: originalText, owner: originalOwner, due: originalDue } } : item,
    );
    const src = await this.pool.query(
      `SELECT s.id AS "sourceId", s.title, v.version_no AS "versionNo"
         FROM extraction_runs r JOIN source_versions v ON v.id = r.source_version_id JOIN sources s ON s.id = v.source_id
        WHERE r.id = $1`,
      [runId],
    );
    return { run: run.rows[0], source: src.rows[0], items: await this.withOccurrences(run.rows[0].sourceVersionId, shaped) };
  }

  /**
   * For a quote that appears more than once, lists the places (at most MAX_OCCURRENCE_CHOICES) so the
   * reviewer can say which one is meant. Quotes found once or not at all carry no list.
   */
  private async withOccurrences<T extends { quote: string; quoteMatches: number }>(sourceVersionId: string, items: T[]) {
    if (!items.some((i) => i.quoteMatches > 1)) return items;
    const { rows } = await this.pool.query<{ text: string }>('SELECT text_content AS text FROM source_versions WHERE id = $1', [sourceVersionId]);
    const text = rows[0]?.text ?? '';
    return items.map((i) =>
      i.quoteMatches > 1
        ? { ...i, occurrences: locateQuote(text, i.quote).slice(0, MAX_OCCURRENCE_CHOICES).map(({ start, end }) => ({ start, end })) }
        : i,
    );
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
    input: { decision: unknown; sourceVersionId: unknown; occurrence?: unknown },
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
      let chosen: number | null = null;
      if (input.decision === 'approved') {
        if (item.quote_matches === 0) {
          throw new ConflictException('This proposal quotes text that is not in the notes, so it cannot be approved');
        }
        if (item.quote_matches > 1) {
          if (input.occurrence === undefined) {
            throw new ConflictException('The quote appears more than once in the notes. Choose which place is meant (occurrence: 0 for the first)');
          }
          const places = Math.min(item.quote_matches, MAX_OCCURRENCE_CHOICES);
          if (!Number.isInteger(input.occurrence) || (input.occurrence as number) < 0 || (input.occurrence as number) >= places) {
            throw new BadRequestException(`occurrence must be a whole number from 0 to ${places - 1}`);
          }
          chosen = input.occurrence as number;
        } else if (input.occurrence !== undefined && input.occurrence !== 0) {
          throw new BadRequestException('This quote appears once, so occurrence can only be 0 or left out');
        }
      }
      await client.query(
        `UPDATE extraction_items SET review_status = $2, chosen_occurrence = $3, reviewed_by = $4, reviewed_at = $5 WHERE id = $1`,
        [itemId, input.decision, chosen, actorUserId, at],
      );
      await writeAudit(client, {
        at,
        action: input.decision === 'approved' ? 'proposal.approved' : 'proposal.rejected',
        actorUserId,
        subjectType: 'extraction_item',
        subjectId: itemId,
        detail: { runId, sourceVersionId: item.source_version_id, previousStatus: item.review_status, ...(chosen !== null ? { occurrence: chosen } : {}) },
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

  /**
   * Replaces the wording of one proposal (text, owner, due; the body is the complete new wording, a blank
   * owner or due clears it). The model's own wording is kept and returned as `original`. The quote and where
   * it sits never change. A decision made on the old wording is withdrawn: the proposal goes back to review.
   */
  async edit(
    runId: string,
    itemId: string,
    input: { sourceVersionId: unknown; text: unknown; owner?: unknown; due?: unknown },
    actorUserId: string,
  ) {
    if (typeof input.sourceVersionId !== 'string' || input.sourceVersionId === '') {
      throw new BadRequestException('sourceVersionId is required: the version the reviewer was looking at');
    }
    const text = cleanWording(input.text, 'text', MAX_PROPOSAL_TEXT, true);
    const owner = cleanWording(input.owner, 'owner', MAX_PROPOSAL_FIELD, false);
    const due = cleanWording(input.due, 'due', MAX_PROPOSAL_FIELD, false);
    const at = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT i.id, i.source_version_id, i.review_status, r.status AS run_status,
                COALESCE(e.text, i.text) AS text,
                CASE WHEN e.id IS NULL THEN i.owner ELSE e.owner END AS owner,
                CASE WHEN e.id IS NULL THEN i.due ELSE e.due END AS due
           FROM extraction_items i
           JOIN extraction_runs r ON r.id = i.run_id
           LEFT JOIN LATERAL (
             SELECT id, text, owner, due FROM extraction_item_edits WHERE item_id = i.id ORDER BY edited_at DESC, id DESC LIMIT 1
           ) e ON true
          WHERE i.id = $1 AND i.run_id = $2 FOR UPDATE OF i`,
        [itemId, runId],
      );
      const item = found.rows[0];
      if (!item) throw new NotFoundException();
      if (item.run_status !== 'succeeded') throw new ConflictException('The extraction has not finished');
      if (item.source_version_id !== input.sourceVersionId) {
        throw new ConflictException('This proposal is for a different version of the notes than the one you reviewed');
      }
      const changed = (['text', 'owner', 'due'] as const).filter((f) => ({ text, owner, due })[f] !== item[f]);
      if (changed.length === 0) throw new ConflictException('Nothing was changed');
      await client.query(
        `INSERT INTO extraction_item_edits (id, item_id, text, owner, due, edited_by, edited_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuidv7(), itemId, text, owner, due, actorUserId, at],
      );
      if (item.review_status !== 'pending') {
        await client.query(
          `UPDATE extraction_items SET review_status = 'pending', chosen_occurrence = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`,
          [itemId],
        );
      }
      // The audit trail names what changed, never the wording itself.
      await writeAudit(client, {
        at,
        action: 'proposal.edited',
        actorUserId,
        subjectType: 'extraction_item',
        subjectId: itemId,
        detail: { runId, sourceVersionId: item.source_version_id, previousStatus: item.review_status, changed },
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
