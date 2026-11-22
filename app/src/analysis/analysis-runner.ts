import type { Pool, PoolClient } from 'pg';
import type { Clock } from '../auth/tokens';
import { sha256Hex } from '../notes/text';
import { uuidv7 } from '../common/uuid7';
import { addSourceVersionFiles } from '../storage/sources';
import { findCredentials } from '../extraction/credentials';
import { CLAIM_ATTEMPTS_SQL, type RunJob, type RunOutcome, isLastAttempt } from '../extraction/runner';
import { WAITING_FOR_PLACE } from '../ai/guarded-call';
import { ProjectAccess } from '../projects/access.service';
import { type KainowReporter, messagesOfVersions, reportOwned } from '../quarantine/kainow-report';
import { HELD_DURING_RUN, sweepMarkSql, sweptSince } from '../quarantine/sweep-lock';
import { type Refusal, type RunRow, loadRun, recheckRun } from './run-recheck';
import { type Span, type TranscriptMessage, buildTranscript } from './transcript';

/** The part of ExtractionRunner this class needs: run the extraction that belongs to a snapshot. */
export interface ExtractionStep {
  process(runId: string, job: RunJob): Promise<RunOutcome | 'wait'>;
}

/** Minutes runs are handled by their own runner (Task 12). */
export interface MinutesStep {
  process(analysisRunId: string, job: RunJob): Promise<RunOutcome | 'wait'>;
}

export interface AnalysisRunnerDeps {
  pool: Pool;
  clock: Clock;
  extraction: ExtractionStep;
  minutes?: MinutesStep;
  /** Opens a quarantine case on the message holding a secret found in the stored messages (history spec 7.1). */
  quarantine?: KainowReporter;
  log?: (message: string) => void;
}

/** Earlier context never needs more messages than this: a block is at least a header line plus one character. */
const MAX_CONTEXT_MESSAGES = 1_200;

const NOTHING_TO_ANALYSE = 'None of the messages for this analysis are visible any more, so nothing was sent.';

/**
 * Runs one discussion analysis (spec 7.2, 7.4, 7.6). At job start everything is checked again and the transcript is built from
 * the messages visible at that moment, so a message hidden or deleted after the run was queued never reaches the AI. The
 * transcript is stored once (a new version of the thread's `discussion` source, with a span per message) and the proposals are
 * then made by the ordinary extraction runner, which keeps the spend cap, retries and saving of items. A retry reuses the stored
 * snapshot.
 */
export class AnalysisRunner {
  private readonly access: ProjectAccess;

  constructor(private readonly d: AnalysisRunnerDeps) {
    // The worker has no Nest container; ProjectAccess only needs a pool and a clock.
    this.access = new ProjectAccess(d.pool, d.clock);
  }

