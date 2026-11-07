import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_AUTH_SETTINGS, loadConfig } from './config';

test('requires DATABASE_URL', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is not set/);
});

test('defaults the port and keeps the accepted sign-in settings', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://x' });
  assert.equal(config.port, 3000);
  assert.deepEqual(config.auth, { codeTtlMinutes: 10, maxCodeAttempts: 5, lockoutMinutes: 30, sessionHours: 12 });
  assert.deepEqual(config.auth, DEFAULT_AUTH_SETTINGS);
});

test('rejects a port that is not an integer from 1 to 65535', () => {
  for (const bad of ['abc', '0', '70000', '3000.5', '-1']) {
    assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: bad }), /PORT must be/);
  }
});

test('config objects do not share mutable auth settings', () => {
  const a = loadConfig({ DATABASE_URL: 'postgres://x' });
  a.auth.sessionHours = 99;
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://x' }).auth.sessionHours, 12);
});
