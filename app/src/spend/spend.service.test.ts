import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { UsersService } from '../users/users.service';
import { parseMicro } from './money';
import { MVP_SPEND_SETTINGS } from './mvp-settings';
import { SpendService, SpendStateError, type ReserveResult } from './spend.service';
import { SpendSettingsService, type SpendSettingsInput } from './spend.settings';

const myr = (value: string): bigint => parseMicro(value, 'test');
/** What the Product Owner's example extraction costs: 10,000 input and 2,000 output tokens. */
const EXAMPLE_USAGE = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 };
const EXAMPLE_COST = 164_000n;

describe('AI spend cap', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let clock: FakeClock;
  let spend: SpendService;
  let settings: SpendSettingsService;
  let actorId: string;
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
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0)); // 10:00 on 9 November in UTC+8
    spend = new SpendService(pool, clock.now);
    settings = new SpendSettingsService(pool, clock.now);
    actorId = (await new UsersService(pool, clock.now).create({ email: 'admin@example.org', displayName: 'Admin' })).id;
  });

  /** Approves the Product Owner's settings with any changes for the test. */
  const configure = (patch: Partial<SpendSettingsInput> = {}): Promise<void> =>
    settings.apply({ ...MVP_SPEND_SETTINGS, ...patch }, actorId);

  let attempt = 0;
  const reserve = (estimate: bigint, requestId: string = uuidv7()): Promise<ReserveResult> =>
    spend.reserve({ requestId, attemptNo: ++attempt, estimateMicroMyr: estimate, purpose: 'extraction', actorUserId: actorId });

  const reserved = async (estimate: bigint): Promise<string> => {
    const result = await reserve(estimate);
    assert.equal(result.status, 'reserved', 'expected the reservation to be allowed');
    return (result as Extract<ReserveResult, { status: 'reserved' }>).entryId;
  };

  test('everything is blocked until an administrator approves settings', async () => {
    const result = await reserve(1n);
    assert.deepEqual(result, { status: 'blocked', reason: 'not_configured', scope: undefined, remainingMicroMyr: undefined });
    assert.equal((await spend.summary()).configured, false);
    const audit = await pool.query(`SELECT detail FROM audit_events WHERE action = 'ai.request_blocked'`);
    assert.equal(audit.rows[0].detail.reason, 'not_configured');
  });

  test('a blank monthly limit and an explicit zero both allow nothing', async () => {
    for (const limit of [null, 0n]) {
      await configure({ monthlyLimitMicroMyr: limit });
      const result = await reserve(1n);
      assert.equal(result.status, 'blocked');
      assert.equal((result as { reason: string }).reason, 'no_allowance');
      assert.equal((result as { scope: string }).scope, 'monthly');
    }
  });

  test('"no daily cap" is allowed only as an explicit setting, and a blank daily limit allows nothing', async () => {
    await configure({ daily: { mode: 'not_applied' } });
    await reserved(myr('1'));

    for (const limit of [null, 0n]) {
      await configure({ daily: { mode: 'limit', limitMicroMyr: limit } });
      const result = await reserve(1n);
      assert.equal(result.status, 'blocked');
      assert.equal((result as { reason: string }).reason, 'no_allowance');
      assert.equal((result as { scope: string }).scope, 'daily');
    }
  });

  test('allows a reservation up to exactly the cap and refuses one micro-unit more', async () => {
    await configure({ monthlyLimitMicroMyr: myr('1') });
    await reserved(999_999n);
    await reserved(1n);
    const over = await reserve(1n);
    assert.equal(over.status, 'blocked');
    assert.equal((over as { reason: string }).reason, 'cap_would_be_exceeded');
    assert.equal((over as { remainingMicroMyr: bigint }).remainingMicroMyr, 0n);
  });

  test('refuses a single reservation larger than what is left and says how much is left', async () => {
    await configure({ monthlyLimitMicroMyr: myr('1') });
    await reserved(700_000n);
    const result = await reserve(400_000n);
    assert.equal(result.status, 'blocked');
    assert.equal((result as { remainingMicroMyr: bigint }).remainingMicroMyr, 300_000n);
  });

  test('settling replaces the estimate with the real cost and frees headroom', async () => {
    await configure({ monthlyLimitMicroMyr: myr('1') });
    const id = await reserved(600_000n);
    assert.equal((await reserve(600_000n)).status, 'blocked');

    await spend.settle(id, EXAMPLE_USAGE);
    const entry = await spend.getEntry(id);
    assert.equal(entry?.status, 'confirmed');
    assert.equal(entry?.amountMicroMyr, EXAMPLE_COST);
    assert.equal((await spend.summary()).monthly?.usedMicroMyr, EXAMPLE_COST);

    await reserved(800_000n); // 164,000 + 800,000 fits within 1,000,000
  });

  test('settling twice counts the cost once', async () => {
    await configure();
    const id = await reserved(500_000n);
    await spend.settle(id, EXAMPLE_USAGE);
    await spend.settle(id, EXAMPLE_USAGE);
    await spend.settle(id, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 });
    assert.equal((await spend.summary()).monthly?.usedMicroMyr, EXAMPLE_COST);
  });

  test('settling uses the prices in force when the request was reserved', async () => {
    await configure();
    const id = await reserved(500_000n);
    await configure({
      prices: { ...MVP_SPEND_SETTINGS.prices, inputMicroUsdPerMillion: 20_000_000n, outputMicroUsdPerMillion: 100_000_000n, myrPerUsdMicro: 9_000_000n },
    });
    await spend.settle(id, EXAMPLE_USAGE);
    assert.equal((await spend.getEntry(id))?.amountMicroMyr, EXAMPLE_COST);
  });

  test('a real cost above the estimate is recorded in full and flagged', async () => {
    await configure();
    const id = await reserved(100_000n);
    await spend.settle(id, EXAMPLE_USAGE);
    const entry = await spend.getEntry(id);
    assert.equal(entry?.amountMicroMyr, EXAMPLE_COST);
    assert.equal(entry?.exceededEstimate, true);
  });

  test('requests made at the same moment cannot spend more than the cap', async () => {
    await configure({ monthlyLimitMicroMyr: myr('1') });
    const results = await Promise.all(Array.from({ length: 12 }, () => reserve(300_000n)));
    const allowed = results.filter((r) => r.status === 'reserved').length;
    assert.equal(allowed, 3, 'only three reservations of 0.30 fit in 1.00');
    assert.equal((await spend.summary()).monthly?.usedMicroMyr, 900_000n);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM ai_spend_entries`);
    assert.equal(rows.rows[0].n, 3);
  });

  test('an unknown outcome keeps the full estimate counted until it is reconciled', async () => {
    await configure({ monthlyLimitMicroMyr: myr('1') });
    const id = await reserved(400_000n);
    await spend.markUncertain(id, 'request timed out');

    const held = (await spend.summary()).monthly;
    assert.equal(held?.usedMicroMyr, 400_000n);
    assert.equal(held?.uncertainMicroMyr, 400_000n);
    assert.equal((await reserve(700_000n)).status, 'blocked', 'the uncertain amount still counts');

    await spend.settle(id, EXAMPLE_USAGE); // the real usage arrives later
    assert.equal((await spend.getEntry(id))?.status, 'confirmed');
    const after = (await spend.summary()).monthly;
    assert.equal(after?.usedMicroMyr, EXAMPLE_COST);
    assert.equal(after?.uncertainMicroMyr, 0n);
  });

  test('an uncertain request can be released only with evidence it was not charged', async () => {
    await configure();
    const id = await reserved(400_000n);
    await spend.markUncertain(id, 'connection reset');
    await assert.rejects(spend.releaseUnsent(id), SpendStateError, 'a request that may have been sent is not "unsent"');

    await spend.reconcileNotCharged(id, 'provider usage report shows no request');
    const entry = await spend.getEntry(id);
    assert.equal(entry?.status, 'released');
    assert.equal(entry?.amountMicroMyr, 0n);
    const note = await pool.query('SELECT note FROM ai_spend_entries WHERE id = $1', [id]);
    assert.equal(note.rows[0].note, 'provider usage report shows no request');
  });

  test('a late timeout cannot undo a request that already succeeded', async () => {
    await configure();
    const id = await reserved(400_000n);
    await spend.settle(id, EXAMPLE_USAGE);
    await spend.markUncertain(id, 'late timeout');
    assert.equal((await spend.getEntry(id))?.status, 'confirmed');
  });

  test('a request that was never sent gives its reservation back, and only that', async () => {
    await configure({ monthlyLimitMicroMyr: myr('1') });
    const id = await reserved(900_000n);
    assert.equal((await reserve(500_000n)).status, 'blocked');

    await spend.releaseUnsent(id);
    await spend.releaseUnsent(id); // harmless the second time
    assert.equal((await spend.summary()).monthly?.usedMicroMyr, 0n);
    await reserved(500_000n);

    const sent = await reserved(100_000n);
    await spend.settle(sent, EXAMPLE_USAGE);
    await assert.rejects(spend.releaseUnsent(sent), SpendStateError);
    await assert.rejects(spend.reconcileNotCharged(sent, 'x'), SpendStateError);
    await assert.rejects(spend.settle(id, EXAMPLE_USAGE), SpendStateError, 'a released entry cannot be settled');
  });

  test('an unknown entry is an error', async () => {
    await assert.rejects(spend.settle(uuidv7(), EXAMPLE_USAGE), SpendStateError);
    await assert.rejects(spend.markUncertain(uuidv7(), 'x'), SpendStateError);
    await assert.rejects(spend.releaseUnsent(uuidv7()), SpendStateError);
    assert.equal(await spend.getEntry(uuidv7()), null);
  });

  test('the monthly allowance starts again at midnight UTC+8 on the 1st', async () => {
    await configure({ monthlyLimitMicroMyr: myr('1') });
    clock.ms = Date.parse('2026-10-31T15:59:59.999Z'); // last millisecond of October in UTC+8
    await reserved(1_000_000n);
    assert.equal((await reserve(1n)).status, 'blocked');

    clock.ms = Date.parse('2026-10-31T16:00:00.000Z'); // 00:00 on 1 November in UTC+8
    await reserved(1_000_000n);
    assert.equal((await reserve(1n)).status, 'blocked');
    assert.equal((await spend.summary()).monthly?.usedMicroMyr, 1_000_000n, 'October spending is not in November');
  });

  test('a daily limit starts again at midnight UTC+8 and a month limit does not', async () => {
    await configure({ monthlyLimitMicroMyr: myr('20'), daily: { mode: 'limit', limitMicroMyr: myr('0.5') } });
    clock.ms = Date.parse('2026-11-09T15:59:59Z'); // 23:59:59 in UTC+8
    await reserved(500_000n);
    const blocked = await reserve(1n);
    assert.equal((blocked as { scope: string }).scope, 'daily');

    clock.ms = Date.parse('2026-11-09T16:00:00Z'); // the next day in UTC+8
    await reserved(500_000n);
    assert.equal((await spend.summary()).monthly?.usedMicroMyr, 1_000_000n);
  });

  test('the tighter of the daily and monthly limits governs, and the refusal says which', async () => {
    await configure({ monthlyLimitMicroMyr: myr('1'), daily: { mode: 'limit', limitMicroMyr: myr('0.3') } });
    await reserved(300_000n);
    const dailyBlock = await reserve(100_000n);
    assert.equal((dailyBlock as { scope: string }).scope, 'daily');

    clock.advanceMinutes(24 * 60);
    await reserved(300_000n);
    clock.advanceMinutes(24 * 60);
    await reserved(300_000n); // 0.9 used, 0.1 left this month
    clock.advanceMinutes(24 * 60);
    const monthlyBlock = await reserve(300_000n);
    assert.equal(monthlyBlock.status, 'blocked');
    assert.equal((monthlyBlock as { scope: string }).scope, 'monthly');
    assert.equal((monthlyBlock as { remainingMicroMyr: bigint }).remainingMicroMyr, 100_000n);
  });

  test('with no daily cap applied, the summary shows no daily figures', async () => {
    await configure();
    const summary = await spend.summary();
    assert.equal(summary.configured, true);
    assert.equal(summary.daily, null);
    assert.equal(summary.monthly?.limitMicroMyr, 20_000_000n);
    assert.equal(summary.monthly?.remainingMicroMyr, 20_000_000n);
  });

  test('the summary separates what is running, what is uncertain and what is confirmed', async () => {
    await configure();
    const running = await reserved(100_000n);
    const unknown = await reserved(200_000n);
    const done = await reserved(300_000n);
    await spend.markUncertain(unknown, 'timeout');
    await spend.settle(done, EXAMPLE_USAGE);

    const month = (await spend.summary()).monthly;
    assert.equal(month?.reservedMicroMyr, 100_000n);
    assert.equal(month?.uncertainMicroMyr, 200_000n);
    assert.equal(month?.usedMicroMyr, 100_000n + 200_000n + EXAMPLE_COST);
    assert.equal(month?.remainingMicroMyr, 20_000_000n - 100_000n - 200_000n - EXAMPLE_COST);
    assert.ok(running);
  });

  test('a second attempt of the same request is its own entry, but the same attempt cannot be reserved twice', async () => {
    await configure();
    const requestId = uuidv7();
    const first = await spend.reserve({ requestId, attemptNo: 1, estimateMicroMyr: 100_000n, purpose: 'extraction' });
    assert.equal(first.status, 'reserved');
    const retry = await spend.reserve({ requestId, attemptNo: 2, estimateMicroMyr: 100_000n, purpose: 'extraction' });
    assert.equal(retry.status, 'reserved');
    await assert.rejects(spend.reserve({ requestId, attemptNo: 2, estimateMicroMyr: 100_000n, purpose: 'extraction' }), /ai_spend_request_attempt_key/);
    assert.equal((await spend.summary()).monthly?.usedMicroMyr, 200_000n, 'every attempt counts');
  });

  test('refuses a reservation with an unknown or non-positive cost', async () => {
    await configure();
    for (const bad of [0n, -1n]) {
      await assert.rejects(reserve(bad), RangeError);
    }
    await assert.rejects(spend.reserve({ requestId: uuidv7(), attemptNo: 0, estimateMicroMyr: 1n, purpose: 'x' }), RangeError);
  });

  test('spend rows can never be deleted', async () => {
    await configure();
    const id = await reserved(100_000n);
    await assert.rejects(pool.query('DELETE FROM ai_spend_entries WHERE id = $1', [id]), /never deleted/);
    await assert.rejects(pool.query('TRUNCATE ai_spend_entries'), /never deleted/);
    assert.ok(await spend.getEntry(id));
  });

  test('the database refuses states that would hide or invent a cost', async () => {
    await configure();
    const id = await reserved(100_000n);
    await assert.rejects(pool.query(`UPDATE ai_spend_entries SET status = 'released' WHERE id = $1`, [id]), /ai_spend_released_costs_nothing/);
    await assert.rejects(pool.query(`UPDATE ai_spend_entries SET amount_micro_myr = 0 WHERE id = $1`, [id]), /ai_spend_held_amount_is_estimate/);
    await assert.rejects(pool.query(`UPDATE ai_spend_entries SET estimate_micro_myr = 0, amount_micro_myr = 0 WHERE id = $1`, [id]), /estimate_micro_myr_check/);
  });

  test('changing the settings is recorded with the new values', async () => {
    await configure();
    clock.advanceSeconds(1); // events at the same instant have no guaranteed order
    await configure({ monthlyLimitMicroMyr: myr('25.5') });
    const rows = await pool.query(`SELECT actor_user_id, detail FROM audit_events WHERE action = 'ai.spend_settings_changed' ORDER BY occurred_at, id`);
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0].actor_user_id, actorId);
    assert.equal(rows.rows[0].detail.settings.modelId, 'gpt-6.1-sol');
    assert.equal(rows.rows[0].detail.settings.monthlyLimitMyr, '20.000000');
    assert.deepEqual(rows.rows[0].detail.settings.daily, { mode: 'not_applied' });
    assert.equal(rows.rows[1].detail.settings.monthlyLimitMyr, '25.500000');
  });

  test('the database does not accept a daily limit amount when no daily limit applies', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO ai_spend_settings (id, model_id, input_usd_per_million_micro, cached_input_usd_per_million_micro,
           output_usd_per_million_micro, myr_per_usd_micro, monthly_limit_micro_myr, daily_mode, daily_limit_micro_myr, updated_at)
         VALUES (1, 'm', 1, 1, 1, 1, 1, 'not_applied', 5, now())`,
      ),
      /ai_spend_daily_limit_only_with_limit_mode/,
    );
  });
});
