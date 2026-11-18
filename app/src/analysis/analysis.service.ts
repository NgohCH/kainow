import { triggerLabel } from './labels';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import type { MeetingEndHook } from '../discussion/meetings.service';
import { type ThreadRow, ThreadsService } from '../discussion/threads.service';
import { ProjectAccess } from '../projects/access.service';
import { SpendService } from '../spend/spend.service';
import { loadThreadFacts } from './facts';
import { ANALYSIS_QUEUE, type AnalysisQueue } from './queue';
import { type NewRun, enqueueOrFail, insertRun, isActiveRunConflict } from './runs';
import { effectiveAnalysisSettings } from './settings.service';
import { type AnalysisStatus, analysisState, explanation, statusLine } from './state';
import { PROTECTED_KEY, type ProtectedKey } from '../quarantine/protected-key';
import { readiness, readinessMany } from './tick';

export const ALREADY_ACTIVE = 'An analysis of this thread is already queued or running.';
export const NOTHING_NEW = 'No new messages since the last analysis; analysing again may repeat earlier proposals.';
const NO_MESSAGES = 'There are no messages in this thread to analyse.';
const BAD_SELECTION = 'Choose between 1 and 50 messages from this thread.';
const NOT_QUEUED = 'The analysis could not be queued; try again.';
export const MAX_SELECTED = 50;

export interface RunView {
  id: string;
  threadId: string;
  kind: 'proposals' | 'minutes';
  trigger: 'quiet_period' | 'meeting_end' | 'button' | 'selection';
  status: string;
  requestedBy: string | null;
  coversFromNo: number | null;
  coversThroughNo: number | null;
  createdAt: Date;
}

export interface StatusView {
  status: AnalysisStatus;
  line: string;
  explanation: string;
  lastFailure: string | null;
  /** The newest analysis run that finished well, the target of "missed an item" feedback; null before any. */
  lastRunId: string | null;
  lastRunLabel: string | null;
}

type Plan = Omit<NewRun, 'threadId' | 'requestedBy' | 'at'>;

