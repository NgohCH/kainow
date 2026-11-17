import type { Pool, PoolClient } from 'pg';
import { type AiPurpose, guardedAiCall, markStaleReservations } from '../ai/guarded-call';
import type { Clock } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { type AudienceMode, inAudience } from '../discussion/audience';
import { findCredentials } from '../extraction/credentials';
import { type JsonSchemaModel, ModelBadResponse } from '../extraction/model';
import { REQUEST_TIMEOUT_MS } from '../extraction/prompt';
import { type RunOutcome, SOURCE_DELETED } from '../extraction/runner';
import { ProjectAccess, canReadContent } from '../projects/access.service';
import { type ProjectStatus, decide } from '../projects/matrix';
import type { Usage } from '../spend/cost';
import type { SpendService } from '../spend/spend.service';
import { normalizeMarker, validateCitations } from './citations';
import { type MaterialScope, readableMaterial } from './material';
import {
  ANSWER_MAX_OUTPUT_TOKENS,
  QUESTION_SCHEMA,
  QUESTION_SYSTEM,
  type QuestionOutput,
  REPORT_MAX_OUTPUT_TOKENS,
  REPORT_SCHEMA,
  type ReportOutput,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_SCHEMA,
  parseQuestion,
  parseReport,
  parseSummary,
  renderInput,
} from './prompts';
import { type AssistKind, type AssistRequest, type RequestMaterial, loadRequest, markCited, markDropped } from './requests';

type Db = Pick<PoolClient, 'query'>;

export interface Refusal {
  code: string;
  detail: string;
}

/** The two parts of the prompt. Instructions only ever go in `system`; project text only in `user`. */
export interface AssistInput {
  system: string;
  user: string;
}

/**
 * Builds a kind's prompt from the request and the material still readable at job start (passages already dropped are
 * not given). May refuse, which blocks the request without any AI call or spend. `at` is the runner's time now, for
 * any access the kind checks again at job start.
 */
export type InputBuilder = (db: Db, request: AssistRequest, material: RequestMaterial[], at: Date) => Promise<AssistInput | Refusal>;

/**
 * Saves a kind's validated output. Runs in the transaction that also marks the cited material and sets the request
 * `succeeded`, so there is never an output without its request result, or the reverse. Throwing rolls everything back.
 * `at` is the request's finish time.
 */
export type Completion = (db: PoolClient, request: AssistRequest, output: unknown, at: Date) => Promise<void>;

/**
 * Thrown by a completion when the output cannot be kept and asking the AI again would not help (for example an
 * assembled draft over its size limit). The request ends failed with this code at once: no retry, no further charge.
 */
export class CompletionRefused extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * Whether the request's output was already withdrawn or sent to review by the removal hook (spec 5.5) while the request
 * waited or ran. Such a request is blocked before any AI call, so nobody is charged for output nobody can see.
 */
export type RemovedCheck = (db: Db, request: AssistRequest) => Promise<boolean>;

const builders = new Map<AssistKind, InputBuilder>();
const completions = new Map<AssistKind, Completion>();
const removedChecks = new Map<AssistKind, RemovedCheck>();

/** Tasks for reports and summaries register their own input; a later registration replaces an earlier one. */
export function registerInputBuilder(kind: AssistKind, fn: InputBuilder): void {
  builders.set(kind, fn);
}

export function registerCompletion(kind: AssistKind, fn: Completion): void {
  completions.set(kind, fn);
}

/** Report drafts (Task 8) and summaries register their own check, as questions do below. */
export function registerRemovedCheck(kind: AssistKind, fn: RemovedCheck): void {
  removedChecks.set(kind, fn);
}

/** For tests: removes a kind's input builder and completion, so the kind is not available until registered again. */
export function unregisterKind(kind: AssistKind): void {
  builders.delete(kind);
  completions.delete(kind);
  removedChecks.delete(kind);
}

/** The fixed part of each kind: spend purpose, output limit, schema, parsing, and which text carries citations. */
interface KindSpec {
  purpose: AiPurpose;
  maxOutputTokens: number;
  schema: object;
  parse(content: unknown, usage: Usage): unknown;
  /** The cited text of the whole output, checked as one (spec 6.2: any invalid citation fails the whole draft). */
  citations(output: unknown): { markdown: string; cited: string[] };
}

