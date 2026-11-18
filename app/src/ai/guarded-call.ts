import type { Pool } from 'pg';
import type { Clock } from '../auth/tokens';
import { ModelBadResponse, ModelCallError } from '../extraction/model';
import type { ProtectedKey } from '../quarantine/protected-key';
import { estimateMaxCostMicroMyr, type Usage } from '../spend/cost';
import { spendFailureCode, spendFailureDetail, type SpendService } from '../spend/spend.service';
import { readSettings } from '../spend/spend.settings';
import { type CandidateConnection, NOTE_BAD_RESPONSE, NOTE_RATE_LIMITED, chooseConnection, loadCandidates, previousOutcome } from './chooser';
import { type ModelClientFactory, type ProviderClient, clientForAttempt } from './client-factory';
import { type KeyRejectedNotice, markKeyRejectedNow } from './key-rejected';
import { KeyUnreadableError, type Provider } from './keys';
import { effectivePolicy } from './policy';
import { releaseSlot, waitForSlot } from './slots';

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

/** The detail a run or request shows while it waits for a free AI place (spec 6.5, the existing Queued state). */
export const WAITING_FOR_PLACE = 'Queued — waiting for a free AI place';

/** The lease on a slot outlasts the call by this margin (spec 6.5). */
const LEASE_MARGIN_MS = 60_000;

export interface GuardedCallInput<T> {
  requestId: string;
  attemptNo: number;
  purpose: AiPurpose;
  /** null for an automatic run: only the organisation caps apply, not a personal one. */
  actorUserId: string | null;
  projectId: string;
  /** Any text sent comes from restricted material (spec 3, 6.3): only connections approved for it are eligible. */
  carriesRestricted: boolean;
  promptBytes: number;
  maxOutputTokens: number;
  /** One attempt with the client for the chosen connection, its model and the effective timeout. */
  call: (client: ProviderClient, modelId: string, timeoutMs: number) => Promise<T & { usage: Usage }>;
}

export type GuardedOutcome<T> =
  | { kind: 'ok'; value: T; modelId: string; connectionId: string; provider: Provider }
  | { kind: 'blocked' | 'failed'; code: string; detail: string }
  | { kind: 'retry' }
  /** No AI place was free within the wait (spec 6.5). Nothing was reserved, sent or charged, and no attempt was used. */
  | { kind: 'wait' };

export interface GuardedDeps {
  pool: Pool;
  spend: SpendService;
  clock: Clock;
  log?: (message: string) => void;
  /** null when the protected key is not installed: every request then ends blocked protected_key_missing. */
  key: ProtectedKey | null;
  factory: ModelClientFactory;
  /** Told once when a call first finds a connection's key rejected (after the notices are written). */
  notify?: (n: KeyRejectedNotice) => Promise<void>;
  /** Waiting for a free AI place; tests shorten it. Defaults: at most 120 s, polling every second. */
  slotWait?: { maxWaitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> };
}

/**
 * A worker that stopped mid-request leaves its reservation open. The outcome is unknown, so it stays counted.
 * Safe to call more than once.
 */
