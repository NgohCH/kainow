import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Adj, countedAmount, figures, refundLimit } from './figures';

const at = (d: number) => new Date(Date.UTC(2026, 10, d));
const adj = (kind: Adj['kind'], amount: bigint, d: number): Adj => ({ kind, amount, approvedAt: at(d) });
const same = (amount: bigint, adjustments: Adj[] = []) => ({ amount, currency: 'MYR' as const, adjustments });
const foreign = (amount: bigint, adjustments: Adj[] = [], currency: 'SGD' | 'USD' = 'USD') => ({ amount, currency, adjustments });

test('refund equal to counted leaves zero; above is refused; re-conversion resets the base', () => {
  const e = { amount: 10000n, currency: 'MYR' as const };
  assert.equal(refundLimit(e, 'MYR', []), 10000n);
  assert.equal(countedAmount(e, 'MYR', [adj('refund', 10000n, 2)]), 0n);
  const partial = [adj('refund', 4000n, 2)];
  assert.equal(refundLimit(e, 'MYR', partial), 6000n);
  // a refund one minor unit above the limit would exceed it
  assert.ok(6001n > refundLimit(e, 'MYR', partial)!);
  const usd = { amount: 1000n, currency: 'USD' as const };
  const converted = [adj('conversion', 4700n, 1), adj('refund', 700n, 2)];
  assert.equal(refundLimit(usd, 'MYR', converted), 4000n);
  const reconverted = [...converted, adj('conversion', 5000n, 3)];
  assert.equal(refundLimit(usd, 'MYR', reconverted), 5000n);
});

test('countedAmount: foreign entry is null until converted; adjustments apply by approvedAt', () => {
  const usd = { amount: 1000n, currency: 'USD' as const };
  assert.equal(countedAmount(usd, 'MYR', []), null);
  assert.equal(refundLimit(usd, 'MYR', []), null);
  assert.equal(countedAmount(usd, 'MYR', [adj('conversion', 4700n, 1)]), 4700n);
  // correction then conversion: conversion wins; supplied out of order
  assert.equal(countedAmount(usd, 'MYR', [adj('conversion', 4700n, 5), adj('correction', 900n, 2)]), 4700n);
  assert.equal(countedAmount(usd, 'MYR', [adj('conversion', 4700n, 2), adj('correction', 900n, 5)]), 900n);
  assert.equal(countedAmount({ amount: 100n, currency: 'MYR' }, 'MYR', [adj('correction', 250n, 1)]), 250n);
  assert.equal(countedAmount({ amount: 100n, currency: 'MYR' }, 'MYR', []), 100n);
});

test('zero budget with spending is over budget without a percentage', () => {
  const f = figures({ budget: 0n, entries: [same(2500n)], reporting: 'MYR', warn: [80, 100] });
  assert.equal(f.overBudget, true);
  assert.equal(f.percentUsed, null);
  assert.equal(f.balance, -2500n);
  assert.equal(f.level, 2);
  const none = figures({ budget: 0n, entries: [], reporting: 'MYR', warn: [80, 100] });
  assert.equal(none.overBudget, false);
  assert.equal(none.level, 0);
  assert.equal(none.percentUsed, null);
});

test('thresholds: 80% is level 1, 100% is level 2, 199/200 is 99%', () => {
  const run = (spent: bigint, budget = 10000n) => figures({ budget, entries: [same(spent)], reporting: 'MYR', warn: [80, 100] });
  assert.equal(run(7999n).level, 0);
  assert.equal(run(8000n).level, 1);
  assert.equal(run(8000n).percentUsed, 80);
  assert.equal(run(10000n).level, 2);
  assert.equal(run(10000n).overBudget, false);
  assert.equal(run(10001n).overBudget, true);
  const f = run(199n, 200n);
  assert.equal(f.percentUsed, 99);
  assert.equal(f.level, 1);
  assert.equal(f.balance, 1n);
});

test('no budget: balance and percentUsed null, level 0', () => {
  const f = figures({ budget: null, entries: [same(500n)], reporting: 'MYR', warn: [80, 100] });
  assert.equal(f.balance, null);
  assert.equal(f.percentUsed, null);
  assert.equal(f.level, 0);
  assert.equal(f.overBudget, false);
  assert.equal(f.spent, 500n);
});

test('unconverted foreign entries are left out of spent and listed per currency', () => {
  const f = figures({
    budget: 100000n,
    reporting: 'MYR',
    warn: [80, 100],
    entries: [same(1000n), foreign(300n), foreign(200n), foreign(50n, [], 'SGD'), foreign(100n, [adj('conversion', 470n, 1)])],
  });
  assert.equal(f.spent, 1470n);
  assert.deepEqual(f.notInTotals, [
    { currency: 'SGD', amount: 50n },
    { currency: 'USD', amount: 500n },
  ]);
});
