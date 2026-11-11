import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { ModelBadResponse, ModelCallError } from '../extraction/model';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { UsersService } from '../users/users.service';
import { guardedAiCall, type GuardedCallInput } from './guarded-call';

const USAGE = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 };
type Answer = { answer: string };

describe('guarded AI call', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let clock: FakeClock;
  let spend: SpendService;
  let userId: string;
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
    userId = (await new UsersService(pool, clock.now).create({ email: 'admin@example.org', displayName: 'Admin' })).id;
    await new SpendSettingsService(pool, clock.now).apply(MVP_SPEND_SETTINGS, userId);
  });

  const deps = (modelConfigured = true) => ({ pool, spend, clock: clock.now, modelConfigured });
  const entries = async (id: string) => (await pool.query('SELECT * FROM ai_spend_entries WHERE request_id = $1 ORDER BY attempt_no', [id])).rows;
  const input = (over: Partial<GuardedCallInput<Answer>> & Pick<GuardedCallInput<Answer>, 'call'>): GuardedCallInput<Answer> => ({
    requestId: uuidv7(),
    attemptNo: 1,
    isLastAttempt: false,
    purpose: 'discussion_analysis',
    actorUserId: userId,
    promptBytes: 4_000,
    maxOutputTokens: 4_000,
    ...over,
  });

  test('ok settles the reservation from reported usage', async () => {
    const i = input({ call: async () => ({ answer: 'x', usage: USAGE }) });
    const out = await guardedAiCall(deps(), i);
    assert.equal(out.kind, 'ok');
    if (out.kind === 'ok') {
      assert.equal(out.value.answer, 'x');
      assert.equal(out.modelId, MVP_SPEND_SETTINGS.modelId);
    }
    const [e] = await entries(i.requestId);
    assert.equal(e.status, 'confirmed');
    assert.equal(e.purpose, 'discussion_analysis');
    assert.equal(Number(e.input_tokens), 10_000);
    assert.equal(Number(e.output_tokens), 2_000);
  });

  test('timeout marks the entry uncertain and asks for retry', async () => {
    const i = input({
      call: async () => {
        throw new ModelCallError('The AI request timed out', 'unknown', true);
      },
    });
    assert.deepEqual(await guardedAiCall(deps(), i), { kind: 'retry' });
    const [e] = await entries(i.requestId);
    assert.equal(e.status, 'uncertain');
    assert.equal(BigInt(e.amount_micro_myr), BigInt(e.estimate_micro_myr), 'the whole estimate still counts');
  });

  test('last attempt failure returns failed', async () => {
    const i = input({
      isLastAttempt: true,
      call: async () => {
        throw new ModelBadResponse('The answer was not valid JSON', USAGE);
      },
    });
    const out = await guardedAiCall(deps(), i);
    assert.deepEqual(out, { kind: 'failed', code: 'bad_response', detail: 'The answer was not valid JSON' });
    assert.equal((await entries(i.requestId))[0].status, 'confirmed', 'the provider did the work, so it is charged');
  });

  test('4xx is reconciled as not charged and not retried', async () => {
    const i = input({
      call: async () => {
        throw new ModelCallError('The AI service refused the request (401)', 'rejected', false, 401);
      },
    });
    const out = await guardedAiCall(deps(), i);
    assert.equal(out.kind, 'failed');
    if (out.kind === 'failed') assert.equal(out.code, 'model_rejected');
    const [e] = await entries(i.requestId);
    assert.equal(e.status, 'released');
    assert.equal(BigInt(e.amount_micro_myr), 0n);
  });

  test('no settings returns blocked spend_not_configured without any entry', async () => {
    await pool.query('DELETE FROM ai_spend_settings');
    let called = false;
    const i = input({
      call: async () => {
        called = true;
        return { answer: 'x', usage: USAGE };
      },
    });
    const out = await guardedAiCall(deps(), i);
    assert.equal(out.kind, 'blocked');
    if (out.kind === 'blocked') assert.equal(out.code, 'spend_not_configured');
    assert.equal(called, false);
    assert.deepEqual(await entries(i.requestId), []);
  });

  test('no model returns failed model_not_configured without any entry', async () => {
    const i = input({ call: async () => ({ answer: 'x', usage: USAGE }) });
    const out = await guardedAiCall(deps(false), i);
    assert.equal(out.kind, 'failed');
    if (out.kind === 'failed') assert.equal(out.code, 'model_not_configured');
    assert.deepEqual(await entries(i.requestId), []);
  });

  test('null actor skips the personal cap', async () => {
    // A personal limit of zero blocks a named person but not an automatic run.
    await new SpendSettingsService(pool, clock.now).apply({ ...MVP_SPEND_SETTINGS, userMonthly: { mode: 'limit', limitMicroMyr: 0n } }, userId);
    const call = async () => ({ answer: 'x', usage: USAGE });
    const named = await guardedAiCall(deps(), input({ call }));
    assert.equal(named.kind, 'blocked');
    if (named.kind === 'blocked') assert.equal(named.code, 'spend_user_no_allowance');

    const auto = input({ actorUserId: null, call });
    assert.equal((await guardedAiCall(deps(), auto)).kind, 'ok');
    assert.equal((await entries(auto.requestId))[0].actor_user_id, null);
  });
});