  async process(analysisRunId: string, job: RunJob = {}): Promise<RunOutcome | 'wait'> {
    const { pool } = this.d;
    // The project's sweep marker, read before any text the snapshot stores (C1).
    const mark = (
      await pool.query<{ mark: string }>(
        `SELECT ${sweepMarkSql('th.project_id')} AS mark FROM analysis_runs a JOIN discussion_threads th ON th.id = a.thread_id WHERE a.id = $1`,
        [analysisRunId],
      )
    ).rows[0]?.mark;
    const run = await loadRun(this.d.pool, analysisRunId);
    if (!run || mark === undefined || run.status === 'succeeded' || run.status === 'failed' || run.status === 'blocked') return 'skipped';

    if (run.kind === 'minutes') {
      if (this.d.minutes) return this.d.minutes.process(analysisRunId, job);
      return (await this.end(run, 'failed', 'minutes_not_available', 'Drafting minutes is not available on this worker.')) ? 'failed' : 'skipped';
    }

    // The attempts are counted here and given to the delegated extraction run, whose row is the spend request (spec 6.3):
    // building the transcript is part of the attempt, and a sweep clash while storing it still uses one.
    const claimed = await pool.query<{ attempts: number }>(
      `UPDATE analysis_runs SET status = 'running', ${CLAIM_ATTEMPTS_SQL}, started_at = COALESCE(started_at, $3),
              failure_detail = NULLIF(failure_detail, $4)
        WHERE id = $1 AND status IN ('queued', 'running') RETURNING attempts`,
      [run.id, job.resume ?? null, this.d.clock(), WAITING_FOR_PLACE],
    );
    if (claimed.rowCount === 0) return 'skipped';
    const attemptNo = claimed.rows[0].attempts;

    const refusal = await recheckRun(this.d.pool, this.access, run, 'discussion');
    if (refusal) {
      return (await this.end(run, 'blocked', refusal.code, refusal.detail)) ? 'blocked' : 'skipped';
    }

    if (run.extractionRunId) {
      // A retry reuses the stored transcript, so a message hidden, deleted or held since it was built must stop the run
      // (ruling R23; a held message's text may still be in the transcript while its case waits for the protected key).
      const gone = await this.d.pool.query(
        `SELECT 1 FROM transcript_spans sp
           JOIN source_versions v ON v.id = sp.source_version_id
           JOIN sources s ON s.id = v.source_id
           JOIN discussion_messages m ON m.thread_id = s.thread_id AND m.message_no = sp.message_no
          WHERE sp.source_version_id = $1 AND (m.state <> 'visible' OR m.held_case_id IS NOT NULL)
            AND EXISTS (SELECT 1 FROM extraction_runs x WHERE x.id = $2 AND x.status IN ('queued', 'running')) LIMIT 1`,
        [run.sourceVersionId, run.extractionRunId],
      );
      if (gone.rowCount) {
        return (await this.end(run, 'blocked', 'source_changed', 'A message in this analysis was hidden or deleted before it could be sent; ask for a new analysis.')) ? 'blocked' : 'skipped';
      }
    } else {
      const blocked = await this.snapshot(run, mark);
      if (blocked === 'swept') {
        // A report swept or held something in the project while the transcript was built: nothing stored (C1).
        if (await isLastAttempt(pool, run.projectId, attemptNo)) return (await this.end(run, 'blocked', HELD_DURING_RUN.code, HELD_DURING_RUN.detail)) ? 'blocked' : 'skipped';
        await pool.query(`UPDATE analysis_runs SET status = 'queued' WHERE id = $1 AND status IN ('queued', 'running')`, [run.id]);
        return 'retry';
      }
      if (blocked) {
        return (await this.end(run, 'blocked', blocked.code, blocked.detail)) ? 'blocked' : 'skipped';
      }
      const again = await loadRun(this.d.pool, run.id);
      if (!again?.extractionRunId) throw new Error(`analysis ${run.id}: the snapshot was not linked`);
      run.extractionRunId = again.extractionRunId;
    }

    // The extraction run takes this attempt number as already counted, so both rows always hold the same count.
    await pool.query(`UPDATE extraction_runs SET attempts = $2 WHERE id = $1 AND status IN ('queued', 'running')`, [run.extractionRunId, attemptNo]);
    const outcome = await this.d.extraction.process(run.extractionRunId, { resume: attemptNo });
    return this.copyOutcome(run, outcome);
  }

