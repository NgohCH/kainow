import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp } from '../bootstrap';
import { seedOrganisation } from '../testing/projects';
import { loadConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { CaptureSender, FakeClock, testEnv } from '../testing/fakes';
import { UsersService } from './users.service';

const EMAIL = 'admin@example.org';

describe('people over HTTP', { skip: SKIP_NO_DB }, () => {
  let app: INestApplication;
  let pool: Pool;
  let base: string;
  let cookie: string;
  let csrf: string;
  let adminId: string;
  let clock: FakeClock;

  async function api(method: string, path: string, body?: unknown, signedIn = true): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(signedIn ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  beforeEach(async () => {
    const sender = new CaptureSender();
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    const config = loadConfig(testEnv(testDatabaseUrl() as string));
    pool = new Pool({ connectionString: config.databaseUrl });
    await resetPublicSchema(pool);
    await runMigrations(pool, config.migrationsDir);
    await seedOrganisation(pool);
    adminId = (await new UsersService(pool, clock.now).create({ email: EMAIL, displayName: 'Admin' })).id;
    app = await createApp(config, { codeSender: sender, clock: clock.now, logger: false, extractionQueue: { enqueue: async () => undefined } });
    await app.listen(0);
    base = await app.getUrl();
    await api('POST', '/auth/request-code', { email: EMAIL }, false);
    const verify = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: sender.lastCode(EMAIL) }) });
    cookie = (verify.headers.getSetCookie()[0] ?? '').split(';')[0];
    csrf = ((await verify.json()) as { csrfToken: string }).csrfToken;
  });
  afterEach(async () => {
    await app?.close();
    await pool?.end();
  });

  test('listing people needs a signed-in administrator', async () => {
    assert.equal((await api('GET', '/users', undefined, false)).status, 401);
  });

  test('lists everyone with their status, oldest first', async () => {
    clock.advanceSeconds(1); // people added at the same instant would have no defined order
    await api('POST', '/users', { email: 'second@example.org', displayName: 'Second' });
    const { users } = (await api('GET', '/users')).body;
    assert.deepEqual(users.map((u: any) => [u.email, u.status, u.role]), [[EMAIL, 'active', 'enterprise_administrator'], ['second@example.org', 'active', 'enterprise_administrator']]);
  });

  test('a disabled person can be enabled again, which is audited, clears any lock and is safe to repeat', async () => {
    const second = (await api('POST', '/users', { email: 'back@example.org', displayName: 'Back' })).body.user;
    assert.equal((await api('POST', `/users/${second.id}/disable`)).status, 204);
    await pool.query(`UPDATE users SET locked_until = now() + interval '1 hour', failed_code_attempts = 5 WHERE id = $1`, [second.id]);
    clock.advanceSeconds(1);
    assert.equal((await api('POST', `/users/${second.id}/enable`)).status, 204);
    assert.equal((await api('POST', `/users/${second.id}/enable`)).status, 204, 'repeating is harmless');
    const row = (await pool.query('SELECT status, locked_until, failed_code_attempts FROM users WHERE id = $1', [second.id])).rows[0];
    assert.deepEqual([row.status, row.locked_until, row.failed_code_attempts], ['active', null, 0]);
    const audit = await pool.query(`SELECT actor_user_id FROM audit_events WHERE action = 'user.enabled' AND subject_id = $1`, [second.id]);
    assert.equal(audit.rowCount, 1, 'only the real change is audited');
    assert.equal(audit.rows[0].actor_user_id, adminId);
    assert.equal((await api('POST', '/users/not-a-uuid/enable')).status, 404);
    assert.equal((await api('POST', `/users/00000000-0000-4000-8000-000000000000/enable`)).status, 404);
  });

  test('a second administrator can be added and the first can then be disabled, but never the last', async () => {
    assert.equal((await api('POST', `/users/${adminId}/disable`)).status, 409, 'the only administrator cannot be disabled');
    const second = (await api('POST', '/users', { email: 'second@example.org', displayName: 'Second' })).body.user;
    assert.equal((await api('POST', `/users/${second.id}/disable`)).status, 204);
    assert.equal((await api('GET', '/users')).body.users.find((u: any) => u.id === second.id).status, 'disabled');
    assert.equal((await api('POST', `/users/${adminId}/disable`)).status, 409, 'now the last active one again');
  });
});
