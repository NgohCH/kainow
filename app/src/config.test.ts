import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_AUTH_SETTINGS, loadConfig, loadDatabaseConfig } from './config';
import { testEnv } from './testing/fakes';

const base = testEnv('postgres://x');

test('requires DATABASE_URL', () => {
  assert.throws(() => loadDatabaseConfig({}), /DATABASE_URL is not set/);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: undefined }), /DATABASE_URL is not set/);
});

test('the worker and migrations need only the database settings', () => {
  const config = loadDatabaseConfig({ DATABASE_URL: 'postgres://x' });
  assert.equal(config.databaseUrl, 'postgres://x');
});

test('defaults the port and keeps the accepted sign-in settings', () => {
  const config = loadConfig(base);
  assert.equal(config.port, 3000);
  assert.deepEqual(config.auth, {
    codeTtlMinutes: 10,
    maxCodeAttempts: 5,
    lockoutMinutes: 30,
    sessionHours: 12,
    codeResendSeconds: 60,
  });
  assert.deepEqual(config.auth, DEFAULT_AUTH_SETTINGS);
});

test('rejects a port that is not an integer from 1 to 65535', () => {
  for (const bad of ['abc', '0', '70000', '3000.5', '-1']) {
    assert.throws(() => loadConfig({ ...base, PORT: bad }), /PORT must be/);
  }
});

test('requires a long AUTH_SECRET', () => {
  assert.throws(() => loadConfig({ ...base, AUTH_SECRET: undefined }), /AUTH_SECRET/);
  assert.throws(() => loadConfig({ ...base, AUTH_SECRET: 'short' }), /AUTH_SECRET/);
});

test('refuses to start without a way to deliver sign-in codes', () => {
  assert.throws(() => loadConfig({ ...base, LOG_SIGN_IN_CODES: undefined }), /No way to deliver sign-in codes/);
  assert.throws(() => loadConfig({ ...base, LOG_SIGN_IN_CODES: 'yes' }), /No way to deliver sign-in codes/);
});

test('uses email when SMTP_URL is set, and then needs SMTP_FROM', () => {
  const env = { ...base, LOG_SIGN_IN_CODES: undefined, SMTP_URL: 'smtp://user:pw@mail.example.org:587' };
  assert.throws(() => loadConfig(env), /SMTP_FROM/);
  const config = loadConfig({ ...env, SMTP_FROM: 'Kainow <no-reply@example.org>' });
  assert.deepEqual(config.codeDelivery, {
    kind: 'smtp',
    url: 'smtp://user:pw@mail.example.org:587',
    from: 'Kainow <no-reply@example.org>',
  });
});

test('email wins over development logging when both are set', () => {
  const config = loadConfig({ ...base, SMTP_URL: 'smtp://mail.example.org', SMTP_FROM: 'a@example.org' });
  assert.equal(config.codeDelivery.kind, 'smtp');
});

test('cookies are Secure unless COOKIE_SECURE=false', () => {
  assert.equal(loadConfig({ ...base, COOKIE_SECURE: undefined }).cookieSecure, true);
  assert.equal(loadConfig({ ...base, COOKIE_SECURE: 'false' }).cookieSecure, false);
});

test('config objects do not share mutable auth settings', () => {
  const a = loadConfig(base);
  a.auth.sessionHours = 99;
  assert.equal(loadConfig(base).auth.sessionHours, 12);
});

test('a missing APP_URL in production is warned about', async () => {
  const { appUrlWarning } = await import('./config');
  const text = 'APP_URL is not set; invitation links will point to http://localhost:3000.';
  assert.equal(appUrlWarning({ NODE_ENV: 'production' }), text);
  assert.equal(appUrlWarning({ NODE_ENV: 'production', APP_URL: '' }), text);
  assert.equal(appUrlWarning({ NODE_ENV: 'production', APP_URL: 'https://kainow.example.org' }), null);
  assert.equal(appUrlWarning({ NODE_ENV: 'development' }), null);
});