/** Status beside a thread and the requests that start runs (spec 7.1, 7.3). The automatic path is AnalysisTick. */
@Injectable()
export class AnalysisService implements MeetingEndHook {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(ANALYSIS_QUEUE) private readonly queue: AnalysisQueue,
    private readonly threads: ThreadsService,
    private readonly access: ProjectAccess,
    private readonly spend: SpendService,
    @Inject(PROTECTED_KEY) private readonly key: ProtectedKey | null,
  ) {}

  /** The organisation's readiness plus this project's own (the same rule the tick applies). */
  private async readinessOf(projectId: string, now: Date) {
    const [org, own] = await Promise.all([readiness(this.spend), readinessMany(this.pool, [projectId], now, this.key?.id ?? null)]);
    return { ...org, blockedReason: own.get(projectId)?.blockedReason };
  }

  async status(user: AuthUser, threadId: string): Promise<StatusView> {
    const t = await this.threads.threadRow(this.pool, threadId);
    await this.threads.readable(this.pool, user, t);
    const now = this.now();
    const [loaded] = await loadThreadFacts(this.pool, now, t.id);
    const settings = await effectiveAnalysisSettings(this.pool, t.projectId);
    const { status } = analysisState(loaded.facts, settings, await this.readinessOf(t.projectId, now), now);
    const last = await this.pool.query(`SELECT r.id, r.trigger, u.display_name AS name FROM analysis_runs r LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.thread_id = $1 AND r.status = 'succeeded' ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [t.id]);
    return { status, line: statusLine(status), explanation: explanation(settings), lastFailure: loaded.facts.lastFailure, lastRunId: (last.rows[0]?.id as string | undefined) ?? null, lastRunLabel: last.rows[0] ? triggerLabel(last.rows[0].trigger, last.rows[0].name) : null };
  }

  /** Analyse the whole thread: its unanalysed messages, or (once confirmed) everything again. */
  async analyseNow(user: AuthUser, threadId: string, body: { confirmRepeat?: unknown }): Promise<RunView> {
    return this.request(user, threadId, async (db, t): Promise<Plan> => {
      if (t.kind !== 'discussion') throw new NotFoundException();
      const [loaded] = await loadThreadFacts(db, this.now(), t.id);
      if (loaded.facts.unanalysedCount > 0) return { kind: 'proposals', trigger: 'button', coversFromNo: loaded.cursor + 1, coversThroughNo: null };
      if (body.confirmRepeat !== true) throw new ConflictException(NOTHING_NEW);
      await this.requireMessages(db, t.id);
      return { kind: 'proposals', trigger: 'button', coversFromNo: 1, coversThroughNo: null };
    });
  }

  /** Analyse 1 to 50 chosen messages; the thread's "analysed up to" cursor does not move. */
  async analyseSelected(user: AuthUser, threadId: string, body: { messageIds: unknown }): Promise<RunView> {
    return this.request(user, threadId, async (db, t): Promise<Plan> => {
      if (t.kind !== 'discussion') throw new NotFoundException();
      const raw = body.messageIds;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SELECTED || !raw.every((x) => typeof x === 'string' && UUID.test(x))) {
        throw new BadRequestException(BAD_SELECTION);
      }
      const ids = [...new Set(raw as string[])];
      const { rows } = await db.query(
        `SELECT message_no AS no FROM discussion_messages WHERE thread_id = $1 AND state = 'visible' AND held_case_id IS NULL AND id = ANY($2::uuid[])`,
        [t.id, ids],
      );
      if (rows.length !== ids.length) throw new BadRequestException(BAD_SELECTION);
      const nos = rows.map((r) => r.no as number);
      return { kind: 'proposals', trigger: 'selection', coversFromNo: Math.min(...nos), coversThroughNo: Math.max(...nos), selectedMessageIds: ids };
    });
  }

  /** Draft minutes of a meeting: open, anyone who can post; ended, any participant who can read it. */
  async draftMinutes(user: AuthUser, threadId: string): Promise<RunView> {
    return this.request(
      user,
      threadId,
      async (db, t): Promise<Plan> => {
        if (t.kind !== 'meeting') throw new NotFoundException();
        await this.requireMessages(db, t.id);
        return { kind: 'minutes', trigger: 'button', coversFromNo: 1, coversThroughNo: null };
      },
      (t) => (t.state === 'ended' ? 'analysis.request' : 'discussion.post'),
    );
  }

  /** After a meeting ends: one final draft, unless a person has edited the minutes or nothing is unanalysed. A double start is skipped. */
  async onMeetingEnded(threadId: string): Promise<void> {
    const at = this.now();
    const client = await this.pool.connect();
    let runId: string;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM discussion_threads WHERE id = $1 FOR NO KEY UPDATE`, [threadId]);
      const [loaded] = await loadThreadFacts(client, at, threadId);
      const f = loaded?.facts;
      if (!f || f.kind !== 'meeting' || f.hasHumanDraft || f.unanalysedCount === 0 || !['draft', 'planned', 'active'].includes(f.projectStatus)) {
        await client.query('ROLLBACK');
        return;
      }
      runId = await insertRun(client, { threadId, kind: 'minutes', trigger: 'meeting_end', requestedBy: null, coversFromNo: 1, coversThroughNo: null, at });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isActiveRunConflict(err)) return;
      throw err;
    } finally {
      client.release();
    }
    await enqueueOrFail(this.pool, this.queue, runId, at);
  }

  private async requireMessages(db: PoolClient, threadId: string): Promise<void> {
    const found = await db.query(`SELECT 1 FROM discussion_messages WHERE thread_id = $1 AND state = 'visible' AND held_case_id IS NULL LIMIT 1`, [threadId]);
    if (found.rowCount === 0) throw new ConflictException(NO_MESSAGES);
  }

  /**
   * Shared path of the explicit requests: lock the thread, check the reader and the action, refuse a second active run,
   * insert, then hand the committed run to the queue.
   */
  private async request(
    user: AuthUser,
    threadId: string,
    plan: (db: PoolClient, t: ThreadRow) => Promise<Plan>,
    action: (t: ThreadRow) => 'analysis.request' | 'discussion.post' = () => 'analysis.request',
  ): Promise<RunView> {
    const at = this.now();
    const id = await this.threads.inTransaction(async (db) => {
      const t = await this.threads.threadRow(db, threadId, true);
      await this.threads.readable(db, user, t, true);
      await this.access.authorize(user, action(t), t.projectId, db);
      // The active-run answer comes before planning, so a second click never reads "nothing new" instead.
      const active = await db.query(`SELECT 1 FROM analysis_runs WHERE thread_id = $1 AND status IN ('queued', 'running')`, [t.id]);
      if (active.rowCount) throw new ConflictException(ALREADY_ACTIVE);
      const run = await plan(db, t);
      try {
        return await insertRun(db, { ...run, threadId: t.id, requestedBy: user.id, at });
      } catch (err) {
        if (isActiveRunConflict(err)) throw new ConflictException(ALREADY_ACTIVE);
        throw err;
      }
    });
    if (!(await enqueueOrFail(this.pool, this.queue, id, at, true))) throw new ServiceUnavailableException(NOT_QUEUED);
    return this.view(id);
  }

  private async view(id: string): Promise<RunView> {
    const { rows } = await this.pool.query(
      `SELECT id, thread_id AS "threadId", kind, trigger, status, requested_by AS "requestedBy", covers_from_no AS "coversFromNo",
              covers_through_no AS "coversThroughNo", created_at AS "createdAt"
         FROM analysis_runs WHERE id = $1`,
      [id],
    );
    return rows[0] as RunView;
  }
}
