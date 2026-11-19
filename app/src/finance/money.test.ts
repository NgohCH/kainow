import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { CURRENCIES, formatAmount, parseAmount, parseRate, toDecimalString } from './money';

const BAD = 'Enter an amount with at most 2 decimal places.';
const ZERO = 'Enter an amount above 0.';
const refuses = (s: unknown, allowZero: boolean, message: string) =>
  assert.throws(() => parseAmount(s, { allowZero }), (e: unknown) => e instanceof BadRequestException && e.message === message);

test('parseAmount accepts plain decimals as minor units', () => {
  assert.equal(parseAmount('1250.50', { allowZero: false }), 125050n);
  assert.equal(parseAmount('12', { allowZero: false }), 1200n);
  assert.equal(parseAmount('0.5', { allowZero: false }), 50n);
  assert.equal(parseAmount('999999999999.99', { allowZero: false }), 99999999999999n);
});

test('parseAmount refuses commas, extra decimals, negatives, exponents and non-strings', () => {
  for (const s of ['1,250.50', '12.345', '-5', '1e3', '', ' ', 'abc', '1.', '.5', '1000000000000', '+5']) refuses(s, true, BAD);
  for (const v of [null, undefined, 5, {}]) refuses(v, true, BAD);
});

test('parseAmount: 0 is refused unless allowZero', () => {
  refuses('0', false, ZERO);
  refuses('0.00', false, ZERO);
  assert.equal(parseAmount('0', { allowZero: true }), 0n);
  assert.equal(parseAmount('0.00', { allowZero: true }), 0n);
});

test('parseRate normalises and refuses zero or bad shapes', () => {
  assert.equal(parseRate('4.7'), '4.7');
  assert.equal(parseRate('4.70000000'), '4.7');
  assert.equal(parseRate('0004.5'), '4.5');
  assert.equal(parseRate('3'), '3');
  const msg = 'Enter a rate above 0 with at most 8 decimal places.';
  for (const s of ['0', '0.0', '-1', '1.123456789', '12345678901', '1,5', 'x', '', null, 3]) {
    assert.throws(() => parseRate(s), (e: unknown) => e instanceof BadRequestException && e.message === msg);
  }
});

test('formatAmount and toDecimalString', () => {
  assert.equal(formatAmount(12000000n, 'MYR'), '120,000.00');
  assert.equal(formatAmount(5n, 'USD'), '0.05');
  assert.equal(formatAmount(-12345n, 'SGD'), '-123.45');
  assert.equal(toDecimalString(12000000n), '120000.00');
  assert.equal(toDecimalString(-5n), '-0.05');
  assert.equal(toDecimalString(0n), '0.00');
  assert.deepEqual(Object.keys(CURRENCIES), ['MYR', 'SGD', 'USD']);
});
