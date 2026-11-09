import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AppModule } from '../app.module';
import { loadConfig, type AppConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { seedOrganisation } from '../testing/projects';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { CaptureSender, FakeClock, differentCode, testEnv } from '../testing/fakes';
import { UsersService } from '../users/users.service';

const EMAIL = 'admin@example.org';

interface Reply {
  status: number;
  body: any;
  cookies: string[];
}

describe('sign-in over HTTP', { skip: SKIP_NO_DB }, () => {
  let app: INestApplication;
  let base: string;
  let sender: CaptureSender;
  let clock: FakeClock;

  async function start(patch: Partial<AppConfig> = {}): Promise<void> {
    const config = { ...loadConfig(testEnv(testDatabaseUrl() as string)), ...patch };
    const pool = new Pool({ connectionString: config.databaseUrl });
    await resetPublicSchema(pool);
    await runMigrations(pool, config.migrationsDir);
    await seedOrganisation(pool);
    await new UsersService(pool, clock.now).create({ email: EMAIL, displayName: 'Admin' });
    await pool.end();
    app = await NestFactory.create(AppModule.register(config, { codeSender: sender, clock: clock.now }), { logger: false });
    await app.listen(0);
    base = await app.getUrl();
  }

  let csrf = '';
  async function call(method: string, path: string, body?: unknown, cookie?: string): Promise<Reply> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(cookie && csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (path === '/auth/verify' && res.ok) csrf = (JSON.parse(text) as { csrfToken: string }).csrfToken;
    return { status: res.status, body: text ? JSON.parse(text) : undefined, cookies: res.headers.getSetCookie() };
  }

  async function signIn(): Promise<string> {
    await call('POST', '/auth/request-code', { email: EMAIL });
    const reply = await call('POST', '/auth/verify', { email: EMAIL, code: sender.lastCode(EMAIL) });
    assert.equal(reply.status, 200);
    return reply.cookies[0].split(';')[0];
  }

  beforeEach(() => {
    sender = new CaptureSender();
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
  });
  afterEach(async () => {
    await app?.close();
  });

  test('everything except health and the sign-in steps needs a session', async () => {
    await start();
    assert.equal((await call('GET', '/health')).status, 200);
    assert.equal((await call('GET', '/auth/me')).status, 401);
    assert.equal((await call('GET', '/auth/me', undefined, 'kainow_session=made-up')).status, 401);
    assert.equal((await call('POST', '/auth/logout')).status, 401);
    assert.equal((await call('POST', '/users', { email: 'x@example.org', displayName: 'X' })).status, 401);
    assert.equal((await call('POST', '/users/00000000-0000-7000-8000-000000000000/disable')).status, 401);
    assert.equal((await call('GET', '/no-such-route')).status, 404, 'an unknown route does not exist');
  });

  test('requesting a code gives the same reply for a known and an unknown address', async () => {
    await start();
    const known = await call('POST', '/auth/request-code', { email: EMAIL });
    const unknown = await call('POST', '/auth/request-code', { email: 'nobody@example.org' });
    assert.equal(known.status, 202);
    assert.deepEqual(known.body, { status: 'ok' });
    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.body, known.body);
    assert.equal(sender.sent.length, 1);
  });

  test('a wrong code and an unknown address fail identically', async () => {
    await start();
    await call('POST', '/auth/request-code', { email: EMAIL });
    const wrong = await call('POST', '/auth/verify', { email: EMAIL, code: differentCode(sender.lastCode(EMAIL)) });
    const unknown = await call('POST', '/auth/verify', { email: 'nobody@example.org', code: '123456' });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.cookies.length, 0);
  });

  test('sign in, use the session, manage users, and sign out', async () => {
    await start();
    await call('POST', '/auth/request-code', { email: EMAIL });
    const verify = await call('POST', '/auth/verify', { email: EMAIL, code: sender.lastCode(EMAIL) });
    assert.equal(verify.status, 200);
    assert.deepEqual(Object.keys(verify.body), ['user', 'csrfToken']);
    assert.match(verify.body.csrfToken, /^[0-9a-f]{64}$/);
    assert.equal(verify.body.user.email, EMAIL);

    const setCookie = verify.cookies[0];
    assert.match(setCookie, /^kainow_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200$/);
    const cookie = setCookie.split(';')[0];

    const me = await call('GET', '/auth/me', undefined, cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'enterprise_administrator');

    const created = await call('POST', '/users', { email: 'Second@Example.org', displayName: 'Second' }, cookie);
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, 'second@example.org');
    assert.equal((await call('POST', '/users', { email: 'second@example.org', displayName: 'Again' }, cookie)).status, 409);

    assert.equal((await call('POST', `/users/${created.body.user.id}/disable`, undefined, cookie)).status, 204);
    assert.equal((await call('POST', `/users/${me.body.user.id}/disable`, undefined, cookie)).status, 409, 'last administrator');
    assert.equal((await call('POST', '/users/not-a-uuid/disable', undefined, cookie)).status, 404);

    const logout = await call('POST', '/auth/logout', undefined, cookie);
    assert.equal(logout.status, 204);
    assert.match(logout.cookies[0], /Max-Age=0/);
    assert.equal((await call('GET', '/auth/me', undefined, cookie)).status, 401, 'the old cookie no longer works');
  });

  test('bad input is a 400, not a server error', async () => {
    await start();
    const cookie = await signIn();
    assert.equal((await call('POST', '/auth/request-code', {})).status, 400);
    assert.equal((await call('POST', '/auth/request-code', { email: 42 })).status, 400);
    assert.equal((await call('POST', '/auth/verify', { email: EMAIL })).status, 400);
    assert.equal((await call('POST', '/users', { email: 'bad', displayName: 'X' }, cookie)).status, 400);
    assert.equal((await call('POST', '/users', { email: 'ok@example.org' }, cookie)).status, 400);
  });

  test('anti-forgery: a change without the right token is refused, reading is not', async () => {
    await start();
    const cookie = await signIn();
    const good = csrf;
    const post = (token?: string) =>
      fetch(`${base}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(token ? { 'X-CSRF-Token': token } : {}) },
        body: JSON.stringify({ email: 'forged@example.org', displayName: 'Forged' }),
      });
    assert.equal((await post()).status, 403, 'no token');
    assert.equal((await post('0'.repeat(64))).status, 403, 'wrong token');
    assert.equal((await post(good.slice(1))).status, 403, 'truncated token');
    assert.equal((await post(good)).status, 201, 'right token');
    assert.equal((await call('GET', '/auth/me', undefined, cookie)).body.csrfToken, good, 'me gives the same token');
    assert.equal((await fetch(`${base}/users`, { headers: { Cookie: cookie } })).status, 200, 'reading needs no token');
    const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logout.status, 403, 'signing out is a change too');
  });

  test('the session cookie is marked Secure when configured', async () => {
    await start({ cookieSecure: true });
    await call('POST', '/auth/request-code', { email: EMAIL });
    const verify = await call('POST', '/auth/verify', { email: EMAIL, code: sender.lastCode(EMAIL) });
    assert.match(verify.cookies[0], /; Secure$/);
  });

  test('the session stops working after 12 hours', async () => {
    await start();
    const cookie = await signIn();
    clock.advanceMinutes(12 * 60 - 1);
    assert.equal((await call('GET', '/auth/me', undefined, cookie)).status, 200);
    clock.advanceMinutes(2);
    assert.equal((await call('GET', '/auth/me', undefined, cookie)).status, 401);
  });
});
