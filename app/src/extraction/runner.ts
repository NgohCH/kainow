import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import type { Clock } from '../auth/tokens';
import { can } from '../auth/permissions';
import { uuidv7 } from '../common/uuid7';
import { estimateMaxCostMicroMyr } from '../spend/cost';
import type { SpendService } from '../spend/spend.service';
import { readSettings } from '../spend/spend.settings';
import { locateQuote } from '../notes/text';
import { findCredentials } from './credentials';
import { ModelBadResponse, ModelCallError, type ModelClient, type ModelAnswer } from './model';
import { EXTRACTION_SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from './prompt';

export type RunOutcome = 'succeeded' | 'failed' | 'blocked' | 'retry' | 'skipped';

export interface RunnerDeps {
  pool: Pool;
  spend: SpendService;
  /** null when no API key is configured: runs then fail without any charge. */
  model: ModelClient | null;
  clock: Clock;
  log?: (message: string) => void;
}

interface RunRow {
  id: string;
  status: string;
  source_version_id: string;
  requested_by: string;
  user_status: string;
  user_role: string;
  text: string;
}

/**
 * Runs one extraction. Every request to the AI goes through the spend cap: reserve before sending,
 * settle from reported usage afterwards, and keep the full estimate counted whenever the outcome
 * is unknown. Safe to call again for the same run after a crash or a retry.
 */
export class ExtractionRunner {
  constructor(private readonly d: RunnerDeps) {}

  async process(runId: string, attemptNo: number, isLastAttempt: boolean): Promise<RunOutcome> {
    const { pool, spend } = this.d;
    const { rows } = await pool.query<RunRow>(
      `SELECT r.id, r.status, r.source_version_id, r.requested_by, u.status AS user_status, u.role AS user_role,
              v.text_content AS text
         FROM extraction_runs r
         JOIN source_versions v ON v.id = r.source_version_id
         JOIN users u ON u.id = r.requested_by
        WHERE r.id = $1`,
      [runId],
    );
    const run = rows[0];
    if (!run || run.status === 'succeeded' || run.status === 'failed' || run.status === 'blocked') {
      return 'skipped';
    }

    await pool.query(
      `UPDATE extraction_runs SET status = 'running', attempts = $2, started_at = COALESCE(started_at, $3) WHERE id = $1`,
      [runId, attemptNo, this.d.clock()],
    );

    // A worker that stopped mid-request leaves its reservation open. The outcome is unknown, so it stays counted.
    const stale = await pool.query<{ id: string }>(
      `SELECT id FROM ai_spend_entries WHERE request_id = $1 AND attempt_no < $2 AND status = 'reserved'`,
      [runId, attemptNo],
    );
    for (const e of stale.rows) {
      await spend.markUncertain(e.id, 'the worker stopped before the outcome was known');
    }

    // The person may have been disabled, or lost the right, since they asked (A11).
    if (run.user_status !== 'active' || !can(run.user_role, 'extraction.run')) {
      return this.finish(run, 'blocked', 'requester_not_allowed', 'The person who asked is no longer allowed to run extractions.');
    }

    const findings = findCredentials(run.text);
    if (findings.length > 0) {
      const kinds = findings.map((f) => `${f.pattern} (${f.count})`).join(', ');
      return this.finish(
        run,
        'blocked',
        'credential_detected',
        `Not sent to the AI: the notes appear to contain ${kinds}. Remove it and upload the notes as a new version.`,
      );
    }

    if (!this.d.model) {
      return this.finish(run, 'failed', 'model_not_configured', 'No AI key is configured on the worker. Nothing was sent or charged.');
    }

    const settings = await readSettings(pool);
    if (!settings) {
      return this.finish(run, 'blocked', 'spend_not_configured', 'The AI spend settings have not been approved yet, so no AI request is allowed.');
    }

    const estimate = estimateMaxCostMicroMyr(
      Buffer.byteLength(EXTRACTION_SYSTEM_PROMPT, 'utf8') + Buffer.byteLength(run.text, 'utf8'),
      MAX_OUTPUT_TOKENS,
      settings.prices,
    );
    const reserved = await spend.reserve({
      requestId: runId,
      attemptNo,
      estimateMicroMyr: estimate,
      purpose: 'extraction',
      actorUserId: run.requested_by,
    });
    if (reserved.status === 'blocked') {
      const personal = reserved.scope === 'user_monthly';
      const why: Record<string, string> = {
        no_allowance: personal ? 'This person has no personal AI allowance (the personal limit is blank or zero).' : 'There is no AI allowance (the limit is blank or zero).',
        cap_would_be_exceeded: personal
          ? 'This request could cost more than the personal monthly AI allowance that is left.'
          : 'This request could cost more than the AI allowance that is left.',
        not_configured: 'The AI spend settings have not been approved yet.',
      };
      return this.finish(run, 'blocked', `spend_${personal ? 'user_' : ''}${reserved.reason}`, why[reserved.reason] ?? 'Blocked by the AI spend cap.');
    }
    const entryId = reserved.entryId;

    let sent = false;
    try {
      sent = true; // from here on the provider may have done the work and charged for it
      const result = await this.d.model.extract({
        modelId: settings.modelId,
        system: EXTRACTION_SYSTEM_PROMPT,
        user: run.text,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      // The cost is recorded first, so it is counted even if saving the proposals fails.
      await spend.settle(entryId, result.usage);
      return await this.saveItems(run, settings.modelId, result);
    } catch (err) {
      return this.failed(run, entryId, sent, err, isLastAttempt);
    }
  }

  private async failed(run: RunRow, entryId: string, sent: boolean, err: unknown, isLast: boolean): Promise<RunOutcome> {
    const { spend } = this.d;
    let code = 'internal_error';
    let detail = 'An unexpected error stopped the extraction.';
    let retryable = true;

    try {
      if (err instanceof ModelBadResponse) {
        await spend.settle(entryId, err.usage); // the provider did the work, so it is charged
        code = 'bad_response';
        detail = err.message;
      } else if (err instanceof ModelCallError) {
        await spend.markUncertain(entryId, err.message);
        if (err.outcome === 'rejected') {
          // An error answer from the provider before any work is the evidence that nothing was charged.
          await spend.reconcileNotCharged(entryId, `HTTP ${err.status ?? 'error'} answer from the provider; no usage was reported`);
        }
        code = err.outcome === 'rejected' ? 'model_rejected' : 'model_unavailable';
        detail = err.message;
        retryable = err.retryable;
      } else {
        this.d.log?.(`extraction ${run.id}: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        if (sent) await spend.markUncertain(entryId, 'an unexpected error happened after the request was sent');
        else await spend.releaseUnsent(entryId);
      }
    } catch (accountingError) {
      // Never hide an accounting problem. The entry stays counted at its estimate until someone reconciles it.
      this.d.log?.(`extraction ${run.id}: could not record the spend outcome: ${String(accountingError)}`);
      code = 'internal_error';
      detail = 'The AI spend could not be recorded; the estimate stays counted.';
    }

    if (retryable && !isLast) {
      await this.d.pool.query(`UPDATE extraction_runs SET status = 'queued' WHERE id = $1`, [run.id]);
      return 'retry';
    }
    return this.finish(run, 'failed', code, detail);
  }

  private async saveItems(run: RunRow, modelId: string, answer: ModelAnswer): Promise<RunOutcome> {
    const { items, meetingDate } = answer;
    const at = this.d.clock();
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      let unlocated = 0;
      for (const [position, item] of items.entries()) {
        const matches = locateQuote(run.text, item.source_quote);
        if (matches.length === 0) unlocated++;
        await client.query(
          `INSERT INTO extraction_items
             (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at,
              due_event, alternatives)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            uuidv7(at.getTime()), run.id, run.source_version_id, position, item.kind, item.text, item.owner, item.due,
            item.source_quote, matches[0]?.start ?? null, matches[0]?.end ?? null, matches.length, at,
            item.due_event, item.alternatives,
          ],
        );
      }
      await client.query(
        `UPDATE extraction_runs
            SET status = 'succeeded', model_id = $2, item_count = $3, unlocated_count = $4, finished_at = $5,
                failure_code = NULL, failure_detail = NULL, meeting_date = $6
          WHERE id = $1`,
        [run.id, modelId, items.length, unlocated, at, meetingDate],
      );
      await this.audit(client, run, 'succeeded', { items: items.length, unlocated, modelId });
      await client.query('COMMIT');
      return 'succeeded';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async finish(run: RunRow, status: 'failed' | 'blocked', code: string, detail: string): Promise<RunOutcome> {
    const at = this.d.clock();
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE extraction_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1`,
        [run.id, status, code, detail, at],
      );
      await this.audit(client, run, status, { failureCode: code });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return status;
  }

  private audit(client: PoolClient, run: RunRow, status: string, extra: Record<string, unknown>): Promise<void> {
    return writeAudit(client, {
      at: this.d.clock(),
      action: 'extraction.finished',
      actorUserId: run.requested_by,
      subjectType: 'extraction_run',
      subjectId: run.id,
      detail: { status, sourceVersionId: run.source_version_id, ...extra },
    });
  }
}
