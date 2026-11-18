import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { ModelBadResponse, ModelCallError } from '../extraction/model';
import { type ProtectedKey, loadProtectedKey } from '../quarantine/protected-key';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService, type SpendSettingsInput } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { KEY_A, fakeFactory, keyFile, seedAiConnection, seedAiModel, seedProjectAllowance } from '../testing/ai-connections';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { seedProject, seedUser } from '../testing/projects';
import { type GuardedCallInput, type GuardedDeps, guardedAiCall } from './guarded-call';
import { takeSlot } from './slots';

const USAGE = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 };
type Answer = { answer: string };

describe('guarded AI call', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let clock: FakeClock;
  let spend: SpendService;
  let userId: string;
  let projectId: string;
  let protectedKey: ProtectedKey;
  let dir: string;
  let logs: string[];
  let factory: ReturnType<typeof fakeFactory>;
  const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    dir = mkdtempSync(join(tmpdir(), 'kainow-guarded-'));
    protectedKey = loadProtectedKey(keyFile(dir), () => undefined) as ProtectedKey;
  });
  after(async () => {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    spend = new SpendService(pool, clock.now);
    userId = await seedUser(pool, 'admin@example.org', 'enterprise_administrator');
    projectId = await seedProject(pool, { status: 'active', members: [{ userId, role: 'pm' }] });
    await new SpendSettingsService(pool, clock.now).apply(MVP_SPEND_SETTINGS, userId);
    await seedProjectAllowance(pool, projectId);
    logs = [];
    factory = fakeFactory();
  });

  const configure = (patch: Partial<SpendSettingsInput>) => new SpendSettingsService(pool, clock.now).apply({ ...MVP_SPEND_SETTINGS, ...patch }, userId);
  const deps = (over: Partial<GuardedDeps> = {}): GuardedDeps => ({
    pool,
    spend,
    clock: clock.now,
    key: protectedKey,
    factory,
    log: (m) => logs.push(m),
    slotWait: { maxWaitMs: 0, sleep: async () => undefined },
    ...over,
  });
  const entries = async (id: string) => (await pool.query('SELECT * FROM ai_spend_entries WHERE request_id = $1 ORDER BY attempt_no', [id])).rows;
  const input = (over: Partial<GuardedCallInput<Answer>> & Pick<GuardedCallInput<Answer>, 'call'>): GuardedCallInput<Answer> => ({
    requestId: uuidv7(),
    attemptNo: 1,
    purpose: 'discussion_analysis',
    actorUserId: userId,
    projectId,
    carriesRestricted: false,
    promptBytes: 4_000,
    maxOutputTokens: 4_000,
    ...over,
  });
  const connect = async (o: { state?: 'ready' | 'unchecked' | 'disabled'; position?: number } = {}) => {
    const model = await seedAiModel(pool);
    const id = await seedAiConnection(pool, { projectId, model, position: o.position ?? 1, state: o.state, protectedKey, apiKey: KEY_A });
    return { ...model, id };
  };
  const ok = async () => ({ answer: 'x', usage: USAGE });
  const slotsHeld = async () => Number((await pool.query(`SELECT count(*) FROM ai_call_slots WHERE holder IS NOT NULL`)).rows[0].count);

  test('ok settles the reservation from reported usage on the chosen connection', async () => {
    const c = await connect();
    const i = input({ call: ok });
    const out = await guardedAiCall(deps(), i);
    assert.equal(out.kind, 'ok');
    if (out.kind === 'ok') {
      assert.equal(out.value.answer, 'x');
      assert.deepEqual([out.modelId, out.connectionId, out.provider], [c.modelId, c.id, 'openai']);
    }
    const [e] = await entries(i.requestId);
    assert.deepEqual([e.status, e.purpose, e.project_id, e.connection_id, e.provider, e.model_id, e.ruled], ['confirmed', 'discussion_analysis', projectId, c.id, 'openai', c.modelId, true]);
    assert.equal(Number(e.input_tokens), 10_000);
    assert.equal(Number(e.output_tokens), 2_000);
    assert.equal(await slotsHeld(), 0, 'the slot is released');
  });

  test('the call gets the effective timeout and a client built for the chosen provider', async () => {
    await connect();
    await seedProjectAllowance(pool, projectId, { timeoutSeconds: 45 });
    let seen = 0;
    const out = await guardedAiCall(deps(), input({ call: async (_c, _m, timeoutMs) => ((seen = timeoutMs), ok()) }));
    assert.equal(out.kind, 'ok');
    assert.equal(seen, 45_000);
    assert.deepEqual(factory.opened.map((o) => [o.provider, o.timeoutMs]), [['openai', 45_000]]);
  });

  test('timeout marks the entry uncertain and asks for retry', async () => {
    await connect();
    const i = input({
      call: async () => {
        throw new ModelCallError('The AI request timed out', 'unknown', true);
      },
    });
    assert.deepEqual(await guardedAiCall(deps(), i), { kind: 'retry' });
    const [e] = await entries(i.requestId);
    assert.equal(e.status, 'uncertain');
    assert.equal(BigInt(e.amount_micro_myr), BigInt(e.estimate_micro_myr), 'the whole estimate still counts');
    assert.equal(await slotsHeld(), 0);
  });

  test('last attempt (attemptNo = effective attempts) failure returns failed', async () => {
    await connect();
    const i = input({
      attemptNo: 3,
      call: async () => {
        throw new ModelBadResponse('The answer was not valid JSON', USAGE);
      },
    });
    const out = await guardedAiCall(deps(), i);
    assert.deepEqual(out, { kind: 'failed', code: 'bad_response', detail: 'The answer was not valid JSON' });
    const [e] = await entries(i.requestId);
    assert.equal(e.status, 'confirmed', 'the provider did the work, so it is charged');
    assert.equal(e.note, 'bad_response');
  });

  test('4xx is reconciled as not charged and not retried', async () => {
    await connect();
    const i = input({
      call: async () => {
        throw new ModelCallError('The AI service refused the request (400)', 'rejected', false, 400);
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
    await connect();
    await pool.query('DELETE FROM ai_spend_settings');
    let called = false;
    const i = input({ call: async () => ((called = true), ok()) });
    const out = await guardedAiCall(deps(), i);
    assert.equal(out.kind, 'blocked');
    if (out.kind === 'blocked') assert.equal(out.code, 'spend_not_configured');
    assert.equal(called, false);
    assert.deepEqual(await entries(i.requestId), []);
    assert.equal(await slotsHeld(), 0);
  });

  test('null actor skips the personal cap', async () => {
    await connect();
    // A personal limit of zero blocks a named person but not an automatic run.
    await configure({ userMonthly: { mode: 'limit', limitMicroMyr: 0n } });
    const named = await guardedAiCall(deps(), input({ call: ok }));
    assert.equal(named.kind, 'blocked');
    if (named.kind === 'blocked') assert.equal(named.code, 'spend_user_no_allowance');

    const auto = input({ actorUserId: null, call: ok });
    assert.equal((await guardedAiCall(deps(), auto)).kind, 'ok');
    assert.equal((await entries(auto.requestId))[0].actor_user_id, null);
  });

  // ---- the order of the gate ----

  test('lowering attempts ends a pending request without sending: attemptNo above effective attempts → failed attempts_used, nothing reserved', async () => {
    await connect();
    await seedProjectAllowance(pool, projectId, { maxAttempts: 1 });
    let called = false;
    const i = input({ attemptNo: 2, call: async () => ((called = true), ok()) });
    assert.deepEqual(await guardedAiCall(deps(), i), { kind: 'failed', code: 'attempts_used', detail: 'No attempts are left for this request.' });
    assert.equal(called, false);
    assert.deepEqual(await entries(i.requestId), []);
    assert.equal(factory.opened.length, 0, 'no key was opened');
  });

  test('no connections → blocked ai_not_set_up', async () => {
    const i = input({ call: ok });
    assert.deepEqual(await guardedAiCall(deps(), i), { kind: 'blocked', code: 'ai_not_set_up', detail: 'AI is not set up for this project.' });
    assert.deepEqual(await entries(i.requestId), []);
  });

  test('connections but none eligible → blocked no_eligible_connection naming the work and restricted material', async () => {
    const model = await seedAiModel(pool, { restrictedOk: false });
    await seedAiConnection(pool, { projectId, model, position: 1, protectedKey });
    const i = input({ purpose: 'minutes_draft', carriesRestricted: true, call: ok });
    assert.deepEqual(await guardedAiCall(deps(), i), {
      kind: 'blocked',
      code: 'no_eligible_connection',
      detail: 'No AI connection in this project is approved for minutes drafting with restricted material and usable now.',
    });
    assert.deepEqual(await entries(i.requestId), []);
  });

  test('protected key null → blocked protected_key_missing', async () => {
    await connect();
    const i = input({ call: ok });
    const out = await guardedAiCall(deps({ key: null }), i);
    assert.equal(out.kind, 'blocked');
    if (out.kind === 'blocked') assert.equal(out.code, 'protected_key_missing');
    assert.deepEqual(await entries(i.requestId), []);
  });

  test('reserve blocked releases the slot', async () => {
    await connect();
    await seedProjectAllowance(pool, projectId, { monthlyMicroMyr: 0n });
    let called = false;
    const i = input({ call: async () => ((called = true), ok()) });
    const out = await guardedAiCall(deps(), i);
    assert.equal(out.kind, 'blocked');
    if (out.kind === 'blocked') assert.equal(out.code, 'spend_project_no_allowance');
    assert.equal(called, false);
    assert.equal(factory.opened.length, 1, 'the key was opened, but nothing was sent');
    assert.equal(await slotsHeld(), 0);
  });

  test('no slot within the wait → wait, no spend entry', async () => {
    await connect();
    await configure({ concurrency: 1 });
    assert.equal(await takeSlot(pool, 'other:1', 1, 60_000), 1);
    let sleeps = 0;
    let called = false;
    const i = input({ call: async () => ((called = true), ok()) });
    const out = await guardedAiCall(deps({ slotWait: { maxWaitMs: 3_000, pollMs: 1_000, sleep: async () => void sleeps++ } }), i);
    assert.deepEqual(out, { kind: 'wait' });
    assert.equal(sleeps, 3);
    assert.equal(called, false);
    assert.equal(factory.opened.length, 0);
    assert.deepEqual(await entries(i.requestId), []);
    assert.equal((await pool.query(`SELECT holder FROM ai_call_slots WHERE slot = 1`)).rows[0].holder, 'other:1', 'the other holder keeps its slot');
  });

  test('success on unchecked marks ready and sets last_used_at', async () => {
    const c = await connect({ state: 'unchecked' });
    assert.equal((await guardedAiCall(deps(), input({ call: ok }))).kind, 'ok');
    const row = (await pool.query(`SELECT state, last_used_at FROM ai_connections WHERE id = $1`, [c.id])).rows[0];
    assert.equal(row.state, 'ready');
    assert.equal((row.last_used_at as Date).getTime(), clock.ms);
  });

  test('the decrypted key is passed to the factory and never appears in a log line or outcome detail', async () => {
    await connect();
    const outcomes: unknown[] = [];
    outcomes.push(await guardedAiCall(deps(), input({ call: ok })));
    outcomes.push(
      await guardedAiCall(
        deps(),
        input({
          attemptNo: 3,
          call: async () => {
            throw new Error('something broke');
          },
        }),
      ),
    );
    outcomes.push(
      await guardedAiCall(
        deps(),
        input({
          call: async () => {
            throw new ModelCallError('The AI service refused the request (401)', 'rejected', false, 401);
          },
        }),
      ),
    );
    assert.deepEqual(factory.opened.map((o) => o.apiKey), [KEY_A, KEY_A, KEY_A]);
    assert.ok(logs.length > 0, 'the unexpected error was logged');
    const seen = JSON.stringify({ logs, outcomes, entries: (await pool.query(`SELECT * FROM ai_spend_entries`)).rows });
    assert.ok(!seen.includes(KEY_A), 'the key is in no log, outcome or entry');
    const stored = JSON.stringify((await pool.query(`SELECT * FROM ai_connection_events UNION ALL SELECT id, NULL, action, actor_user_id, NULL, detail, occurred_at FROM audit_events`)).rows);
    assert.ok(!stored.includes(KEY_A));
    const notices = JSON.stringify((await pool.query(`SELECT summary, link FROM notifications`)).rows);
    assert.ok(!notices.includes(KEY_A));
  });
});
