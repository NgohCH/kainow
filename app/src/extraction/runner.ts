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
import { DISCUSSION_PREAMBLE, EXTRACTION_SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from './prompt';
import { type Span, placeItem } from '../analysis/transcript';
import { type KainowReporter, type OwnedText, messagesOfVersions, reportOwned } from '../quarantine/kainow-report';

const OPEN_STATES: ProjectStatus[] = ['draft', 'planned', 'active'];

export type RunOutcome = 'succeeded' | 'failed' | 'blocked' | 'retry' | 'skipped';

/** The failure code of a run or request blocked at start because its source was deleted (history spec 4.2). */
export const SOURCE_DELETED = 'source_deleted';

export interface RunnerDeps {
  pool: Pool;
  spend: SpendService;
  /** null when no API key is configured: runs then fail without any charge. */
  model: ModelClient | null;
  clock: Clock;
  log?: (message: string) => void;
  /** Opens a quarantine case on the item holding a secret found in stored text (history spec 7.1); without it the run only blocks. */
  quarantine?: KainowReporter;
}

interface RunRow {
  id: string;
  status: string;
  source_version_id: string;
  source_id: string;
  project_id: string | null;
  requested_by: string | null;
  /** 'discussion' for a stored transcript of a project discussion; 'notes' and 'minutes' are read as notes. */
  source_kind: string;
  /** 'deleted' once the source was deleted while the run waited (history spec 4.2). */
  source_status: string;
  /** The source is held in a quarantine case (history spec 7.2). */
  source_held: boolean;
  /** 'discussion' only for a run made by the analysis runner, which has already rechecked the requester. */
  trigger: string;
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

  /**
   * The same project rule as when the run was requested, checked again now: roles Active today, project open.
   * A discussion run is a participant's request and has been rechecked against the thread's audience by the analysis runner
   * just before this point, so here only the project state counts.
   */
  private async mayStillRun(run: RunRow): Promise<boolean> {
    const p = await this.d.pool.query<{ project_id: string | null; status: ProjectStatus | null }>(
      `SELECT s.project_id, p.status FROM source_versions v JOIN sources s ON s.id = v.source_id
         LEFT JOIN projects p ON p.id = s.project_id WHERE v.id = $1`,
      [run.source_version_id],
    );
    const project = p.rows[0];
    if (!project?.project_id || !project.status) return false;
    // An automatic run has no requester to recheck: it runs while the project is open.
    if (run.requested_by === null || run.trigger === 'discussion') return OPEN_STATES.includes(project.status);
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
      `SELECT r.id, r.status, r.source_version_id, s.id AS source_id, s.project_id, r.requested_by, r.trigger, s.kind AS source_kind, s.status AS source_status, s.held_case_id IS NOT NULL AS source_held,
              u.status AS user_status, u.role AS user_role,
              v.text_content AS text
         FROM extraction_runs r
         JOIN source_versions v ON v.id = r.source_version_id
         JOIN sources s ON s.id = v.source_id
         LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.id = $1`,
      [runId],
    );
    const run = rows[0];
    if (!run || run.status === 'succeeded' || run.status === 'failed' || run.status === 'blocked') {
      return 'skipped';
    }

    const claimed = await pool.query(
      `UPDATE extraction_runs SET status = 'running', attempts = $2, started_at = COALESCE(started_at, $3) WHERE id = $1 AND status IN ('queued', 'running')`,
      [runId, attemptNo, this.d.clock()],
    );
    if (claimed.rowCount === 0) return 'skipped';

    await markStaleReservations(pool, spend, runId, attemptNo);

    // A source deleted while the run waited is never sent (history spec 4.2): no AI call, no charge.
    if (run.source_status === 'deleted') {
      return this.finish(run, 'blocked', SOURCE_DELETED, 'The source was deleted, so the extraction did not run.');
    }
    // Nor is a source held for a suspected credential (history spec 7.2).
    if (run.source_held) {
      return this.finish(run, 'blocked', 'held', 'The source is held for a suspected credential, so the extraction did not run.');
    }
    // The person may have been disabled, or lost the right in the note's project, since they asked (A11).
    // Automatic runs (no requester) recheck the project state only.
    if (run.requested_by !== null && run.user_status !== 'active') {
      return this.finish(run, 'blocked', 'requester_not_allowed', 'The person who asked is no longer allowed to run extractions.');
    }
    if (!(await this.mayStillRun(run))) {
      // An automatic run has no person to name: it only needs the project to be open.
      return run.requested_by === null
        ? this.finish(run, 'blocked', 'project_not_open', 'The project is no longer open, so the automatic analysis did not run.')
        : this.finish(run, 'blocked', 'requester_not_allowed', 'The person who asked is no longer allowed to run extractions.');
    }

    const findings = findCredentials(run.text);
    if (findings.length > 0) {
      // A secret in stored text: Kainow opens the case itself on the owning item, then blocks as before (history spec 7.1).
      await this.reportStored(run);
      const kinds = findings.map((f) => `${f.pattern} (${f.count})`).join(', ');
      return this.finish(
        run,
        'blocked',
        'credential_detected',
        `Not sent to the AI: the notes appear to contain ${kinds}. Remove it and upload the notes as a new version.`,
      );
    }


    const model = this.d.model;
    const discussion = run.source_kind === 'discussion';
    const system = discussion ? `${DISCUSSION_PREAMBLE} ${EXTRACTION_SYSTEM_PROMPT}` : EXTRACTION_SYSTEM_PROMPT;
    const outcome = await guardedAiCall(
      { pool, spend, clock: this.d.clock, log: this.d.log, modelConfigured: model !== null },
      {
        requestId: runId,
        attemptNo,
        isLastAttempt,
        purpose: discussion ? 'discussion_analysis' : 'extraction',
        actorUserId: run.requested_by,
        promptBytes: Buffer.byteLength(system, 'utf8') + Buffer.byteLength(run.text, 'utf8'),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        call: (modelId) =>
          model!.extract({
            modelId,
            system,
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
      return this.finish(run, 'failed', 'internal_error', `An unexpected error stopped the ${discussion ? 'analysis' : 'extraction'}.`);
    }
  }

  /**
   * Notes and minutes: the source owns its text. A stored discussion transcript: each message whose body holds a match
   * owns it, found through the transcript's spans (the transcript itself is not an item). No transaction is open here.
   */
  private async reportStored(run: RunRow): Promise<void> {
    let owned: OwnedText[];
    if (run.source_kind === 'discussion') {
      const spans = await this.loadSpans(this.d.pool, run.source_version_id);
      owned = await messagesOfVersions(this.d.pool, spans.map((s) => ({ messageVersionId: s.messageVersionId, text: run.text.slice(s.bodyStart, s.bodyEnd) })));
    } else {
      owned = [{ kind: 'source', id: run.source_id, text: run.text }];
    }
    await reportOwned(this.d.quarantine, run.project_id, owned, this.d.log);
  }

  private async requeue(run: RunRow): Promise<RunOutcome> {
    await this.d.pool.query(`UPDATE extraction_runs SET status = 'queued' WHERE id = $1 AND status IN ('queued', 'running')`, [run.id]);
    return 'retry';
  }

  private async saveItems(run: RunRow, modelId: string, answer: ModelAnswer): Promise<RunOutcome> {
    const { items, meetingDate } = answer;
    const at = this.d.clock();
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      // Items are saved only while the run is still waiting or running (a late save after a stall inserts nothing; spend stays settled).
      const live = await client.query(`SELECT 1 FROM extraction_runs WHERE id = $1 AND status IN ('queued', 'running') FOR UPDATE`, [run.id]);
      if (live.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'skipped';
      }
      let unlocated = 0;
      let repeated = 0;
      let saved = 0;
      const spans = run.source_kind === 'discussion' ? await this.loadSpans(client, run.source_version_id) : null;
      for (const item of items) {
        // Notes: the first place the quote occurs. A discussion: the first place inside a new message; a quote found only in
        // earlier context repeats an earlier proposal and is dropped (spec 7.4).
        let where: { start: number | null; end: number | null; count: number };
        if (spans) {
          const placed = placeItem(item.source_quote, run.text, spans);
          if (placed.kind === 'context_only') {
            repeated++;
            continue;
          }
          where = placed.kind === 'new' ? { start: placed.start, end: placed.end, count: placed.matches } : { start: null, end: null, count: 0 };
        } else {
          const matches = locateQuote(run.text, item.source_quote);
          where = { start: matches[0]?.start ?? null, end: matches[0]?.end ?? null, count: matches.length };
        }
        if (where.count === 0) unlocated++;
        const position = saved++;
        await client.query(
          `INSERT INTO extraction_items
             (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at,
              due_event, alternatives)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            uuidv7(at.getTime()), run.id, run.source_version_id, position, item.kind, item.text, item.owner, item.due,
            item.source_quote, where.start, where.end, where.count, at,
            item.due_event, item.alternatives,
          ],
        );
      }
      await client.query(
        `UPDATE extraction_runs
            SET status = 'succeeded', model_id = $2, item_count = $3, unlocated_count = $4, finished_at = $5,
                failure_code = NULL, failure_detail = NULL, meeting_date = $6
          WHERE id = $1 AND status IN ('queued', 'running')`,
        [run.id, modelId, saved, unlocated, at, meetingDate],
      );
      if (spans) await client.query(`UPDATE analysis_runs SET repeated_count = $2 WHERE extraction_run_id = $1`, [run.id, repeated]);
      await this.audit(client, run, 'succeeded', { items: saved, unlocated, modelId, ...(spans ? { repeated } : {}) });
      await client.query('COMMIT');
      return 'succeeded';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadSpans(db: Pick<Pool, 'query'>, sourceVersionId: string): Promise<Span[]> {
    const { rows } = await db.query(
      `SELECT message_no AS "messageNo", message_version_id AS "messageVersionId", author_id AS "authorId", header_start AS "headerStart",
              body_start AS "bodyStart", body_end AS "bodyEnd", is_context AS "isContext"
         FROM transcript_spans WHERE source_version_id = $1 ORDER BY header_start`,
      [sourceVersionId],
    );
    return rows as Span[];
  }

  private async finish(run: RunRow, status: 'failed' | 'blocked', code: string, detail: string): Promise<RunOutcome> {
    const at = this.d.clock();
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      const done = await client.query(
        `UPDATE extraction_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1 AND status IN ('queued', 'running')`,
        [run.id, status, code, detail, at],
      );
      if (done.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'skipped';
      }
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
