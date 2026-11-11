import type { Pool, PoolClient } from 'pg';
import type { Clock } from '../auth/tokens';
import { sha256Hex } from '../notes/text';
import { uuidv7 } from '../common/uuid7';
import { type AudienceMode, inAudience } from '../discussion/audience';
import { findCredentials } from '../extraction/credentials';
import type { RunOutcome } from '../extraction/runner';
import { ProjectAccess } from '../projects/access.service';
import { type ProjectStatus, decide } from '../projects/matrix';
import { type Span, type TranscriptMessage, buildTranscript } from './transcript';

const OPEN_STATES: ProjectStatus[] = ['draft', 'planned', 'active'];

/** The part of ExtractionRunner this class needs: run the extraction that belongs to a snapshot. */
export interface ExtractionStep {
  process(runId: string, attemptNo: number, isLastAttempt: boolean): Promise<RunOutcome>;
}

/** Minutes runs are handled by their own runner (Task 12). */
export interface MinutesStep {
  process(analysisRunId: string, attemptNo: number, isLastAttempt: boolean): Promise<RunOutcome>;
}

export interface AnalysisRunnerDeps {
  pool: Pool;
  clock: Clock;
  extraction: ExtractionStep;
  minutes?: MinutesStep;
  log?: (message: string) => void;
}

interface RunRow {
  id: string;
  status: string;
  kind: 'proposals' | 'minutes';
  trigger: 'quiet_period' | 'meeting_end' | 'button' | 'selection';
  threadId: string;
  requestedBy: string | null;
  coversFromNo: number | null;
  selectedMessageIds: string[] | null;
  sourceVersionId: string | null;
  extractionRunId: string | null;
  threadKind: 'discussion' | 'meeting' | null;
  threadTitle: string | null;
  projectId: string | null;
  projectStatus: ProjectStatus | null;
  audienceId: string | null;
}

interface Refusal {
  code: string;
  detail: string;
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

  async process(analysisRunId: string, attemptNo: number, isLastAttempt: boolean): Promise<RunOutcome> {
    const { pool } = this.d;
    const run = await this.load(analysisRunId);
    if (!run || run.status === 'succeeded' || run.status === 'failed' || run.status === 'blocked') return 'skipped';

    if (run.kind === 'minutes') {
      if (this.d.minutes) return this.d.minutes.process(analysisRunId, attemptNo, isLastAttempt);
      await this.end(run, 'failed', 'minutes_not_available', 'Drafting minutes is not available on this worker.');
      return 'failed';
    }

    await pool.query(
      `UPDATE analysis_runs SET status = 'running', attempts = $2, started_at = COALESCE(started_at, $3) WHERE id = $1`,
      [run.id, attemptNo, this.d.clock()],
    );

    const refusal = await this.recheck(run);
    if (refusal) {
      await this.end(run, 'blocked', refusal.code, refusal.detail);
      return 'blocked';
    }

    if (!run.extractionRunId) {
      const blocked = await this.snapshot(run);
      if (blocked) {
        await this.end(run, 'blocked', blocked.code, blocked.detail);
        return 'blocked';
      }
      const again = await this.load(run.id);
      if (!again?.extractionRunId) throw new Error(`analysis ${run.id}: the snapshot was not linked`);
      run.extractionRunId = again.extractionRunId;
    }

    const outcome = await this.d.extraction.process(run.extractionRunId, attemptNo, isLastAttempt);
    return this.copyOutcome(run, outcome);
  }

  private async load(id: string): Promise<RunRow | undefined> {
    const { rows } = await this.d.pool.query<RunRow>(
      `SELECT r.id, r.status, r.kind, r.trigger, r.thread_id AS "threadId", r.requested_by AS "requestedBy", r.covers_from_no AS "coversFromNo",
              r.selected_message_ids AS "selectedMessageIds", r.source_version_id AS "sourceVersionId", r.extraction_run_id AS "extractionRunId",
              t.kind AS "threadKind", t.title AS "threadTitle", t.project_id AS "projectId", p.status AS "projectStatus", t.audience_id AS "audienceId"
         FROM analysis_runs r
         LEFT JOIN discussion_threads t ON t.id = r.thread_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE r.id = $1`,
      [id],
    );
    return rows[0];
  }

