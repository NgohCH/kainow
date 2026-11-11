import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import type { Clock } from '../auth/tokens';
import { type MembershipRow, effectiveRoles, todayUtc8 } from '../projects/membership';
import { type ProjectStatus, decide } from '../projects/matrix';
import { uuidv7 } from '../common/uuid7';
import type { SpendService } from '../spend/spend.service';
import { locateQuote } from '../notes/text';
import { findCredentials } from './credentials';
import { guardedAiCall, markStaleReservations } from '../ai/guarded-call';
import type { ModelClient, ModelAnswer } from './model';
import { EXTRACTION_SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from './prompt';

const OPEN_STATES: ProjectStatus[] = ['draft', 'planned', 'active'];

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
  requested_by: string | null;
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

  /** The same project rule as when the run was requested, checked again now: roles Active today, project open. */
  private async mayStillRun(run: RunRow): Promise<boolean> {
    const p = await this.d.pool.query<{ project_id: string | null; status: ProjectStatus | null }>(
      `SELECT s.project_id, p.status FROM source_versions v JOIN sources s ON s.id = v.source_id
         LEFT JOIN projects p ON p.id = s.project_id WHERE v.id = $1`,
      [run.source_version_id],
    );
    const project = p.rows[0];
    if (!project?.project_id || !project.status) return false;
    // An automatic run has no requester to recheck: it runs while the project is open.
    if (run.requested_by === null) return OPEN_STATES.includes(project.status);
    const requester = run.requested_by;
    const m = await this.d.pool.query<MembershipRow>(
      `SELECT user_id AS "userId", role, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn",
              revoked_at AS "revokedAt"
         FROM memberships WHERE project_id = $1 AND user_id = $2`,
      [project.project_id, requester],
    );
    const roles = effectiveRoles(m.rows, requester, todayUtc8(this.d.clock()));
    return decide({ action: 'extraction.run', roles, status: project.status }).allowed;
  }

  async process(runId: string, attemptNo: number, isLastAttempt: boolean): Promise<RunOutcome> {
    const { pool, spend } = this.d;
    const { rows } = await pool.query<RunRow>(
      `SELECT r.id, r.status, r.source_version_id, r.requested_by, u.status AS user_status, u.role AS user_role,
              v.text_content AS text
         FROM extraction_runs r
         JOIN source_versions v ON v.id = r.source_version_id
         LEFT JOIN users u ON u.id = r.requested_by
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

    await markStaleReservations(pool, spend, runId, attemptNo);

    // The person may have been disabled, or lost the right in the note's project, since they asked (A11).
    // Automatic runs (no requester) recheck the project state only.
    if ((run.requested_by !== null && run.user_status !== 'active') || !(await this.mayStillRun(run))) {
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


    const model = this.d.model;
    const outcome = await guardedAiCall(
      { pool, spend, clock: this.d.clock, log: this.d.log, modelConfigured: model !== null },
      {
        requestId: runId,
        attemptNo,
        isLastAttempt,
        purpose: 'extraction',
        actorUserId: run.requested_by,
        promptBytes: Buffer.byteLength(EXTRACTION_SYSTEM_PROMPT, 'utf8') + Buffer.byteLength(run.text, 'utf8'),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        call: (modelId) =>
          model!.extract({
            modelId,
            system: EXTRACTION_SYSTEM_PROMPT,
            user: run.text,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            timeoutMs: REQUEST_TIMEOUT_MS,
          }),
      },
    );
    if (outcome.kind === 'retry') return this.requeue(run);
    if (outcome.kind !== 'ok') return this.finish(run, outcome.kind, outcome.code, outcome.detail);
    try {
      return await this.saveItems(run, outcome.modelId, outcome.value);
    } catch (err) {
      // The cost is already settled; saving failed, so the run is retried or ends as an internal error.
      this.d.log?.(`extraction ${run.id}: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!isLastAttempt) return this.requeue(run);
      return this.finish(run, 'failed', 'internal_error', 'An unexpected error stopped the extraction.');
    }
  }

  private async requeue(run: RunRow): Promise<RunOutcome> {
    await this.d.pool.query(`UPDATE extraction_runs SET status = 'queued' WHERE id = $1`, [run.id]);
    return 'retry';
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
