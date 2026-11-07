import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { UsersService } from '../users/users.service';
import { MVP_SPEND_SETTINGS } from './mvp-settings';
import { SpendService } from './spend.service';
import { SpendSettingsService, describeSettings, parseSettingsBody } from './spend.settings';

const MYR = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

describe('per-person monthly limit', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let clock: FakeClock;
  let spend: SpendService;
  let settings: SpendSettingsService;
  let ann: string;
  let bob: string;
  const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    spend = new SpendService(pool, clock.now);
    settings = new SpendSettingsService(pool, clock.now);
    const users = new UsersService(pool, clock.now);
    ann = (await users.create({ email: 'ann@example.org', displayName: 'Ann' })).id;
    bob = (await users.create({ email: 'bob@example.org', displayName: 'Bob' })).id;
  });

  const ask = (actor: string | null, estimate: number) =>
    spend.reserve({ requestId: uuidv7(), attemptNo: 1, estimateMicroMyr: MYR(estimate), purpose: 'extraction', actorUserId: actor });

  test('with no per-person limit (the default) nobody is limited beyond the organisation', async () => {
    await settings.apply(MVP_SPEND_SETTINGS, ann);
    assert.equal((await settings.get())?.userMonthly.mode, 'not_applied');
    assert.equal((await ask(ann, 15)).status, 'reserved');
    assert.equal((await ask(bob, 5)).status, 'reserved');
  });

  test('a person is stopped at their own limit while someone else is not', async () => {
    await settings.apply({ ...MVP_SPEND_SETTINGS, userMonthly: { mode: 'limit', limitMicroMyr: MYR(5) } }, ann);
    assert.equal((await ask(ann, 3)).status, 'reserved');
    const over = await ask(ann, 2.5);
    assert.deepEqual([over.status, (over as any).reason, (over as any).scope], ['blocked', 'cap_would_be_exceeded', 'user_monthly']);
    assert.equal((over as any).remainingMicroMyr, MYR(2));
    assert.equal((await ask(ann, 2)).status, 'reserved', 'an estimate equal to what is left is allowed');
    assert.equal((await ask(bob, 5)).status, 'reserved', 'another person has their own allowance');
  });

  test('a blank or zero personal limit means no allowance for anyone, never unlimited', async () => {
    for (const limitMicroMyr of [null, 0n]) {
      await settings.apply({ ...MVP_SPEND_SETTINGS, userMonthly: { mode: 'limit', limitMicroMyr } }, ann);
      const r = await ask(ann, 0.1);
      assert.deepEqual([r.status, (r as any).reason, (r as any).scope], ['blocked', 'no_allowance', 'user_monthly']);
    }
  });

  test('the most restrictive limit applies: the organisation cap still blocks a person with room left', async () => {
    await settings.apply({ ...MVP_SPEND_SETTINGS, monthlyLimitMicroMyr: MYR(4), userMonthly: { mode: 'limit', limitMicroMyr: MYR(10) } }, ann);
    const r = await ask(ann, 5);
    assert.deepEqual([r.status, (r as any).scope], ['blocked', 'monthly']);
  });

  test('requests that belong to no person are not subject to the personal limit', async () => {
    await settings.apply({ ...MVP_SPEND_SETTINGS, userMonthly: { mode: 'limit', limitMicroMyr: 0n } }, ann);
    assert.equal((await ask(null, 1)).status, 'reserved');
  });

  test('uncertain and reserved amounts count towards the person, released ones do not', async () => {
    await settings.apply({ ...MVP_SPEND_SETTINGS, userMonthly: { mode: 'limit', limitMicroMyr: MYR(5) } }, ann);
    const first = await ask(ann, 3);
    assert.equal(first.status, 'reserved');
    assert.equal((await ask(ann, 3)).status, 'blocked', 'the held reservation counts');
    await spend.releaseUnsent((first as any).entryId);
    assert.equal((await ask(ann, 3)).status, 'reserved', 'a released reservation does not');
  });

  test('the personal limit starts again on the 1st at midnight UTC+8', async () => {
    await settings.apply({ ...MVP_SPEND_SETTINGS, userMonthly: { mode: 'limit', limitMicroMyr: MYR(5) } }, ann);
    const e = await ask(ann, 5);
    await spend.settle((e as any).entryId, { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }); // MYR 8.20, over the 5 but recorded in full
    assert.equal((await ask(ann, 1)).status, 'blocked');
    clock.ms = Date.UTC(2026, 10, 30, 16, 0, 0); // 1 December 00:00 in UTC+8
    assert.equal((await ask(ann, 1)).status, 'reserved');
  });

  test('the caller sees their own figures only when a personal limit applies', async () => {
    await settings.apply(MVP_SPEND_SETTINGS, ann);
    assert.equal((await spend.summary(ann)).mine, null);
    await settings.apply({ ...MVP_SPEND_SETTINGS, userMonthly: { mode: 'limit', limitMicroMyr: MYR(5) } }, ann);
    await ask(ann, 2);
    const mine = (await spend.summary(ann)).mine;
    assert.equal(mine?.usedMicroMyr, MYR(2));
    assert.equal(mine?.remainingMicroMyr, MYR(3));
    assert.equal((await spend.summary(bob)).mine?.usedMicroMyr, 0n);
  });

  test('saving the setting is audited, and leaving it out of a request means no personal limit', async () => {
    const body = { modelId: 'm', inputUsdPerMillion: '1', cachedInputUsdPerMillion: '1', outputUsdPerMillion: '1', myrPerUsd: 4, monthlyLimitMyr: 20, daily: { mode: 'not_applied' } };
    assert.deepEqual(parseSettingsBody(body).userMonthly, { mode: 'not_applied' });
    const withLimit = parseSettingsBody({ ...body, userMonthly: { mode: 'limit', limitMyr: '2.5' } });
    assert.deepEqual(describeSettings(withLimit).userMonthly, { mode: 'limit', limitMyr: '2.500000' });
    await settings.apply(withLimit, ann);
    const { rows } = await pool.query("SELECT detail FROM audit_events WHERE action = 'ai.spend_settings_changed'");
    assert.deepEqual(rows[0].detail.settings.userMonthly, { mode: 'limit', limitMyr: '2.500000' });
  });

  test('a malformed personal limit is refused', () => {
    const body = { modelId: 'm', inputUsdPerMillion: '1', cachedInputUsdPerMillion: '1', outputUsdPerMillion: '1', myrPerUsd: 4, monthlyLimitMyr: 20, daily: { mode: 'not_applied' } };
    for (const userMonthly of [null, 'x', [], {}, { mode: 'unlimited' }, { mode: 'limit' }, { mode: 'not_applied', limitMyr: 1 }, { mode: 'limit', limitMyr: '-1' }]) {
      assert.throws(() => parseSettingsBody({ ...body, userMonthly }), /userMonthly|limitMyr/, JSON.stringify(userMonthly));
    }
  });
});