const KINDS: Record<AssistKind, KindSpec> = {
  question: {
    purpose: 'question_answer',
    maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
    schema: QUESTION_SCHEMA,
    parse: parseQuestion,
    citations: (o) => ({ markdown: (o as QuestionOutput).answer_markdown, cited: (o as QuestionOutput).cited }),
  },
  report: {
    purpose: 'report_draft',
    maxOutputTokens: REPORT_MAX_OUTPUT_TOKENS,
    schema: REPORT_SCHEMA,
    parse: parseReport,
    citations: (o) => ({
      markdown: (o as ReportOutput).sections.map((s) => s.markdown).join('\n\n'),
      cited: [...new Set((o as ReportOutput).sections.flatMap((s) => s.cited))],
    }),
  },
  summary: {
    purpose: 'summary_draft',
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    schema: SUMMARY_SCHEMA,
    parse: parseSummary,
    // A summary is drafted from one source's text, not from passages: there is nothing to cite.
    citations: () => ({ markdown: '', cited: [] }),
  },
};

const OPEN_STATES: ProjectStatus[] = ['draft', 'planned', 'active'];

/** A question's prompt: the question, then the passages and record snapshots still readable. */
export async function questionInput(db: Db, request: AssistRequest, material: RequestMaterial[]): Promise<AssistInput | Refusal> {
  if (material.length === 0) {
    return { code: 'material_unavailable', detail: 'Nothing found for this question can be read any more, so nothing was sent to the AI.' };
  }
  const question = (await db.query<{ question: string }>(`SELECT question FROM ai_answers WHERE request_id = $1`, [request.id])).rows[0]?.question;
  if (!question) return { code: 'question_not_found', detail: 'The question for this request was not found, so nothing was sent to the AI.' };
  return { system: QUESTION_SYSTEM, user: `Question:\n${question}\n\nPassages:\n\n${renderInput(material)}` };
}

/**
 * Writes the answer. The cited flags are set by the runner in the same transaction. A thread-scope question (Re-answer
 * for this thread, spec 5.4) is shared into its thread at its finish time, by its requester, when it found an answer
 * and the thread is still open for posting; otherwise it stays private in the requester's own list.
 */
export async function completeQuestion(db: PoolClient, request: AssistRequest, output: unknown, at: Date): Promise<void> {
  const o = output as QuestionOutput;
  // Thread row before answer row: the order moderation takes them (it locks the thread, then the removal hook locks
  // answers), so a re-answer finishing while a message is hidden cannot deadlock with it. The answer text is written
  // whatever its review_state; a withdrawn answer stays withdrawn and is never shared (the update below needs 'none').
  if (request.scope === 'thread') await db.query(`SELECT 1 FROM discussion_threads WHERE id = $1 FOR NO KEY UPDATE`, [request.scopeThreadId]);
  const done = await db.query(`UPDATE ai_answers SET answer_markdown = $2, not_found = $3 WHERE request_id = $1`, [request.id, o.answer_markdown, o.not_found]);
  if (done.rowCount !== 1) throw new Error(`assist ${request.id}: no answer row to complete`);
  if (request.scope !== 'thread' || o.not_found) return;
  if (!(await mayStillPost(db, request, at))) return;
  const shared = await db.query(
    `UPDATE ai_answers SET visibility = 'shared', shared_thread_id = $2, shared_by = $3, shared_at = $4
      WHERE request_id = $1 AND visibility = 'private' AND review_state = 'none' AND held_case_id IS NULL`,
    [request.id, request.scopeThreadId, request.requestedBy, at],
  );
  if (shared.rowCount !== 1) return;
  await db.query(
    `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at) VALUES ($1, $2, $3, 'shared', 'answer', $4, $5, $6)`,
    [uuidv7(at.getTime()), request.projectId, request.requestedBy, request.id, { threadId: request.scopeThreadId, reanswer: true }, at],
  );
}

/**
 * The posting rule at the moment a re-answer would be posted (spec 8: the requester, who can post in the thread, in a
 * Draft, Planned or Active project). Checked again here because the AI call can take minutes: the project may have been
 * deferred, the requester removed or taken out of a Restricted thread, or the meeting ended. Locks the thread row.
 */