  /** The checks of spec 7.2, made again at every attempt: thread, project state, kind, and the requester's right and audience. */
  private async recheck(run: RunRow): Promise<Refusal | null> {
    const { pool } = this.d;
    if (!run.threadKind || !run.projectId || !run.projectStatus || !run.audienceId) {
      return { code: 'thread_not_found', detail: 'The discussion no longer exists, so the analysis did not run.' };
    }
    if (!OPEN_STATES.includes(run.projectStatus)) {
      return {
        code: 'project_not_open',
        detail: run.requestedBy === null ? 'The project is no longer open, so the automatic analysis did not run.' : 'The project is no longer open, so the analysis did not run.',
      };
    }
    if (run.threadKind !== 'discussion') {
      return { code: 'thread_not_a_discussion', detail: 'Proposals can only be made from a discussion, so the analysis did not run.' };
    }
    if (run.requestedBy === null) return null; // automatic: no person to recheck

    const refused: Refusal = { code: 'requester_not_allowed', detail: 'The person who asked can no longer ask for analysis of this discussion.' };
    const user = (
      await pool.query<{ id: string; email: string; displayName: string; role: string; status: string }>(
        `SELECT id, email, display_name AS "displayName", role, status FROM users WHERE id = $1`,
        [run.requestedBy],
      )
    ).rows[0];
    if (!user || user.status !== 'active') return refused;
    const ctx = await this.access.load(run.projectId, user);
    if (!ctx || ctx.roles.length === 0 || !decide({ action: 'analysis.request', roles: ctx.roles, status: ctx.project.status }).allowed) return refused;
    const audience = (
      await pool.query<{ mode: AudienceMode; named: string[] }>(
        `SELECT a.mode, COALESCE((SELECT array_agg(m.user_id) FROM audience_members m WHERE m.audience_id = a.id), '{}') AS named
           FROM audiences a WHERE a.id = $1`,
        [run.audienceId],
      )
    ).rows[0];
    if (!audience || !inAudience(ctx, { id: run.audienceId, projectId: run.projectId, mode: audience.mode, namedUserIds: audience.named })) return refused;
    return null;
  }

  /**
   * First attempt only: build the transcript from the messages visible now, refuse it if it holds a credential, then store the
   * snapshot (source version, spans, extraction run) and link it to the analysis run in one transaction.
   */
  private async snapshot(run: RunRow): Promise<Refusal | null> {
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
      return { code: 'secret_found', detail: `Not sent to the AI: the discussion appears to contain ${found.map((f) => f.pattern).join(', ')}. Remove it first.` };
    }
    const nos = messages.fresh.map((m) => m.no);
    await this.store(run, text, spans, Math.min(...nos), Math.max(...nos));
    return null;
  }

  /** The new messages (all visible ones from the run's start, or the selected ones still visible) and the visible ones before them. */
  private async readMessages(db: PoolClient, run: RunRow): Promise<{ fresh: TranscriptMessage[]; earlier: TranscriptMessage[] }> {
    const select = `SELECT m.message_no AS no, v.id AS "versionId", m.author_id AS "authorId", u.display_name AS "authorName", m.created_at AS at, v.body
                      FROM discussion_messages m
                      JOIN LATERAL (SELECT id, body FROM message_versions WHERE message_id = m.id ORDER BY version_no DESC LIMIT 1) v ON true
                      JOIN users u ON u.id = m.author_id
                     WHERE m.thread_id = $1 AND m.state = 'visible'`;
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

  private async store(run: RunRow, text: string, spans: Span[], coversFrom: number, coversThrough: number): Promise<void> {
    const at = this.d.clock();
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
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
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Ends the analysis run, and the extraction run linked to it (if any) with the same reason. */
  private async end(run: RunRow, status: 'failed' | 'blocked', code: string, detail: string): Promise<void> {
    const at = this.d.clock();
    await this.d.pool.query(
      `UPDATE analysis_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1`,
      [run.id, status, code, detail, at],
    );
    if (run.extractionRunId) {
      await this.d.pool.query(
        `UPDATE extraction_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1 AND status IN ('queued', 'running')`,
        [run.extractionRunId, status, code, detail, at],
      );
    }
  }

  /** The analysis run takes the extraction run's state, whatever the runner returned (so a crash between the two heals itself). */
  private async copyOutcome(run: RunRow, outcome: RunOutcome): Promise<RunOutcome> {
    const { rows } = await this.d.pool.query(
      `SELECT status, failure_code AS code, failure_detail AS detail, finished_at AS "finishedAt" FROM extraction_runs WHERE id = $1`,
      [run.extractionRunId],
    );
    const ex = rows[0];
    if (!ex || ex.status === 'queued') {
      await this.d.pool.query(`UPDATE analysis_runs SET status = 'queued' WHERE id = $1`, [run.id]);
      return 'retry';
    }
    if (ex.status === 'running') return outcome;
    await this.d.pool.query(
      `UPDATE analysis_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1`,
      [run.id, ex.status, ex.code, ex.detail, ex.finishedAt ?? this.d.clock()],
    );
    return ex.status as RunOutcome;
  }
}