  /**
   * First attempt only: build the transcript from the messages visible now, refuse it if it holds a credential, then store the
   * snapshot (source version, spans, extraction run) and link it to the analysis run in one transaction.
   */
  private async snapshot(run: RunRow, mark: string): Promise<Refusal | 'swept' | null> {
    const { pool } = this.d;
    const read = await pool.connect();
    let messages: { fresh: TranscriptMessage[]; earlier: TranscriptMessage[] };
    try {
      await read.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      messages = await this.readMessages(read, run);
      await read.query('COMMIT');
    } catch (err) {
      await read.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      read.release();
    }
    if (messages.fresh.length === 0) return { code: 'nothing_to_analyse', detail: NOTHING_TO_ANALYSE };

    const { text, spans } = buildTranscript(messages.fresh, messages.earlier);
    const found = findCredentials(text);
    if (found.length > 0) {
      // The secret is in stored messages: each message whose body holds a match owns it. No transaction is open here.
      const owned = await messagesOfVersions(this.d.pool, spans.map((s) => ({ messageVersionId: s.messageVersionId, text: text.slice(s.bodyStart, s.bodyEnd) })));
      await reportOwned(this.d.quarantine, run.projectId, owned, this.d.log);
      return { code: 'secret_found', detail: `Not sent to the AI: the discussion appears to contain ${found.map((f) => f.pattern).join(', ')}. Remove it first.` };
    }
    const nos = messages.fresh.map((m) => m.no);
    return (await this.store(run, text, spans, Math.min(...nos), Math.max(...nos), mark)) ? null : 'swept';
  }

  /** The new messages (all visible ones from the run's start, or the selected ones still visible) and the visible ones before them. */
  private async readMessages(db: PoolClient, run: RunRow): Promise<{ fresh: TranscriptMessage[]; earlier: TranscriptMessage[] }> {
    const select = `SELECT m.message_no AS no, v.id AS "versionId", m.author_id AS "authorId", u.display_name AS "authorName", m.created_at AS at, v.body
                      FROM discussion_messages m
                      JOIN LATERAL (SELECT id, body FROM message_versions WHERE message_id = m.id ORDER BY version_no DESC LIMIT 1) v ON true
                      JOIN users u ON u.id = m.author_id
                     WHERE m.thread_id = $1 AND m.state = 'visible' AND m.held_case_id IS NULL`;
    const shape = (rows: any[], isContext: boolean): TranscriptMessage[] => rows.map((r) => ({ ...r, isContext }));
    const selected = run.selectedMessageIds;
    const fresh = shape(
      selected
        ? (await db.query(`${select} AND m.id = ANY($2::uuid[]) ORDER BY m.message_no`, [run.threadId, selected])).rows
        : (await db.query(`${select} AND m.message_no >= $2 ORDER BY m.message_no`, [run.threadId, run.coversFromNo ?? 1])).rows,
      false,
    );
    if (fresh.length === 0) return { fresh, earlier: [] };
    const first = Math.min(...fresh.map((m) => m.no));
    const earlier = shape(
      (
        await db.query(`${select} AND m.message_no < $2 AND NOT (m.id = ANY($3::uuid[])) ORDER BY m.message_no DESC LIMIT ${MAX_CONTEXT_MESSAGES}`, [
          run.threadId,
          first,
          selected ?? [],
        ])
      ).rows,
      true,
    );
    return { fresh, earlier };
  }