async function mayStillPost(db: PoolClient, request: AssistRequest, at: Date): Promise<boolean> {
  const thread = (
    await db.query<{ audienceId: string; state: 'open' | 'ended' | null; mode: AudienceMode; named: string[] }>(
      `SELECT t.audience_id AS "audienceId", t.state, a.mode,
              COALESCE((SELECT array_agg(m.user_id) FROM audience_members m WHERE m.audience_id = a.id), '{}') AS named
         FROM discussion_threads t JOIN audiences a ON a.id = t.audience_id
        WHERE t.id = $1 AND t.project_id = $2 AND t.held_case_id IS NULL
        FOR NO KEY UPDATE OF t`,
      [request.scopeThreadId, request.projectId],
    )
  ).rows[0];
  if (!thread || thread.state === 'ended') return false;
  const user = (
    await db.query<{ id: string; email: string; displayName: string; role: string; status: string }>(
      `SELECT id, email, display_name AS "displayName", role, status FROM users WHERE id = $1`,
      [request.requestedBy],
    )
  ).rows[0];
  if (!user || user.status !== 'active') return false;
  // ProjectAccess reads through the transaction's client; the clock is the finish time.
  const ctx = await new ProjectAccess(db as unknown as Pool, () => at).load(request.projectId, user, db);
  if (!ctx || ctx.roles.length === 0) return false;
  if (!decide({ action: 'discussion.post', roles: ctx.roles, status: ctx.project.status }).allowed) return false;
  if (!decide({ action: 'assist.share', roles: ctx.roles, status: ctx.project.status }).allowed) return false;
  return inAudience(ctx, { id: thread.audienceId, projectId: request.projectId, mode: thread.mode, namedUserIds: thread.named });
}

/** A question's answer is withdrawn (private) or in review (shared) once the removal hook touched its material, or held. */
export async function questionRemoved(db: Db, request: AssistRequest): Promise<boolean> {
  const row = (await db.query<{ state: string; held: boolean }>(`SELECT review_state AS state, held_case_id IS NOT NULL AS held FROM ai_answers WHERE request_id = $1`, [request.id])).rows[0];
  // Held in a quarantine case (history spec 7.2): not run, nothing sent or charged.
  return row !== undefined && (row.state !== 'none' || row.held);
}

registerInputBuilder('question', questionInput);
registerCompletion('question', completeQuestion);
registerRemovedCheck('question', questionRemoved);

export interface AssistRunnerDeps {
  pool: Pool;
  spend: SpendService;
  /** null when no AI key is configured: the request then fails without sending or charging anything. */
  model: JsonSchemaModel | null;
  clock: Clock;
  log?: (message: string) => void;
}

/**
 * Runs one AI assist request (spec 3, 5.1, 5.2, 6.2, 7.1). Everything is checked again at every attempt (A11): the
 * project is still Draft, Planned or Active; the requester can still read it (and the thread, for thread scope); each
 * stored passage or record is still readable in the request's scope, and those that are not are marked dropped and
 * never sent. The assembled input is checked for credentials. The call goes through the spend cap with the requester
 * as actor; three attempts of 120 seconds, as the analysis runner.
 */
export class AssistRunner {
  private readonly access: ProjectAccess;

  constructor(private readonly d: AssistRunnerDeps) {
    // The worker has no Nest container; ProjectAccess only needs a pool and a clock.
    this.access = new ProjectAccess(d.pool, d.clock);
  }