export async function markStaleReservations(
  pool: Pool,
  spend: Pick<SpendService, 'markUncertain'>,
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

const blocked = (code: string, detail: string) => ({ kind: 'blocked' as const, code, detail });

/** The sealed current key of a connection, or null when it has none (replaced or removed since the candidates were read). */
async function sealedKeyOf(pool: Pool, connectionId: string) {
  const { rows } = await pool.query<{ ciphertext: Buffer; nonce: Buffer; tag: Buffer; key_id: string }>(
    `SELECT ciphertext, nonce, tag, key_id FROM ai_connection_keys WHERE connection_id = $1 AND superseded_at IS NULL`,
    [connectionId],
  );
  const r = rows[0];
  return r ? { ciphertext: r.ciphertext, nonce: r.nonce, tag: r.tag, keyId: r.key_id } : null;
}

/**
 * One AI request attempt through the project's connections and the spend caps (spec 6.1), in this order:
 *  1. stale reservations of earlier attempts become uncertain;
 *  2. the effective policy: an attempt above the effective attempts ends the request, sending nothing;
 *  3. choose the connection (6.2), or end blocked;
 *  4. wait for a free AI place (6.5), or answer `wait`; nothing is reserved while waiting;
 *  5. open the chosen key and build its client: a key that will not open makes that connection ineligible for this
 *     attempt and the choice is made again (Ruling P11), before anything is reserved;
 *  6. reserve with the chosen model's prices and the project;
 *  7. send with the effective timeout;
 *  8. settle, mark uncertain or release; then mark the key rejected (401/403) or the connection ready and used;
 *  9. release the place.
 * Shared by extraction, discussion analysis, minutes drafting and the AI assist requests.
 */
export async function guardedAiCall<T>(deps: GuardedDeps, input: GuardedCallInput<T>): Promise<GuardedOutcome<T>> {
  const { pool, spend } = deps;
  await markStaleReservations(pool, spend, input.requestId, input.attemptNo);

  const policy = await effectivePolicy(pool, input.projectId);
  if (input.attemptNo > policy.maxAttempts) {
    return { kind: 'failed', code: 'attempts_used', detail: 'No attempts are left for this request.' };
  }

  const candidates = await loadCandidates(pool, input.projectId, input.purpose, input.carriesRestricted, deps.key?.id ?? null);
  const noneEligible = blocked(
    'no_eligible_connection',
    `No AI connection in this project is approved for ${NOUN[input.purpose]}${input.carriesRestricted ? ' with restricted material' : ''} and usable now.`,
  );
  if (candidates.reason === 'protected_key_missing' || !deps.key) {
    return blocked('protected_key_missing', 'The protected key is not installed, so no AI key can be opened. Nothing was sent or charged.');
  }
  if (candidates.reason === 'ai_not_set_up') return blocked('ai_not_set_up', 'AI is not set up for this project.');
  if (candidates.reason === 'no_eligible_connection') return noneEligible;
  const previous = await previousOutcome(pool, input.requestId, input.attemptNo);
  let chosen = chooseConnection(candidates.list, previous);
  if (!chosen) return noneEligible;

  const holder = `${input.requestId}:${input.attemptNo}`;
  const slot = await waitForSlot(
    pool,
    holder,
    async () => (await effectivePolicy(pool, input.projectId)).concurrency,
    policy.timeoutMs + LEASE_MARGIN_MS,
    deps.slotWait,
  );
  if (slot === null) return { kind: 'wait' };

  try {
    // The decrypted key lives only inside the client built for this attempt.
    let client: ProviderClient | null = null;
    while (chosen && !client) {
      const sealed = await sealedKeyOf(pool, chosen.id);
      try {
        if (!sealed) throw new KeyUnreadableError();
        client = clientForAttempt(deps.key, sealed, { connectionId: chosen.id, projectId: input.projectId, provider: chosen.provider }, deps.factory, policy.timeoutMs);
      } catch (err) {
        if (!(err instanceof KeyUnreadableError)) throw err;
        deps.log?.(`${input.purpose} ${input.requestId}: the key of AI connection ${chosen.id} cannot be read; skipping it for this attempt`);
        const skipped: CandidateConnection = chosen;
        skipped.eligible = false;
        chosen = chooseConnection(candidates.list, previous);
      }
    }
    if (!chosen || !client) return noneEligible;
    const connection = chosen;

    const settings = await readSettings(pool);
    if (!settings) return blocked(spendFailureCode('not_configured'), spendFailureDetail('not_configured'));
    const prices = { ...connection.prices, myrPerUsdMicro: settings.prices.myrPerUsdMicro };
    const reserved = await spend.reserve({
      requestId: input.requestId,
      attemptNo: input.attemptNo,
      estimateMicroMyr: estimateMaxCostMicroMyr(input.promptBytes, input.maxOutputTokens, prices),
      purpose: input.purpose,
      actorUserId: input.actorUserId,
      projectId: input.projectId,
      connectionId: connection.id,
      provider: connection.provider,
      modelId: connection.modelId,
      prices,
    });
    if (reserved.status === 'blocked') {
      return blocked(spendFailureCode(reserved.reason, reserved.scope), spendFailureDetail(reserved.reason, reserved.scope));
    }
    const entryId = reserved.entryId;

    let result: T & { usage: Usage };
    try {
      // From here on the provider may have done the work and charged for it.
      result = await input.call(client, connection.modelId, policy.timeoutMs);
    } catch (err) {
      return await failed(deps, input, policy.maxAttempts, connection, entryId, err);
    }
    // The cost is recorded first, so it is counted even if the caller's saving of the answer fails.
    await spend.settle(entryId, result.usage);
    await pool.query(
      `UPDATE ai_connections SET last_used_at = $2, state = CASE WHEN state = 'unchecked' THEN 'ready' ELSE state END WHERE id = $1`,
      [connection.id, deps.clock()],
    );
    return { kind: 'ok', value: result, modelId: connection.modelId, connectionId: connection.id, provider: connection.provider };
  } finally {
    await releaseSlot(pool, slot, holder).catch((err: unknown) => deps.log?.(`${input.purpose} ${input.requestId}: could not release the AI place: ${String(err)}`));
  }
}

async function failed<T>(
  deps: GuardedDeps,
  input: GuardedCallInput<T>,
  maxAttempts: number,
  connection: CandidateConnection,
  entryId: string,
  err: unknown,
): Promise<GuardedOutcome<T>> {
  const { spend } = deps;
  let code = 'internal_error';
  const noun = NOUN[input.purpose];
  let detail = `An unexpected error stopped the ${noun}.`;
  let retryable = true;

  try {
    if (err instanceof ModelBadResponse) {
      await spend.settle(entryId, err.usage, NOTE_BAD_RESPONSE); // the provider did the work, so it is charged
      code = 'bad_response';
      detail = err.message;
    } else if (err instanceof ModelCallError) {
      await spend.markUncertain(entryId, err.message);
      if (err.outcome === 'rejected') {
        // An error answer from the provider before any work is the evidence that nothing was charged.
        const evidence = err.status === 429 ? NOTE_RATE_LIMITED : `HTTP ${err.status ?? 'error'} answer from the provider; no usage was reported`;
        await spend.reconcileNotCharged(entryId, evidence);
      }
      code = err.outcome === 'rejected' ? 'model_rejected' : 'model_unavailable';
      detail = err.message;
      retryable = err.retryable;
      if (err.keyRejected) {
        retryable = false;
        const notice = await markKeyRejectedNow(deps.pool, { connectionId: connection.id, status: err.status as number, at: deps.clock() });
        if (notice) await deps.notify?.(notice);
      }
    } else {
      deps.log?.(`${input.purpose} ${input.requestId}: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      // The request was handed to the provider client, so the outcome is unknown.
      await spend.markUncertain(entryId, 'an unexpected error happened after the request was sent');
    }
  } catch (accountingError) {
    // Never hide an accounting problem. The entry stays counted at its estimate until someone reconciles it.
    deps.log?.(`${input.purpose} ${input.requestId}: could not record the spend outcome: ${String(accountingError)}`);
    code = 'internal_error';
    detail = 'The AI spend could not be recorded; the estimate stays counted.';
  }

  if (retryable && input.attemptNo < maxAttempts) return { kind: 'retry' };
  return { kind: 'failed', code, detail };
}