  /** False, storing nothing, when the project's sweep marker moved since `mark` (checked first, under the sweep lock shared). */
  private async store(run: RunRow, text: string, spans: Span[], coversFrom: number, coversThrough: number, mark: string): Promise<boolean> {
    const at = this.d.clock();
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      if (run.projectId && (await sweptSince(client, run.projectId, mark))) {
        await client.query('ROLLBACK');
        return false;
      }
      // Two runs of one thread cannot both create its source.
      await client.query(`SELECT 1 FROM discussion_threads WHERE id = $1 FOR NO KEY UPDATE`, [run.threadId]);
      const existing = await client.query(`SELECT id FROM sources WHERE thread_id = $1 AND kind = 'discussion'`, [run.threadId]);
      let sourceId: string = existing.rows[0]?.id;
      if (!sourceId) {
        sourceId = uuidv7(at.getTime());
        await client.query(
          `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id)
           VALUES ($1, $2, $3, $4, $5, 'discussion', $6, $7)`,
          [sourceId, `Discussion: ${run.threadTitle}`, run.requestedBy, at, run.projectId, run.audienceId, run.threadId],
        );
      }
      const versionNo = (await client.query(`SELECT COALESCE(max(version_no), 0) + 1 AS n FROM source_versions WHERE source_id = $1`, [sourceId])).rows[0].n;
      const versionId = uuidv7(at.getTime());
      await client.query(
        `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
         VALUES ($1, $2, $3, 'discussion', $4, $5, $6, $7, $8)`,
        [versionId, sourceId, versionNo, text, sha256Hex(text), text.length, run.requestedBy, at],
      );
      // The transcript's text is preserved in the managed source area (external outputs spec 9.1).
      if (run.projectId) await addSourceVersionFiles(client, versionId, run.projectId, false);
      for (const s of spans) {
        await client.query(
          `INSERT INTO transcript_spans (source_version_id, message_no, message_version_id, author_id, header_start, body_start, body_end, is_context)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [versionId, s.messageNo, s.messageVersionId, s.authorId, s.headerStart, s.bodyStart, s.bodyEnd, s.isContext],
        );
      }
      const extractionRunId = uuidv7(at.getTime());
      await client.query(
        `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at, trigger) VALUES ($1, $2, $3, 'queued', $4, 'discussion')`,
        [extractionRunId, versionId, run.requestedBy, at],
      );
      // The cursor must reflect what was actually sent (spec 7.2): the messages still visible when the transcript was built.
      await client.query(
        `UPDATE analysis_runs SET source_version_id = $2, extraction_run_id = $3, covers_from_no = $4, covers_through_no = $5 WHERE id = $1`,
        [run.id, versionId, extractionRunId, coversFrom, coversThrough],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Ends the analysis run, and the extraction run linked to it (if any) with the same reason. */
  private async end(run: RunRow, status: 'failed' | 'blocked', code: string, detail: string): Promise<boolean> {
    const at = this.d.clock();
    const done = await this.d.pool.query(
      `UPDATE analysis_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1 AND status IN ('queued', 'running')`,
      [run.id, status, code, detail, at],
    );
    if (run.extractionRunId) {
      await this.d.pool.query(
        `UPDATE extraction_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1 AND status IN ('queued', 'running')`,
        [run.extractionRunId, status, code, detail, at],
      );
    }
    return (done.rowCount ?? 0) > 0;
  }

  /** The analysis run takes the extraction run's state, whatever the runner returned (so a crash between the two heals itself). */
  private async copyOutcome(run: RunRow, outcome: RunOutcome | 'wait'): Promise<RunOutcome | 'wait'> {
    if (outcome === 'wait') {
      // No AI place was free: the analysis run waits with its extraction run; the worker sends the job again with `resume`.
      await this.d.pool.query(`UPDATE analysis_runs SET status = 'queued', failure_detail = $2 WHERE id = $1 AND status IN ('queued', 'running')`, [run.id, WAITING_FOR_PLACE]);
      return 'wait';
    }
    const { rows } = await this.d.pool.query(
      `SELECT status, failure_code AS code, failure_detail AS detail, finished_at AS "finishedAt" FROM extraction_runs WHERE id = $1`,
      [run.extractionRunId],
    );
    const ex = rows[0];
    if (!ex || ex.status === 'queued') {
      await this.d.pool.query(`UPDATE analysis_runs SET status = 'queued' WHERE id = $1 AND status IN ('queued', 'running')`, [run.id]);
      return 'retry';
    }
    if (ex.status === 'running') return outcome;
    const copied = await this.d.pool.query(
      `UPDATE analysis_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1 AND status IN ('queued', 'running')`,
      [run.id, ex.status, ex.code, ex.detail, ex.finishedAt ?? this.d.clock()],
    );
    // The analysis run had already ended (stalled): it stays as it is and nothing is reported as done.
    return copied.rowCount ? (ex.status as RunOutcome) : 'skipped';
  }
}