  async process(requestId: string, attemptNo: number, isLastAttempt: boolean): Promise<RunOutcome> {
    const { pool } = this.d;
    const request = await loadRequest(pool, requestId);
    if (!request || (request.status !== 'queued' && request.status !== 'running')) return 'skipped';
    // A request already ended is left alone (a late retry must not revive it).
    const claimed = await pool.query(
      `UPDATE ai_requests SET status = 'running', attempts = $2, started_at = COALESCE(started_at, $3) WHERE id = $1 AND status IN ('queued', 'running')`,
      [request.id, attemptNo, this.d.clock()],
    );
    if (claimed.rowCount === 0) return 'skipped';
    // An earlier attempt whose worker stopped mid-call left its reservation open. Mark it now, before any refusal below
    // ends the request without reaching guardedAiCall (which would otherwise do it): the outcome is unknown, so it stays counted.
    await markStaleReservations(pool, this.d.spend, request.id, attemptNo);

    const scope = await this.recheck(request);
    if ('code' in scope) return this.end(request, 'blocked', scope);
    // A source this request used was deleted while it waited (history spec 4.2): no AI call, no charge.
    if (await this.usedDeletedSource(request.id)) {
      return this.end(request, 'blocked', { code: SOURCE_DELETED, detail: 'A source this request used was deleted, so the AI request did not run.' });
    }

    const spec = KINDS[request.kind];
    const build = builders.get(request.kind);
    const complete = completions.get(request.kind);
    if (!build || !complete) {
      return this.end(request, 'failed', { code: 'kind_not_available', detail: 'This kind of AI request is not available on this worker.' });
    }
    // Material removed while it waited (hidden, deleted, audience narrowed): its output was already withdrawn or sent to
    // review, so the AI is not called and nothing is charged, even when the requester could still read everything.
    const removed = removedChecks.get(request.kind);
    if (removed && (await removed(pool, request))) {
      return this.end(request, 'blocked', {
        code: 'material_removed',
        detail: 'Something this request used was removed or its audience narrowed, so the AI request did not run.',
      });
    }

    // Drop what the scope can no longer read; it is never sent, and the answer can say so.
    const live = request.material.filter((m) => !m.droppedAtStart);
    const readable = await readableMaterial(pool, scope, live);
    const kept = live.filter((_, i) => readable[i]);
    await markDropped(pool, request.id, live.filter((_, i) => !readable[i]).map((m) => m.ordinal));

    const input = await build(pool, request, kept, this.d.clock());
    if ('code' in input) return this.end(request, 'blocked', input);
    const found = findCredentials(`${input.system}\n${input.user}`);
    if (found.length > 0) {
      return this.end(request, 'blocked', {
        code: 'secret_found',
        detail: `Not sent to the AI: the material appears to contain ${found.map((f) => f.pattern).join(', ')}. Remove it first.`,
      });
    }

    const sent = kept.map((m) => m.marker);
    const model = this.d.model;
    const outcome = await guardedAiCall(
      { pool, spend: this.d.spend, clock: this.d.clock, log: this.d.log, modelConfigured: model !== null },
      {
        requestId: request.id,
        attemptNo,
        isLastAttempt,
        purpose: spec.purpose,
        actorUserId: request.requestedBy,
        promptBytes: Buffer.byteLength(input.system, 'utf8') + Buffer.byteLength(input.user, 'utf8'),
        maxOutputTokens: spec.maxOutputTokens,
        call: async (modelId) => {
          const { content, usage } = await model!.callJson(
            { modelId, system: input.system, user: input.user, maxOutputTokens: spec.maxOutputTokens, timeoutMs: REQUEST_TIMEOUT_MS },
            spec.schema,
          );
          const output = spec.parse(content, usage);
          const { markdown, cited } = spec.citations(output);
          const check = validateCitations(markdown, cited, sent);
          // The provider did the work, so a bad citation is charged; nothing is saved.
          if (!check.ok) throw new ModelBadResponse(check.detail, usage);
          return { output, cited: cited.map((c) => normalizeMarker(c) as string), usage };
        },
      },
    );
    if (outcome.kind === 'retry') return this.requeue(request);
    if (outcome.kind !== 'ok') return this.end(request, outcome.kind, outcome);
    try {
      const saved = await this.save(request, complete, outcome.value.output, outcome.value.cited, outcome.modelId);
      // The request ended (for example stalled) while the AI call ran: nothing saved. The spend stays settled.
      return saved ? 'succeeded' : 'skipped';
    } catch (err) {
      if (err instanceof CompletionRefused) return this.end(request, 'failed', { code: err.code, detail: err.detail });
      this.d.log?.(`assist ${request.id}: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!isLastAttempt) return this.requeue(request);
      return this.end(request, 'failed', { code: 'internal_error', detail: 'An unexpected error stopped the AI request.' });
    }
  }

  /** The A11 checks: project state and the requester's access. Returns the material scope, or why the request cannot run. */
  private async recheck(request: AssistRequest): Promise<MaterialScope | Refusal> {
    const { pool } = this.d;
    const status = (await pool.query<{ status: ProjectStatus }>(`SELECT status FROM projects WHERE id = $1`, [request.projectId])).rows[0]?.status;
    if (!status || !OPEN_STATES.includes(status)) {
      return { code: 'project_not_open', detail: 'The project is no longer open, so the AI request did not run.' };
    }
    const refused: Refusal = { code: 'requester_not_allowed', detail: 'The person who asked can no longer read this project, so the AI request did not run.' };
    const user = (
      await pool.query<{ id: string; email: string; displayName: string; role: string; status: string }>(
        `SELECT id, email, display_name AS "displayName", role, status FROM users WHERE id = $1`,
        [request.requestedBy],
      )
    ).rows[0];
    if (!user || user.status !== 'active') return refused;
    const ctx = await this.access.load(request.projectId, user);
    if (!canReadContent(ctx)) return refused;
    if (request.scope === 'personal') return { kind: 'personal', ctx };
    // Thread scope is only for Re-answer for this thread, which an Audit/Oversight grant holder may not use (spec 5.1).
    if (ctx.roles.length === 0) return refused;

    const thread = (
      await pool.query<{ id: string; state: 'open' | 'ended' | null; mode: AudienceMode; named: string[] }>(
        `SELECT a.id, t.state, a.mode, COALESCE((SELECT array_agg(m.user_id) FROM audience_members m WHERE m.audience_id = a.id), '{}') AS named
           FROM discussion_threads t JOIN audiences a ON a.id = t.audience_id
          WHERE t.id = $1 AND t.project_id = $2 AND t.held_case_id IS NULL`,
        [request.scopeThreadId, request.projectId],
      )
    ).rows[0];
    // A thread held in a quarantine case (history spec 7.2) counts as gone: nothing is sent or charged.
    if (!thread) return { code: 'thread_not_found', detail: 'The thread for this request no longer exists, so the AI request did not run.' };
    if (thread.state === 'ended') return { code: 'meeting_ended', detail: 'The meeting has ended, so the answer could not be posted and the AI request did not run.' };
    if (!inAudience(ctx, { id: thread.id, projectId: request.projectId, mode: thread.mode, namedUserIds: thread.named })) {
      return { code: 'requester_not_allowed', detail: 'The person who asked can no longer read this thread, so the AI request did not run.' };
    }
    return { kind: 'thread', ctx, threadAudienceId: thread.id };
  }

  /**
   * Whether any material still to be sent comes from a Deleted source: a passage of one of its versions, or a pending
   * proposal extracted from it. Through the material's primary key, then passages, versions and sources by primary key.
   */
  private async usedDeletedSource(requestId: string): Promise<boolean> {
    const { rowCount } = await this.d.pool.query(
      `SELECT 1 FROM ai_request_material m
         JOIN passages p ON p.id = m.passage_id AND p.owner_kind = 'source_version'
         JOIN source_versions v ON v.id = p.owner_id
         JOIN sources s ON s.id = v.source_id
        WHERE m.request_id = $1 AND NOT m.dropped_at_start AND s.status = 'deleted'
       UNION ALL
       SELECT 1 FROM ai_request_material m
         JOIN extraction_items x ON x.id = m.record_id
         JOIN source_versions v ON v.id = x.source_version_id
         JOIN sources s ON s.id = v.source_id
        WHERE m.request_id = $1 AND m.record_kind = 'ai_proposal' AND NOT m.dropped_at_start AND s.status = 'deleted'
       LIMIT 1`,
      [requestId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Cited flags, the kind's output and the request's success are stored together. False when the request had already ended. */
  private async save(request: AssistRequest, complete: Completion, output: unknown, cited: string[], modelId: string): Promise<boolean> {
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      const live = await client.query(`SELECT 1 FROM ai_requests WHERE id = $1 AND status IN ('queued', 'running') FOR UPDATE`, [request.id]);
      if (live.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      const at = this.d.clock();
      await markCited(client, request.id, cited);
      await complete(client, request, output, at);
      await client.query(
        `UPDATE ai_requests SET status = 'succeeded', model_id = $2, failure_code = NULL, failure_detail = NULL, finished_at = $3 WHERE id = $1`,
        [request.id, modelId, at],
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

  private async requeue(request: AssistRequest): Promise<RunOutcome> {
    await this.d.pool.query(`UPDATE ai_requests SET status = 'queued' WHERE id = $1 AND status IN ('queued', 'running')`, [request.id]);
    return 'retry';
  }

  private async end(request: AssistRequest, status: 'failed' | 'blocked', why: Refusal): Promise<RunOutcome> {
    const done = await this.d.pool.query(
      `UPDATE ai_requests SET status = $2, failure_code = $3, failure_detail = $4, finished_at = $5 WHERE id = $1 AND status IN ('queued', 'running')`,
      [request.id, status, why.code, why.detail, this.d.clock()],
    );
    return done.rowCount ? status : 'skipped';
  }
}
