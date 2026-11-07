import { ceilDiv } from './money';

/** Approved prices. Prices are micro-USD per 1 million tokens; the rate is micro-MYR per USD. */
export interface Prices {
  inputMicroUsdPerMillion: bigint;
  cachedInputMicroUsdPerMillion: bigint;
  outputMicroUsdPerMillion: bigint;
  myrPerUsdMicro: bigint;
}

/** Usage as the provider reports it. Input tokens include the cached ones, as OpenAI reports them. */
export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Margin added to the prompt size for message framing and special tokens, which are not in the
 * text itself. A deliberately generous allowance.
 */
export const PROMPT_OVERHEAD_TOKENS = 100;

const TRILLION = 1_000_000_000_000n; // million tokens x micro-USD x micro-MYR per USD

function tokenCount(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative whole number`);
  }
  return BigInt(value);
}

/** Cost in micro-MYR, rounded up so a cost is never understated. */
export function costMicroMyr(usage: Usage, prices: Prices): bigint {
  const input = tokenCount(usage.inputTokens, 'inputTokens');
  const cached = tokenCount(usage.cachedInputTokens, 'cachedInputTokens');
  const output = tokenCount(usage.outputTokens, 'outputTokens');
  if (cached > input) {
    throw new RangeError('cachedInputTokens cannot be more than inputTokens');
  }
  const microUsdTimesMillion =
    (input - cached) * prices.inputMicroUsdPerMillion +
    cached * prices.cachedInputMicroUsdPerMillion +
    output * prices.outputMicroUsdPerMillion;
  return ceilDiv(microUsdTimesMillion * prices.myrPerUsdMicro, TRILLION);
}

/**
 * A cost that the real charge cannot exceed, used to reserve before a request is sent.
 *
 * - Input: a token is at least one byte of text, so the prompt's byte length bounds its tokens.
 *   A margin for message framing is added, and every token is priced as uncached (or at the
 *   cached price if that were ever higher), so a cache hit can only lower the cost.
 * - Output: the request must carry a maximum, and the reservation assumes all of it is used.
 *   If the provider counts hidden reasoning as output, that maximum must cover it.
 */
export function estimateMaxCostMicroMyr(promptBytes: number, maxOutputTokens: number, prices: Prices): bigint {
  if (!Number.isSafeInteger(promptBytes) || promptBytes < 1) {
    throw new RangeError('promptBytes must be a whole number of at least 1');
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new RangeError('maxOutputTokens must be a whole number of at least 1: without a maximum the cost cannot be bounded');
  }
  const inputPrice =
    prices.inputMicroUsdPerMillion > prices.cachedInputMicroUsdPerMillion
      ? prices.inputMicroUsdPerMillion
      : prices.cachedInputMicroUsdPerMillion;
  const inputTokens = BigInt(promptBytes + PROMPT_OVERHEAD_TOKENS);
  const microUsdTimesMillion = inputTokens * inputPrice + BigInt(maxOutputTokens) * prices.outputMicroUsdPerMillion;
  const cost = ceilDiv(microUsdTimesMillion * prices.myrPerUsdMicro, TRILLION);
  return cost > 0n ? cost : 1n; // a reservation is never zero
}
