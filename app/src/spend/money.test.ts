import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { ceilDiv, formatMicro, parseMicro } from './money';

test('parses decimals exactly into micro-units', () => {
  assert.equal(parseMicro('4.1', 'x'), 4_100_000n);
  assert.equal(parseMicro('20', 'x'), 20_000_000n);
  assert.equal(parseMicro('0.000001', 'x'), 1n);
  assert.equal(parseMicro('0', 'x'), 0n);
  assert.equal(parseMicro('  2.00 ', 'x'), 2_000_000n);
  assert.equal(parseMicro('0.10', 'x'), 100_000n);
  assert.equal(parseMicro('999999999999.999999', 'x'), 999_999_999_999_999_999n);
});

test('accepts a JSON number without letting floating point change the value', () => {
  assert.equal(parseMicro(4.1, 'x'), 4_100_000n);
  assert.equal(parseMicro(0.1, 'x'), 100_000n);
  assert.equal(parseMicro(20, 'x'), 20_000_000n);
});

test('rejects anything that is not a plain, non-negative decimal', () => {
  for (const bad of ['-1', '+1', '1e3', '1.1234567', '', ' ', 'abc', '1,5', '1.', '.5', '1234567890123', '0x10']) {
    assert.throws(() => parseMicro(bad, 'amount'), BadRequestException, `should reject ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, undefined, NaN, Infinity, -1, 1e-7, true, {}, []]) {
    assert.throws(() => parseMicro(bad, 'amount'), BadRequestException, `should reject ${String(bad)}`);
  }
});

test('the error names the field', () => {
  assert.throws(() => parseMicro('x', 'myrPerUsd'), /myrPerUsd/);
});

test('formats micro-units as a fixed six-decimal string', () => {
  assert.equal(formatMicro(20_000_000n), '20.000000');
  assert.equal(formatMicro(1n), '0.000001');
  assert.equal(formatMicro(0n), '0.000000');
  assert.equal(formatMicro(164_000n), '0.164000');
  assert.equal(formatMicro(-1_500_000n), '-1.500000');
});

test('format and parse are inverses', () => {
  for (const value of ['0.000000', '4.100000', '20.000000', '123456.654321']) {
    assert.equal(formatMicro(parseMicro(value, 'x')), value);
  }
});

test('divides rounding up', () => {
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.equal(ceilDiv(8n, 2n), 4n);
  assert.equal(ceilDiv(0n, 5n), 0n);
  assert.equal(ceilDiv(1n, 1_000_000n), 1n);
});
