import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjustmentLabel, figuresLines, money, normaliseAmountInput, notInTotalsLines, pendingLabel, type FiguresView } from './finance.ts';

const base: FiguresView = { budget: '120000.00', spent: '98400.00', balance: '21600.00', percentUsed: 82, overBudget: false, level: 1, notInTotals: [], warnThresholds: [80, 100] };

test('normaliseAmountInput strips spaces and thousands commas', () => {
  assert.equal(normaliseAmountInput('1,250.50'), '1250.50');
  assert.equal(normaliseAmountInput(' 1 250.5 '), '1250.5');
  assert.equal(normaliseAmountInput('300'), '300');
});

test('money: thousands commas, 2 decimals, Not provided, zero kept', () => {
  assert.equal(money('120000.00', 'MYR'), 'MYR 120,000.00');
  assert.equal(money('999999999999.99', 'USD'), 'USD 999,999,999,999.99');
  assert.equal(money('12.5', 'SGD'), 'SGD 12.50');
  assert.equal(money('0.00', 'MYR'), 'MYR 0.00');
  assert.equal(money('0.00', 'MYR', { code: false }), '0.00');
  assert.equal(money(null, 'MYR'), 'Not provided');
  assert.equal(money('-1250.50', 'MYR'), 'MYR -1,250.50');
});

test('figuresLines: balance, percentage and the advisory warning', () => {
  assert.deepEqual(figuresLines(base, 'MYR'), [
    'Balance based on recorded expenditure: MYR 21,600.00',
    '82% of the approved budget used',
    'Recorded spending reached 80% of the approved budget (advisory).',
    'Based on recorded entries.',
  ]);
});

test('figuresLines: over budget at the second threshold, and budget 0 with spending has no percentage', () => {
  const over = figuresLines({ ...base, spent: '130000.00', balance: '-10000.00', percentUsed: 108, overBudget: true, level: 2 }, 'MYR');
  assert.deepEqual(over, [
    'Balance based on recorded expenditure: MYR -10,000.00',
    'Over budget',
    '108% of the approved budget used',
    'Recorded spending reached 100% of the approved budget (advisory).',
    'Based on recorded entries.',
  ]);
  const zero = figuresLines({ ...base, budget: '0.00', spent: '5.00', balance: '-5.00', percentUsed: null, overBudget: true, level: 2 }, 'MYR');
  assert.deepEqual(zero, [
    'Balance based on recorded expenditure: MYR -5.00',
    'Over budget',
    'Recorded spending is over the approved budget (advisory).',
    'Based on recorded entries.',
  ]);
});

test('figuresLines: nothing when the budget is missing; no warning below the first threshold', () => {
  assert.deepEqual(figuresLines({ ...base, budget: null, balance: null, percentUsed: null, level: 0 }, 'MYR'), []);
  assert.deepEqual(figuresLines({ ...base, percentUsed: 10, level: 0 }, 'MYR').length, 3);
});

test('notInTotalsLines names each currency awaiting conversion', () => {
  assert.deepEqual(notInTotalsLines({ notInTotals: [{ currency: 'USD', amount: '1250.00' }] }), ['Not in totals: USD 1,250.00 awaiting conversion']);
  assert.deepEqual(notInTotalsLines({ notInTotals: [] }), []);
});

test('adjustmentLabel and pendingLabel', () => {
  assert.equal(adjustmentLabel({ kind: 'correction', amount: '0.00', rate: null, rateOn: null, refundOn: null }, 'MYR'), 'Correction: counted amount set to MYR 0.00');
  assert.equal(adjustmentLabel({ kind: 'refund', amount: '20.00', rate: null, rateOn: null, refundOn: '2026-12-01' }, 'MYR'), 'Refund of MYR 20.00 on 2026-12-01');
  assert.equal(adjustmentLabel({ kind: 'conversion', amount: '5000.00', rate: '4.00000000', rateOn: '2026-12-02', refundOn: null }, 'MYR'), 'Conversion: MYR 5,000.00 at rate 4.00000000 on 2026-12-02');
  assert.equal(pendingLabel({ kind: 'set_budget', terms: { amount: '10.00' } }), 'Awaiting approval: budget');
  assert.equal(pendingLabel({ kind: 'finance_adjustment', terms: { type: 'refund' } }), 'Awaiting approval: refund');
  assert.equal(pendingLabel({ kind: 'finance_adjustment', terms: null }), 'Awaiting approval: adjustment');
});
