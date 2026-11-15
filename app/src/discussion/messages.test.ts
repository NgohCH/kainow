import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { cleanBody, displayBody, refuseSecrets, replyQuote } from './messages';

test('cleanBody refuses empty and 10,001 characters', () => {
  assert.throws(() => cleanBody(''), BadRequestException);
  assert.throws(() => cleanBody('  \n '), BadRequestException);
  assert.throws(() => cleanBody(42), BadRequestException);
  assert.equal(cleanBody('a'.repeat(10_000)).length, 10_000);
  assert.throws(() => cleanBody('a'.repeat(10_001)), /longer than 10,000/);
});

test('cleanBody normalises line ends', () => {
  assert.equal(cleanBody('one\r\ntwo'), 'one\ntwo');
});

test('refuseSecrets names the kind and never the secret', () => {
  const key = `sk-${'a1B2c3D4e5'.repeat(3)}`;
  assert.doesNotThrow(() => refuseSecrets('Nothing secret here.'));
  assert.throws(
    () => refuseSecrets(`Use ${key} for it`),
    (err: Error) => err.message === 'Not posted: this looks like it contains API secret key (sk-). Remove it and post again.' && !err.message.includes(key),
  );
});

test('replyQuote cuts at a word with an ellipsis', () => {
  assert.equal(replyQuote('Short note'), 'Short note');
  const long = `${'word '.repeat(40)}end`;
  const q = replyQuote(long);
  assert.ok(q.endsWith('…'));
  assert.ok(q.length <= 141);
  assert.ok(!q.slice(0, -1).endsWith(' '));
  assert.equal(replyQuote('x'.repeat(200)), `${'x'.repeat(140)}…`);
});

test('displayBody hides text from others but not the author', () => {
  const hidden = { state: 'hidden' as const, body: 'secret plan', stateBy: 'Pat PM', stateReason: 'off topic' };
  assert.deepEqual(displayBody(hidden, false), { text: null, notice: 'Hidden by Pat PM: off topic' });
  assert.deepEqual(displayBody(hidden, true), { text: 'secret plan', notice: 'Hidden by Pat PM: off topic' });
  const deleted = { state: 'deleted' as const, body: 'gone', stateBy: 'Pat PM', stateReason: 'duplicate' };
  assert.deepEqual(displayBody(deleted, true), { text: null, notice: 'Deleted by Pat PM: duplicate' });
  assert.deepEqual(displayBody({ state: 'visible', body: 'hi', stateBy: null, stateReason: null }, false), { text: 'hi', notice: null });
});
