import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_AUTH_SETTINGS, loadConfig, loadDatabaseConfig, loadWorkerConfig } from './config';
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
  assert.deepEqual(config.email, {
    provider: 'smtp',
    url: 'smtp://user:pw@mail.example.org:587',
    from: 'Kainow <no-reply@example.org>',
  });
});

test('email wins over development logging when both are set', () => {
  const config = loadConfig({ ...base, SMTP_URL: 'smtp://mail.example.org', SMTP_FROM: 'a@example.org' });
  assert.equal(config.email.provider, 'smtp');
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

const noEmail = { ...base, LOG_SIGN_IN_CODES: undefined };
const m365Env = {
  ...noEmail,
  EMAIL_PROVIDER: 'm365',
  M365_TENANT_ID: 'tenant-1',
  M365_CLIENT_ID: 'client-1',
  M365_CLIENT_SECRET: 'secret-value-xyz',
  EMAIL_FROM: 'kainow@example.org',
};

test('EMAIL_PROVIDER unset keeps the old behaviour: log with LOG_SIGN_IN_CODES=true', () => {
  assert.deepEqual(loadConfig(base).email, { provider: 'log' });
  assert.deepEqual(loadWorkerConfig({ ...base }).email, { provider: 'log' });
});

test('EMAIL_PROVIDER=smtp uses SMTP_URL and EMAIL_FROM, falling back to SMTP_FROM', () => {
  const env = { ...noEmail, EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://u:p@mail.example.org:587' };
  assert.throws(() => loadConfig(env), /EMAIL_FROM/);
  assert.deepEqual(loadConfig({ ...env, EMAIL_FROM: 'kainow@example.org' }).email, { provider: 'smtp', url: 'smtp://u:p@mail.example.org:587', from: 'kainow@example.org' });
  assert.deepEqual(loadConfig({ ...env, SMTP_FROM: 'old@example.org' }).email, { provider: 'smtp', url: 'smtp://u:p@mail.example.org:587', from: 'old@example.org' });
  assert.throws(() => loadConfig({ ...env, SMTP_URL: undefined, EMAIL_FROM: 'a@example.org' }), /SMTP_URL/);
});

test('EMAIL_PROVIDER=m365 needs tenant, client, secret and sender, and names the missing variable', () => {
  const config = loadConfig(m365Env);
  assert.deepEqual(config.email, { provider: 'm365', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-value-xyz', from: 'kainow@example.org' });
  assert.deepEqual(loadWorkerConfig(m365Env).email, config.email);
  for (const name of ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'EMAIL_FROM']) {
    assert.throws(
      () => loadConfig({ ...m365Env, [name]: undefined }),
      (err: Error) => err.message.includes(name) && !err.message.includes('secret-value-xyz'),
    );
  }
});

test('an unknown EMAIL_PROVIDER is refused without echoing it', () => {
  assert.throws(
    () => loadConfig({ ...noEmail, EMAIL_PROVIDER: 'carrier-pigeon' }),
    (err: Error) => /EMAIL_PROVIDER/.test(err.message) && !err.message.includes('carrier-pigeon'),
  );
});

test('with no email settings and no development logging, the worker refuses to start too', () => {
  assert.throws(() => loadWorkerConfig(noEmail), /No way to deliver/);
});

test('the worker reads APP_URL with the same default and trimming as the API', () => {
  assert.equal(loadWorkerConfig(base).appUrl, 'http://localhost:3000');
  assert.equal(loadWorkerConfig({ ...base, APP_URL: 'https://kainow.example.org//' }).appUrl, 'https://kainow.example.org');
  assert.equal(loadWorkerConfig({ ...base, APP_URL: 'https://kainow.example.org' }).appUrl, loadConfig({ ...base, APP_URL: 'https://kainow.example.org' }).appUrl);
});

test('the protected key file path is optional and trimmed, for the API and the worker', () => {
  assert.equal(loadConfig(base).protectedKeyFile, null);
  assert.equal(loadWorkerConfig(base).protectedKeyFile, null);
  assert.equal(loadConfig({ ...base, KAINOW_PROTECTED_KEY_FILE: '  ' }).protectedKeyFile, null);
  assert.equal(loadConfig({ ...base, KAINOW_PROTECTED_KEY_FILE: ' /run/keys/p.key ' }).protectedKeyFile, '/run/keys/p.key');
  assert.equal(loadWorkerConfig({ ...base, KAINOW_PROTECTED_KEY_FILE: '/run/keys/p.key' }).protectedKeyFile, '/run/keys/p.key');
});

// G02: sign-in codes must never be printed to the log of a production server that other people reach.
test('in production, codes are logged only for a server reached at a localhost address', () => {
  const prod = { ...base, NODE_ENV: 'production' };
  for (const appUrl of [undefined, 'http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000']) {
    assert.deepEqual(loadConfig({ ...prod, APP_URL: appUrl }).email, { provider: 'log' }, String(appUrl));
    assert.deepEqual(loadWorkerConfig({ ...prod, APP_URL: appUrl }).email, { provider: 'log' }, String(appUrl));
  }
  for (const appUrl of ['https://kainow.example.org', 'http://10.0.0.5:3000', 'http://localhost.example.org']) {
    assert.throws(() => loadConfig({ ...prod, APP_URL: appUrl }), /LOG_SIGN_IN_CODES/, appUrl);
    assert.throws(() => loadWorkerConfig({ ...prod, APP_URL: appUrl }), /LOG_SIGN_IN_CODES/, appUrl);
    assert.throws(() => loadConfig({ ...prod, APP_URL: appUrl, LOG_SIGN_IN_CODES: undefined, EMAIL_PROVIDER: 'log' }), /LOG_SIGN_IN_CODES|log/, appUrl);
  }
  // Outside production (development and tests) the log provider stays available at any address.
  assert.deepEqual(loadConfig({ ...base, APP_URL: 'https://kainow.example.org' }).email, { provider: 'log' });
  // A real email provider is unaffected.
  assert.equal(loadConfig({ ...prod, APP_URL: 'https://kainow.example.org', SMTP_URL: 'smtp://mail.example.org', SMTP_FROM: 'a@example.org' }).email.provider, 'smtp');
});

// G05: an AI-enabled production deployment can require the protected key, and then refuses to start without it.
test('KAINOW_REQUIRE_PROTECTED_KEY=true refuses to start without a protected key file', () => {
  const req = { ...base, KAINOW_REQUIRE_PROTECTED_KEY: 'true' };
  assert.throws(() => loadConfig(req), /KAINOW_PROTECTED_KEY_FILE/);
  assert.throws(() => loadWorkerConfig(req), /KAINOW_PROTECTED_KEY_FILE/);
  assert.equal(loadConfig({ ...req, KAINOW_PROTECTED_KEY_FILE: '/run/keys/p.key' }).requireProtectedKey, true);
  assert.equal(loadWorkerConfig({ ...req, KAINOW_PROTECTED_KEY_FILE: '/run/keys/p.key' }).requireProtectedKey, true);
  assert.equal(loadConfig(base).requireProtectedKey, false);
  assert.throws(() => loadConfig({ ...base, KAINOW_REQUIRE_PROTECTED_KEY: 'yes' }), /KAINOW_REQUIRE_PROTECTED_KEY/);
});

test('TRUST_PROXY is a small count of proxies and defaults to none', () => {
  assert.equal(loadConfig(base).trustProxyHops, 0);
  assert.equal(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxyHops, 1);
  for (const bad of ['-1', 'true', '1.5', '11']) assert.throws(() => loadConfig({ ...base, TRUST_PROXY: bad }), /TRUST_PROXY/, bad);
});
