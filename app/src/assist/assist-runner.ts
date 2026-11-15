import type { Pool, PoolClient } from 'pg';
import { type AiPurpose, guardedAiCall } from '../ai/guarded-call';
import type { Clock } from '../auth/tokens';
import { type AudienceMode, inAudience } from '../discussion/audience';
import { findCredentials } from '../extraction/credentials';
import { type JsonSchemaModel, ModelBadResponse } from '../extraction/model';
import { REQUEST_TIMEOUT_MS } from '../extraction/prompt';
import type { RunOutcome } from '../extraction/runner';
import { ProjectAccess, canReadContent } from '../projects/access.service';
import type { ProjectStatus } from '../projects/matrix';
import type { Usage } from '../spend/cost';
import type { SpendService } from '../spend/spend.service';
import { validateCitations } from './citations';
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
 * not given). May refuse, which blocks the request without any AI call or spend.
 */
export type InputBuilder = (db: Db, request: AssistRequest, material: RequestMaterial[]) => Promise<AssistInput | Refusal>;

/**
 * Saves a kind's validated output. Runs in the transaction that also marks the cited material and sets the request
 * `succeeded`, so there is never an output without its request result, or the reverse. Throwing rolls everything back.
 */
export type Completion = (db: PoolClient, request: AssistRequest, output: unknown) => Promise<void>;

const builders = new Map<AssistKind, InputBuilder>();
const completions = new Map<AssistKind, Completion>();

/** Tasks for reports and summaries register their own input; a later registration replaces an earlier one. */
export function registerInputBuilder(kind: AssistKind, fn: InputBuilder): void {
  builders.set(kind, fn);
}

export function registerCompletion(kind: AssistKind, fn: Completion): void {
  completions.set(kind, fn);
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

/** Writes the answer. The cited flags are set by the runner in the same transaction. */
export async function completeQuestion(db: PoolClient, request: AssistRequest, output: unknown): Promise<void> {
  const o = output as QuestionOutput;
  const done = await db.query(`UPDATE ai_answers SET answer_markdown = $2, not_found = $3 WHERE request_id = $1`, [request.id, o.answer_markdown, o.not_found]);
  if (done.rowCount !== 1) throw new Error(`assist ${request.id}: no answer row to complete`);
}

registerInputBuilder('question', questionInput);
registerCompletion('question', completeQuestion);

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

    const scope = await this.recheck(request);
    if ('code' in scope) return this.end(request, 'blocked', scope);

    const spec = KINDS[request.kind];
    const build = builders.get(request.kind);
    const complete = completions.get(request.kind);
    if (!build || !complete) {
      return this.end(request, 'failed', { code: 'kind_not_available', detail: 'This kind of AI request is not available on this worker.' });
    }

    // Drop what the scope can no longer read; it is never sent, and the answer can say so.
    const live = request.material.filter((m) => !m.droppedAtStart);
    const readable = await readableMaterial(pool, scope, live);
    const kept = live.filter((_, i) => readable[i]);
    await markDropped(pool, request.id, live.filter((_, i) => !readable[i]).map((m) => m.ordinal));

    const input = await build(pool, request, kept);
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
          return { output, cited, usage };
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

    const thread = (
      await pool.query<{ id: string; mode: AudienceMode; named: string[] }>(
        `SELECT a.id, a.mode, COALESCE((SELECT array_agg(m.user_id) FROM audience_members m WHERE m.audience_id = a.id), '{}') AS named
           FROM discussion_threads t JOIN audiences a ON a.id = t.audience_id
          WHERE t.id = $1 AND t.project_id = $2`,
        [request.scopeThreadId, request.projectId],
      )
    ).rows[0];
    if (!thread) return { code: 'thread_not_found', detail: 'The thread for this request no longer exists, so the AI request did not run.' };
    if (!inAudience(ctx, { id: thread.id, projectId: request.projectId, mode: thread.mode, namedUserIds: thread.named })) {
      return { code: 'requester_not_allowed', detail: 'The person who asked can no longer read this thread, so the AI request did not run.' };
    }
    return { kind: 'thread', ctx, threadAudienceId: thread.id };
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
      await markCited(client, request.id, cited);
      await complete(client, request, output);
      await client.query(
        `UPDATE ai_requests SET status = 'succeeded', model_id = $2, failure_code = NULL, failure_detail = NULL, finished_at = $3 WHERE id = $1`,
        [request.id, modelId, this.d.clock()],
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
