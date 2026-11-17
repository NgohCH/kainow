import type { Pool } from 'pg';
import { guardedAiCall } from '../ai/guarded-call';
import type { Clock } from '../auth/tokens';
import { insertAiDraft } from '../discussion/meetings.service';
import { findCredentials } from '../extraction/credentials';
import type { MinutesModel } from '../extraction/model';
import { MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from '../extraction/prompt';
import type { RunOutcome } from '../extraction/runner';
import { ProjectAccess } from '../projects/access.service';
import type { SpendService } from '../spend/spend.service';
import { MAX_MINUTES_INPUT_CHARS, MINUTES_SYSTEM_PROMPT, type MinutesAnswer, renderMinutes } from './minutes';
import { type Refusal, type RunRow, loadRun, recheckRun } from './run-recheck';
import { headerOf } from './transcript';

export interface MinutesRunnerDeps {
  pool: Pool;
  spend: SpendService;
  /** null when no AI key is configured: the run then fails without sending or charging anything. */
  model: MinutesModel | null;
  clock: Clock;
  log?: (message: string) => void;
}

const TOO_LONG = 'This meeting is too long to draft in one request.';
const PAUSED = 'Automatic minutes paused: edited by a person.';

/**
 * Drafts the minutes of one meeting (spec 5.2, 7.5, 7.6). Everything is checked again at job start, and the input is built from
 * the messages visible at that moment, so a message hidden or deleted after the run was queued never reaches the AI. There is no
 * stored snapshot: every attempt, a retry included, rebuilds the input from the messages visible then.
 */
export class MinutesRunner {
  private readonly access: ProjectAccess;

  constructor(private readonly d: MinutesRunnerDeps) {
    // The worker has no Nest container; ProjectAccess only needs a pool and a clock.
    this.access = new ProjectAccess(d.pool, d.clock);
  }

  async process(analysisRunId: string, attemptNo: number, isLastAttempt: boolean): Promise<RunOutcome> {
    const { pool } = this.d;
    const run = await loadRun(pool, analysisRunId);
    if (!run || run.kind !== 'minutes' || ['succeeded', 'failed', 'blocked'].includes(run.status)) return 'skipped';
    // A run already stalled or finished is left alone (a late retry must not revive it).
    const claimed = await pool.query(
      `UPDATE analysis_runs SET status = 'running', attempts = $2, started_at = COALESCE(started_at, $3) WHERE id = $1 AND status IN ('queued', 'running')`,
      [run.id, attemptNo, this.d.clock()],
    );
    if (claimed.rowCount === 0) return 'skipped';

    const refusal = (await recheckRun(pool, this.access, run, 'meeting')) ?? (await this.humanEdited(run));
    if (refusal) return this.end(run, 'blocked', refusal);

    const messages = await this.visibleMessages(run.threadId);
    if (messages.length === 0) {
      return this.end(run, 'blocked', { code: 'nothing_to_analyse', detail: 'None of the messages for this meeting are visible any more, so nothing was sent.' });
    }
    const input = messages.map((m) => `${headerOf(m)}\n${m.body}`).join('\n\n');
    if (input.length > MAX_MINUTES_INPUT_CHARS) return this.end(run, 'failed', { code: 'too_long', detail: TOO_LONG });
    const found = findCredentials(input);
    if (found.length > 0) {
      return this.end(run, 'blocked', {
        code: 'secret_found',
        detail: `Not sent to the AI: the meeting appears to contain ${found.map((f) => f.pattern).join(', ')}. Remove it first.`,
      });
    }
    const first = messages[0].no;
    const through = messages[messages.length - 1].no;

    const model = this.d.model;
    const outcome = await guardedAiCall(
      { pool, spend: this.d.spend, clock: this.d.clock, log: this.d.log, modelConfigured: model !== null },
      {
        requestId: run.id,
        attemptNo,
        isLastAttempt,
        purpose: 'minutes_draft',
        actorUserId: run.requestedBy,
        promptBytes: Buffer.byteLength(MINUTES_SYSTEM_PROMPT, 'utf8') + Buffer.byteLength(input, 'utf8'),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        call: (modelId) => model!.draftMinutes({ modelId, system: MINUTES_SYSTEM_PROMPT, user: input, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: REQUEST_TIMEOUT_MS }),
      },
    );
    if (outcome.kind === 'retry') return this.requeue(run);
    if (outcome.kind !== 'ok') return this.end(run, outcome.kind, outcome);
    try {
      const saved = await this.save(run, outcome.value, first, through);
      // The run ended (stalled) while the AI call ran: no draft, no success. The spend stays settled.
      if (saved === 'stale') return 'skipped';
      if (saved === 'human') {
        // A person saved their own version while the AI call ran: human edits win (spec 5.2). The call is still charged.
        return this.end(run, 'blocked', { code: 'human_edited', detail: PAUSED });
      }
      return 'succeeded';
    } catch (err) {
      // The cost is already settled; saving failed, so the run is retried or ends as an internal error.
      this.d.log?.(`minutes ${run.id}: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!isLastAttempt) return this.requeue(run);
      return this.end(run, 'failed', { code: 'internal_error', detail: 'An unexpected error stopped the minutes drafting.' });
    }
  }

  /** Human edits win (spec 5.2): an automatic refresh stops once a person has edited the minutes. The button still drafts. */
  private async humanEdited(run: RunRow): Promise<Refusal | null> {
    if (run.trigger !== 'quiet_period' && run.trigger !== 'meeting_end') return null;
    const { rowCount } = await this.d.pool.query(`SELECT 1 FROM minutes_drafts WHERE thread_id = $1 AND origin = 'human' LIMIT 1`, [run.threadId]);
    return rowCount ? { code: 'human_edited', detail: PAUSED } : null;
  }

  private async visibleMessages(threadId: string): Promise<Array<{ no: number; authorName: string; at: Date; body: string }>> {
    const { rows } = await this.d.pool.query(
      `SELECT m.message_no AS no, u.display_name AS "authorName", m.created_at AS at, v.body
         FROM discussion_messages m
         JOIN LATERAL (SELECT body FROM message_versions WHERE message_id = m.id ORDER BY version_no DESC LIMIT 1) v ON true
         JOIN users u ON u.id = m.author_id
        WHERE m.thread_id = $1 AND m.state = 'visible' AND m.held_case_id IS NULL
        ORDER BY m.message_no`,
      [threadId],
    );
    return rows;
  }

  /** The draft, the run's cursor and its success are stored together: no draft without its run result, and the reverse. */
  private async save(run: RunRow, answer: MinutesAnswer, first: number, through: number): Promise<'saved' | 'human' | 'stale'> {
    const present = (
      await this.d.pool.query<{ name: string }>(
        `SELECT u.display_name AS name FROM meeting_attendees a JOIN users u ON u.id = a.user_id WHERE a.thread_id = $1 ORDER BY u.display_name, u.id`,
        [run.threadId],
      )
    ).rows.map((r) => r.name);
    const body = renderMinutes({ title: run.threadTitle ?? '', meetingDate: run.meetingDate ?? '', present, throughNo: through }, answer);
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      // The run must still be waiting or running, checked under its row lock in the same transaction as the draft.
      const live = await client.query(`SELECT 1 FROM analysis_runs WHERE id = $1 AND status IN ('queued', 'running') FOR UPDATE`, [run.id]);
      if (live.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'stale';
      }
      if (run.trigger === 'quiet_period' || run.trigger === 'meeting_end') {
        // Take the thread lock first, so a person's save either lands before this check or waits for this transaction.
        await client.query(`SELECT 1 FROM discussion_threads WHERE id = $1 FOR NO KEY UPDATE`, [run.threadId]);
        const human = await client.query(`SELECT 1 FROM minutes_drafts WHERE thread_id = $1 AND origin = 'human' LIMIT 1`, [run.threadId]);
        if (human.rowCount) {
          await client.query('ROLLBACK');
          return 'human';
        }
      }
      const draft = await insertAiDraft(client, run.threadId, { body, coversThroughNo: through, analysisRunId: run.id }, this.d.clock);
      const draftId = (await client.query(`SELECT id FROM minutes_drafts WHERE thread_id = $1 AND version_no = $2`, [run.threadId, draft.versionNo])).rows[0].id;
      await client.query(
        `UPDATE analysis_runs SET status = 'succeeded', minutes_draft_id = $2, covers_from_no = $3, covers_through_no = $4,
                failure_code = NULL, failure_detail = NULL, finished_at = $5 WHERE id = $1 AND status IN ('queued', 'running')`,
        [run.id, draftId, first, through, this.d.clock()],
      );
      await client.query('COMMIT');
      return 'saved';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async requeue(run: RunRow): Promise<RunOutcome> {
    await this.d.pool.query(`UPDATE analysis_runs SET status = 'queued' WHERE id = $1 AND status IN ('queued', 'running')`, [run.id]);
    return 'retry';
  }

  private async end(run: RunRow, status: 'failed' | 'blocked', why: Refusal): Promise<RunOutcome> {
    const done = await this.d.pool.query(
      `UPDATE analysis_runs SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1 AND status IN ('queued', 'running')`,
      [run.id, status, why.code, why.detail, this.d.clock()],
    );
    return done.rowCount ? status : 'skipped';
  }
}
