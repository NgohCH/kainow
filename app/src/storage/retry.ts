/**
 * When a failed storage job is tried again (spec 5.6): initial attempt plus four retries at 1, 5, 30 and 120 minutes after
 * the first failure, so the gaps between attempts are 1, 4, 25 and 90 minutes. A provider's Retry-After wins when later.
 */
const SCHEDULE_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const;

/** Retries after the initial attempt. */
export const MAX_RETRIES = SCHEDULE_MS.length;

/** A job waiting for the protected key looks again after this long, without counting an attempt. */
export const WAIT_FOR_KEY_MS = 300_000;

/**
 * The offset from the first failure at which retry number `failedAttempts` (1 to 4) runs, or `retryAfterMs` when that is
 * later. Callers that know the first failure time use `nextAttemptAt`, which measures Retry-After from now.
 */
export function retryDelayMs(failedAttempts: number, retryAfterMs?: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1 || failedAttempts > MAX_RETRIES) {
    throw new RangeError('A storage job has at most four retries.');
  }
  return Math.max(SCHEDULE_MS[failedAttempts - 1], retryAfterMs ?? 0);
}

/** When retry number `failedAttempts` runs: on the schedule from the first failure, never before Retry-After, never in the past. */
export function nextAttemptAt(firstFailureAt: Date, failedAttempts: number, now: Date, retryAfterMs?: number): Date {
  const scheduled = firstFailureAt.getTime() + retryDelayMs(failedAttempts);
  return new Date(Math.max(scheduled, now.getTime() + (retryAfterMs ?? 0)));
}
