import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearedCookie, readCookie, sessionCookie } from './cookies';

test('reads the named cookie from several', () => {
  assert.equal(readCookie('a=1; kainow_session=abc; b=2', 'kainow_session'), 'abc');
  assert.equal(readCookie(['a=1', 'kainow_session=abc'], 'kainow_session'), 'abc');
});

test('returns undefined when the cookie is missing, empty or malformed', () => {
  assert.equal(readCookie(undefined, 'kainow_session'), undefined);
  assert.equal(readCookie('', 'kainow_session'), undefined);
  assert.equal(readCookie('other=1', 'kainow_session'), undefined);
  assert.equal(readCookie('kainow_session=%E0%A4%A', 'kainow_session'), undefined);
  assert.equal(readCookie('xkainow_session=abc', 'kainow_session'), undefined);
});

test('session cookie is HttpOnly, SameSite=Lax and expires with the session', () => {
  const cookie = sessionCookie('kainow_session', 'tok', 43200, false);
  assert.match(cookie, /^kainow_session=tok; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200$/);
  assert.match(sessionCookie('kainow_session', 'tok', 43200, true), /; Secure$/);
});

test('clearing a cookie sets it to expire at once', () => {
  assert.match(clearedCookie('kainow_session', false), /^kainow_session=; .*Max-Age=0$/);
  assert.match(clearedCookie('kainow_session', true), /; Secure$/);
});
