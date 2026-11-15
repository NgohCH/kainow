import type { Pool } from 'pg';
import type { Clock } from '../auth/tokens';
import { ModelBadResponse, ModelCallError } from '../extraction/model';
import { estimateMaxCostMicroMyr, type Usage } from '../spend/cost';
import type { SpendService } from '../spend/spend.service';
import { readSettings } from '../spend/spend.settings';

export type AiPurpose = 'extraction' | 'discussion_analysis' | 'minutes_draft' | 'question_answer' | 'report_draft' | 'summary_draft';

/** How a failure names the work that stopped. */
const NOUN: Record<AiPurpose, string> = {
  extraction: 'extraction',
  discussion_analysis: 'analysis',
  minutes_draft: 'minutes drafting',
  question_answer: 'answering',
  report_draft: 'report drafting',
  summary_draft: 'summary drafting',
};

export interface GuardedCallInput<T> {
  requestId: string;
  attemptNo: number;
  isLastAttempt: boolean;
  purpose: AiPurpose;
  /** null for an automatic run: only the organisation caps apply, not a personal one. */
  actorUserId: string | null;
  promptBytes: number;
  maxOutputTokens: number;
  call: (modelId: string) => Promise<T & { usage: Usage }>;
}

export type GuardedOutcome<T> =
  | { kind: 'ok'; value: T; modelId: string }
  | { kind: 'blocked' | 'failed'; code: string; detail: string }
  | { kind: 'retry' };

export interface GuardedDeps {
  pool: Pool;
  spend: SpendService;
  clock: Clock;
  log?: (message: string) => void;
  /** false when no API key is configured: the call then fails without any charge. */
  modelConfigured: boolean;
}

/**
 * A worker that stopped mid-request leaves its reservation open. The outcome is unknown, so it stays counted.
 * Safe to call more than once.
 */
export async function markStaleReservations(
  pool: Pool,
  spend: SpendService,
  requestId: string,
  attemptNo: number,
): Promise<void> {
  const stale = await pool.query<{ id: string }>(
    `SELECT id FROM ai_spend_entries WHERE request_id = $1 AND attempt_no < $2 AND status = 'reserved'`,
    [requestId, attemptNo],
  );
  for (const e of stale.rows) {
    await spend.markUncertain(e.id, 'the worker stopped before the outcome was known');
  }
}

/**
 * One AI request through the spend cap: reserve before sending, settle from reported usage afterwards, and
 * keep the full estimate counted whenever the outcome is unknown. Shared by extraction, discussion analysis,
 * minutes drafting and the AI assist requests (answers, report drafts, summaries).
 */
export async function guardedAiCall<T>(deps: GuardedDeps, input: GuardedCallInput<T>): Promise<GuardedOutcome<T>> {
  const { pool, spend } = deps;
  await markStaleReservations(pool, spend, input.requestId, input.attemptNo);

  if (!deps.modelConfigured) {
    return { kind: 'failed', code: 'model_not_configured', detail: 'No AI key is configured on the worker. Nothing was sent or charged.' };
  }

  const settings = await readSettings(pool);
  if (!settings) {
    return { kind: 'blocked', code: 'spend_not_configured', detail: 'The AI spend settings have not been approved yet, so no AI request is allowed.' };
  }

  const estimate = estimateMaxCostMicroMyr(input.promptBytes, input.maxOutputTokens, settings.prices);
  const reserved = await spend.reserve({
    requestId: input.requestId,
    attemptNo: input.attemptNo,
    estimateMicroMyr: estimate,
    purpose: input.purpose,
    actorUserId: input.actorUserId,
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
    return {
      kind: 'blocked',
      code: `spend_${personal ? 'user_' : ''}${reserved.reason}`,
      detail: why[reserved.reason] ?? 'Blocked by the AI spend cap.',
    };
  }
  const entryId = reserved.entryId;

  let sent = false;
  try {
    sent = true; // from here on the provider may have done the work and charged for it
    const result = await input.call(settings.modelId);
    // The cost is recorded first, so it is counted even if the caller's saving of the answer fails.
    await spend.settle(entryId, result.usage);
    return { kind: 'ok', value: result, modelId: settings.modelId };
  } catch (err) {
    return failed(deps, input, entryId, sent, err);
  }
}

async function failed<T>(deps: GuardedDeps, input: GuardedCallInput<T>, entryId: string, sent: boolean, err: unknown): Promise<GuardedOutcome<T>> {
  const { spend } = deps;
  let code = 'internal_error';
  const noun = NOUN[input.purpose];
  let detail = `An unexpected error stopped the ${noun}.`;
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
      deps.log?.(`${input.purpose} ${input.requestId}: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (sent) await spend.markUncertain(entryId, 'an unexpected error happened after the request was sent');
      else await spend.releaseUnsent(entryId);
    }
  } catch (accountingError) {
    // Never hide an accounting problem. The entry stays counted at its estimate until someone reconciles it.
    deps.log?.(`${input.purpose} ${input.requestId}: could not record the spend outcome: ${String(accountingError)}`);
    code = 'internal_error';
    detail = 'The AI spend could not be recorded; the estimate stays counted.';
  }

  if (retryable && !input.isLastAttempt) return { kind: 'retry' };
  return { kind: 'failed', code, detail };
}
