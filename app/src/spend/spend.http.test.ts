import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AppModule } from '../app.module';
import { loadConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { CaptureSender, FakeClock, testEnv } from '../testing/fakes';
import { UsersService } from '../users/users.service';

const EMAIL = 'admin@example.org';

const MVP_BODY = {
  modelId: 'gpt-6.1-sol',
  inputUsdPerMillion: '2.00',
  cachedInputUsdPerMillion: '0.10',
  outputUsdPerMillion: '10.00',
  myrPerUsd: 4.1,
  monthlyLimitMyr: 20,
  daily: { mode: 'not_applied' },
};

describe('spend settings over HTTP', { skip: SKIP_NO_DB }, () => {
  let app: INestApplication;
  let base: string;
  let cookie: string;

  beforeEach(async () => {
    const sender = new CaptureSender();
    const clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    const config = loadConfig(testEnv(testDatabaseUrl() as string));
    const pool = new Pool({ connectionString: config.databaseUrl });
    await resetPublicSchema(pool);
    await runMigrations(pool, config.migrationsDir);
    await new UsersService(pool, clock.now).create({ email: EMAIL, displayName: 'Admin' });
    await pool.end();
    app = await NestFactory.create(AppModule.register(config, { codeSender: sender, clock: clock.now }), { logger: false });
    await app.listen(0);
    base = await app.getUrl();
    await call('POST', '/auth/request-code', { email: EMAIL }, false);
    const verify = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, code: sender.lastCode(EMAIL) }),
    });
    cookie = (verify.headers.getSetCookie()[0] ?? '').split(';')[0];
  });
  afterEach(async () => {
    await app?.close();
  });

  async function call(method: string, path: string, body?: unknown, signedIn = true): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(signedIn && cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  test('both endpoints need a signed-in administrator', async () => {
    assert.equal((await call('GET', '/ai/spend', undefined, false)).status, 401);
    assert.equal((await call('PUT', '/ai/spend-settings', MVP_BODY, false)).status, 401);
  });

  test('before approval it reports that nothing is configured', async () => {
    const view = await call('GET', '/ai/spend');
    assert.equal(view.status, 200);
    assert.deepEqual(view.body, { configured: false, settings: null, month: null, day: null });
  });

  test('saves the approved MVP settings and shows the allowance', async () => {
    const saved = await call('PUT', '/ai/spend-settings', MVP_BODY);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.myrPerUsd, '4.100000');

    const view = (await call('GET', '/ai/spend')).body;
    assert.equal(view.configured, true);
    assert.equal(view.settings.modelId, 'gpt-6.1-sol');
    assert.equal(view.settings.inputUsdPerMillion, '2.000000');
    assert.equal(view.settings.cachedInputUsdPerMillion, '0.100000');
    assert.equal(view.settings.outputUsdPerMillion, '10.000000');
    assert.deepEqual(view.settings.daily, { mode: 'not_applied' });
    assert.equal(view.month.limitMyr, '20.000000');
    assert.equal(view.month.usedMyr, '0.000000');
    assert.equal(view.month.remainingMyr, '20.000000');
    assert.equal(view.month.start, '2026-10-31T16:00:00.000Z');
    assert.equal(view.month.end, '2026-11-30T16:00:00.000Z');
    assert.equal(view.day, null);
  });

  test('a blank monthly limit is saved as zero allowance, not as unlimited', async () => {
    assert.equal((await call('PUT', '/ai/spend-settings', { ...MVP_BODY, monthlyLimitMyr: null })).status, 200);
    const view = (await call('GET', '/ai/spend')).body;
    assert.equal(view.month.limitMyr, null);
    assert.equal(view.month.remainingMyr, '0.000000');
  });

  test('a daily limit shows daily figures', async () => {
    await call('PUT', '/ai/spend-settings', { ...MVP_BODY, daily: { mode: 'limit', limitMyr: '0.5' } });
    const view = (await call('GET', '/ai/spend')).body;
    assert.equal(view.day.limitMyr, '0.500000');
    assert.equal(view.day.start, '2026-11-08T16:00:00.000Z');
  });

  test('nothing is defaulted: a missing or malformed field is a 400 and saves nothing', async () => {
    const { monthlyLimitMyr: _m, ...withoutMonthly } = MVP_BODY;
    const { daily: _d, ...withoutDaily } = MVP_BODY;
    const bad: unknown[] = [
      {},
      [],
      'text',
      withoutMonthly,
      withoutDaily,
      { ...MVP_BODY, modelId: '' },
      { ...MVP_BODY, modelId: 5 },
      { ...MVP_BODY, myrPerUsd: 0 },
      { ...MVP_BODY, myrPerUsd: '-4.1' },
      { ...MVP_BODY, inputUsdPerMillion: '1e1' },
      { ...MVP_BODY, outputUsdPerMillion: undefined },
      { ...MVP_BODY, monthlyLimitMyr: '20.1234567' },
      { ...MVP_BODY, daily: { mode: 'unlimited' } },
      { ...MVP_BODY, daily: { mode: 'limit' } },
      { ...MVP_BODY, daily: { mode: 'not_applied', limitMyr: 5 } },
      { ...MVP_BODY, daily: 'not_applied' },
    ];
    for (const body of bad) {
      assert.equal((await call('PUT', '/ai/spend-settings', body)).status, 400, `should reject ${JSON.stringify(body)}`);
    }
    assert.equal((await call('GET', '/ai/spend')).body.configured, false);
  });
});
