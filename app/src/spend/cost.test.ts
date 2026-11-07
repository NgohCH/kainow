import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROMPT_OVERHEAD_TOKENS, costMicroMyr, estimateMaxCostMicroMyr, type Prices } from './cost';

/** gpt-6.1-sol at Standard rates, 1 USD = 4.1 MYR. */
const MVP: Prices = {
  inputMicroUsdPerMillion: 2_000_000n,
  cachedInputMicroUsdPerMillion: 100_000n,
  outputMicroUsdPerMillion: 10_000_000n,
  myrPerUsdMicro: 4_100_000n,
};

test('the example extraction costs MYR 0.164', () => {
  // 10,000 input tokens at $2 per million = $0.02, 2,000 output tokens at $10 per million = $0.02.
  // $0.04 at 4.1 MYR to the dollar is MYR 0.164.
  assert.equal(costMicroMyr({ inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 }, MVP), 164_000n);
});

test('cached input tokens are priced at the cached rate', () => {
  // 2,000 uncached at $2 + 8,000 cached at $0.10 = $0.0048, which is MYR 0.01968.
  assert.equal(costMicroMyr({ inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 0 }, MVP), 19_680n);
});

test('a cost is rounded up, never down', () => {
  // One input token is $0.000002, which is 0.0000082 MYR: 8.2 micro-MYR rounds up to 9.
  assert.equal(costMicroMyr({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }, MVP), 9n);
});

test('no usage costs nothing', () => {
  assert.equal(costMicroMyr({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, MVP), 0n);
});

test('rejects usage that makes no sense', () => {
  assert.throws(() => costMicroMyr({ inputTokens: 10, cachedInputTokens: 11, outputTokens: 0 }, MVP), RangeError);
  assert.throws(() => costMicroMyr({ inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 }, MVP), RangeError);
  assert.throws(() => costMicroMyr({ inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 0 }, MVP), RangeError);
  assert.throws(() => costMicroMyr({ inputTokens: NaN, cachedInputTokens: 0, outputTokens: 0 }, MVP), RangeError);
});

test('a reservation for a long note and a full-length answer', () => {
  // 50,000 bytes of prompt plus the framing margin, and 8,000 output tokens.
  const expected = costMicroMyr(
    { inputTokens: 50_000 + PROMPT_OVERHEAD_TOKENS, cachedInputTokens: 0, outputTokens: 8_000 },
    MVP,
  );
  assert.equal(estimateMaxCostMicroMyr(50_000, 8_000, MVP), expected);
  assert.equal(expected, 738_820n);
});

test('a reservation is never less than the real cost of anything that could fit it', () => {
  const bytes = 30_000;
  const maxOutput = 4_000;
  const reserved = estimateMaxCostMicroMyr(bytes, maxOutput, MVP);
  // A token is at least one byte, so even a worst-case prompt cannot have more tokens than bytes.
  for (const inputTokens of [1, 5_000, 20_000, bytes]) {
    for (const outputTokens of [0, 1_000, maxOutput]) {
      for (const cachedInputTokens of [0, Math.floor(inputTokens / 2), inputTokens]) {
        assert.ok(costMicroMyr({ inputTokens, cachedInputTokens, outputTokens }, MVP) <= reserved);
      }
    }
  }
});

test('the reservation uses the higher of the cached and uncached input prices', () => {
  const odd: Prices = { ...MVP, inputMicroUsdPerMillion: 100_000n, cachedInputMicroUsdPerMillion: 2_000_000n };
  const reserved = estimateMaxCostMicroMyr(1_000, 1, odd);
  assert.ok(reserved >= costMicroMyr({ inputTokens: 1_000, cachedInputTokens: 1_000, outputTokens: 1 }, odd));
});

test('a reservation cannot be made without a prompt size and an output maximum', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => estimateMaxCostMicroMyr(bad, 100, MVP), RangeError);
    assert.throws(() => estimateMaxCostMicroMyr(100, bad, MVP), RangeError);
  }
  assert.throws(() => estimateMaxCostMicroMyr(100, 0, MVP), /cannot be bounded/);
});

test('a reservation is never zero, even when prices are zero', () => {
  const free: Prices = { ...MVP, inputMicroUsdPerMillion: 0n, cachedInputMicroUsdPerMillion: 0n, outputMicroUsdPerMillion: 0n };
  assert.equal(estimateMaxCostMicroMyr(10, 10, free), 1n);
});
