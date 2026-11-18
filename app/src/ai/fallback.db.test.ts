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
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { KEY_A, KEY_B, fakeFactory, keyFile, seedAiConnection, seedAiModel, seedProjectAllowance } from '../testing/ai-connections';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { seedProject, seedUser } from '../testing/projects';
import { type GuardedCallInput, type GuardedDeps, type GuardedOutcome, guardedAiCall } from './guarded-call';
import type { KeyRejectedNotice } from './key-rejected';

const USAGE = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 };
type Answer = { answer: string };
type Behaviour = () => Promise<Answer & { usage: typeof USAGE }>;

const timeout = (): never => {
  throw new ModelCallError('The AI request timed out', 'unknown', true);
};
const status = (s: number) => (): never => {
  if (s >= 500) throw new ModelCallError(`The AI service answered ${s}`, 'unknown', true, s);
  if (s === 429) throw new ModelCallError('The AI service asked us to slow down (429)', 'rejected', true, s);
  throw new ModelCallError(`The AI service refused the request (${s})`, 'rejected', false, s);
};
const answer = (text: string) => async () => ({ answer: text, usage: USAGE });

describe('fallback and rejected keys', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let clock: FakeClock;
  let spend: SpendService;
  let admin: string;
  let admin2: string;
  let pm: string;
  let owner: string;
  let sponsor: string;
  let member: string;
  let projectId: string;
  let protectedKey: ProtectedKey;
  let dir: string;
  let logs: string[];
  let notices: KeyRejectedNotice[];
  let factory: ReturnType<typeof fakeFactory>;
  const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    dir = mkdtempSync(join(tmpdir(), 'kainow-fallback-'));
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
    admin = await seedUser(pool, 'admin@example.org', 'enterprise_administrator');
    admin2 = await seedUser(pool, 'admin2@example.org', 'enterprise_administrator');
    pm = await seedUser(pool, 'pm@example.org');
    owner = await seedUser(pool, 'owner@example.org');
    sponsor = await seedUser(pool, 'sponsor@example.org');
    member = await seedUser(pool, 'member@example.org');
    projectId = await seedProject(pool, {
      status: 'active',
      name: 'Harbour Works',
      members: [
        { userId: pm, role: 'pm' },
        { userId: owner, role: 'owner' },
        { userId: sponsor, role: 'sponsor' },
        { userId: member, role: 'member' },
      ],
    });
    await new SpendSettingsService(pool, clock.now).apply({ ...MVP_SPEND_SETTINGS, projectsMayManageConnections: true }, admin);
    await seedProjectAllowance(pool, projectId);
    logs = [];
    notices = [];
    factory = fakeFactory();
  });

  const deps = (over: Partial<GuardedDeps> = {}): GuardedDeps => ({
    pool,
    spend,
    clock: clock.now,
    key: protectedKey,
    factory,
    log: (m) => logs.push(m),
    notify: async (n) => void notices.push(n),
    slotWait: { maxWaitMs: 0, sleep: async () => undefined },
    ...over,
  });
  const entries = async (id: string) =>
    (await pool.query('SELECT attempt_no, status, note, connection_id FROM ai_spend_entries WHERE request_id = $1 ORDER BY attempt_no', [id])).rows;

  /** Connections at positions 1..n, each on its own model; `calls` answers by the model id the gate chose. */
  async function connections(n: number, provider: 'openai' | 'anthropic' = 'openai') {
    const out: { id: string; modelId: string; label: string }[] = [];
    for (let p = 1; p <= n; p++) {
      const model = await seedAiModel(pool, { provider });
      const label = `Connection ${String.fromCharCode(64 + p)}`;
      const id = await seedAiConnection(pool, { projectId, model, position: p, label, protectedKey, apiKey: p === 1 ? KEY_A : KEY_B });
      out.push({ id, modelId: model.modelId, label });
    }
    return out;
  }

  /** Runs attempts 1.. of one request until it ends, answering per connection (by model id) and per attempt. */
  async function run(script: Record<string, Behaviour[]>, requestId = uuidv7(), over: Partial<GuardedCallInput<Answer>> = {}) {
    const seen: string[] = [];
    const outcomes: GuardedOutcome<Answer>[] = [];
    for (let attemptNo = 1; attemptNo <= 5; attemptNo++) {
      const out = await guardedAiCall<Answer>(deps(), {
        requestId,
        attemptNo,
        purpose: 'extraction',
        actorUserId: pm,
        projectId,
        carriesRestricted: false,
        promptBytes: 4_000,
        maxOutputTokens: 4_000,
        call: async (_client, modelId) => {
          seen.push(modelId);
          const next = script[modelId]?.shift();
          if (!next) throw new Error(`no scripted answer for ${modelId}`);
          return next();
        },
        ...over,
      });
      outcomes.push(out);
      if (out.kind !== 'retry') break;
    }
    return { requestId, seen, outcomes, last: outcomes[outcomes.length - 1] };
  }

  test('timeout on primary then success on fallback: entry 1 uncertain on connection A, entry 2 confirmed on connection B, outcome connectionId B', async () => {
    const [a, b] = await connections(2);
    const r = await run({ [a.modelId]: [timeout], [b.modelId]: [answer('from B')] });
    assert.deepEqual(r.seen, [a.modelId, b.modelId]);
    assert.equal(r.last.kind, 'ok');
    if (r.last.kind === 'ok') assert.deepEqual([r.last.connectionId, r.last.modelId, r.last.value.answer], [b.id, b.modelId, 'from B']);
    assert.deepEqual(
      (await entries(r.requestId)).map((e) => [e.attempt_no, e.status, e.connection_id]),
      [
        [1, 'uncertain', a.id],
        [2, 'confirmed', b.id],
      ],
    );
    assert.deepEqual(factory.opened.map((o) => o.apiKey), [KEY_A, KEY_B], 'each attempt opens its own connection key');
  });

  test('429 then 5xx then success across three connections in order', async () => {
    const [a, b, c] = await connections(3);
    const r = await run({ [a.modelId]: [status(429)], [b.modelId]: [status(503)], [c.modelId]: [answer('from C')] });
    assert.deepEqual(r.seen, [a.modelId, b.modelId, c.modelId]);
    assert.equal(r.last.kind, 'ok');
    if (r.last.kind === 'ok') assert.equal(r.last.connectionId, c.id);
    assert.deepEqual(
      (await entries(r.requestId)).map((e) => [e.attempt_no, e.status, e.note, e.connection_id]),
      [
        [1, 'released', 'rate_limited_429', a.id],
        [2, 'uncertain', 'The AI service answered 503', b.id],
        [3, 'confirmed', null, c.id],
      ],
    );
  });

  test('bad response settles and moves on', async () => {
    const [a, b] = await connections(2);
    const r = await run({ [a.modelId]: [async () => Promise.reject(new ModelBadResponse('The answer was cut off at the output limit', USAGE))], [b.modelId]: [answer('from B')] });
    assert.deepEqual(r.outcomes[0], { kind: 'retry' });
    assert.equal(r.last.kind, 'ok');
    assert.deepEqual(
      (await entries(r.requestId)).map((e) => [e.attempt_no, e.status, e.note, e.connection_id]),
      [
        [1, 'confirmed', 'bad_response', a.id],
        [2, 'confirmed', null, b.id],
      ],
    );
  });

  test('401 → failed model_rejected, entry released, connection key_rejected with rejected_status 401, one ai_key_rejected notification per EA and per current connection manager, ai_connection_events key_rejected', async () => {
    const [a, b] = await connections(2);
    const r = await run({ [a.modelId]: [status(401)], [b.modelId]: [answer('never')] });
    assert.equal(r.outcomes.length, 1, 'a rejected key is not retried');
    assert.equal(r.last.kind, 'failed');
    if (r.last.kind === 'failed') assert.equal(r.last.code, 'model_rejected');
    assert.deepEqual((await entries(r.requestId)).map((e) => e.status), ['released']);

    const conn = (await pool.query(`SELECT state, rejected_at, rejected_status, rejection_notified_at FROM ai_connections WHERE id = $1`, [a.id])).rows[0];
    assert.deepEqual([conn.state, conn.rejected_status], ['key_rejected', 401]);
    assert.equal((conn.rejected_at as Date).getTime(), clock.ms);
    assert.equal((conn.rejection_notified_at as Date).getTime(), clock.ms);

    const text =
      'The OpenAI key for AI connection "Connection A" in Harbour Works was refused, or this key may not use the model. AI requests skip this connection until the key is replaced.';
    const sent = (await pool.query(`SELECT user_id, project_id, kind, summary FROM notifications ORDER BY user_id`)).rows;
    assert.deepEqual(sent.map((n) => n.user_id).sort(), [admin, admin2, pm, owner, sponsor].sort(), 'every EA and every PM, Owner and Sponsor; not the member');
    for (const n of sent) assert.deepEqual([n.project_id, n.kind, n.summary], [projectId, 'ai_key_rejected', text]);

    const events = (await pool.query(`SELECT action, actor_id, detail FROM ai_connection_events WHERE connection_id = $1`, [a.id])).rows;
    assert.deepEqual(events.map((e) => [e.action, e.actor_id]), [['key_rejected', null]]);
    assert.equal(events[0].detail.label, 'Connection A');
    assert.equal(events[0].detail.status, 401);
    const audit = (await pool.query(`SELECT action, subject_id, detail FROM audit_events WHERE action = 'ai.connection_key_rejected'`)).rows;
    assert.equal(audit.length, 1, 'the History line');
    assert.deepEqual([audit[0].subject_id, audit[0].detail.projectId, audit[0].detail.label], [a.id, projectId, 'Connection A']);

    assert.equal(notices.length, 1);
    assert.equal(notices[0].text, text);
    assert.ok(!JSON.stringify(notices).includes(KEY_A));

    // The next request starts on the fallback.
    const next = await run({ [b.modelId]: [answer('from B')] });
    assert.deepEqual(next.seen, [b.modelId]);
  });

  test('403 with delegation off notifies only the Enterprise Administrators', async () => {
    await new SpendSettingsService(pool, clock.now).apply({ ...MVP_SPEND_SETTINGS, projectsMayManageConnections: false }, admin);
    const [a] = await connections(1, 'anthropic');
    const r = await run({ [a.modelId]: [status(403)] });
    assert.equal(r.last.kind, 'failed');
    const sent = (await pool.query(`SELECT user_id, summary FROM notifications`)).rows;
    assert.deepEqual(sent.map((n) => n.user_id).sort(), [admin, admin2].sort());
    assert.match(sent[0].summary, /^The Anthropic key for AI connection "Connection A" in Harbour Works was refused/);
    assert.equal((await pool.query(`SELECT rejected_status FROM ai_connections WHERE id = $1`, [a.id])).rows[0].rejected_status, 403);
  });

  test('two concurrent 401s mark the connection once and notify once', async () => {
    const [a] = await connections(1);
    await Promise.all([run({ [a.modelId]: [status(401)] }), run({ [a.modelId]: [status(401)] })]);
    assert.equal((await pool.query(`SELECT state FROM ai_connections WHERE id = $1`, [a.id])).rows[0].state, 'key_rejected');
    assert.equal(Number((await pool.query(`SELECT count(*) FROM ai_connection_events WHERE action = 'key_rejected'`)).rows[0].count), 1);
    assert.equal(Number((await pool.query(`SELECT count(*) FROM audit_events WHERE action = 'ai.connection_key_rejected'`)).rows[0].count), 1);
    const perUser = (await pool.query(`SELECT user_id, count(*)::int AS n FROM notifications GROUP BY user_id`)).rows;
    assert.equal(perUser.length, 5);
    assert.ok(perUser.every((r) => r.n === 1), 'each manager gets exactly one notice');
    assert.equal(notices.length, 1);
  });

  test('a key that will not open (a copied row) makes its connection ineligible for the attempt; the next one is used', async () => {
    const model = await seedAiModel(pool);
    const otherProject = await seedProject(pool, { status: 'active', members: [{ userId: pm, role: 'pm' }] });
    const copied = await seedAiConnection(pool, {
      projectId,
      model,
      position: 1,
      protectedKey,
      sealedFor: { connectionId: uuidv7(), projectId: otherProject, provider: 'openai' },
    });
    const m2 = await seedAiModel(pool);
    const b = { id: await seedAiConnection(pool, { projectId, model: m2, position: 2, protectedKey, apiKey: KEY_B }), modelId: m2.modelId };
    assert.ok(copied);
    const r = await run({ [b.modelId]: [answer('from B')] });
    assert.deepEqual(r.seen, [b.modelId]);
    assert.equal(r.last.kind, 'ok');
    assert.deepEqual((await entries(r.requestId)).map((e) => [e.status, e.connection_id]), [['confirmed', b.id]], 'nothing reserved for the unreadable one');
    assert.deepEqual(factory.opened.map((o) => o.apiKey), [KEY_B]);
  });

  test('when every eligible key will not open → blocked no_eligible_connection, nothing reserved', async () => {
    const model = await seedAiModel(pool);
    await seedAiConnection(pool, { projectId, model, position: 1, protectedKey, sealedFor: { connectionId: uuidv7(), projectId, provider: 'openai' } });
    const r = await run({});
    assert.equal(r.last.kind, 'blocked');
    if (r.last.kind === 'blocked') assert.equal(r.last.code, 'no_eligible_connection');
    assert.deepEqual(await entries(r.requestId), []);
    assert.equal(Number((await pool.query(`SELECT count(*) FROM ai_call_slots WHERE holder IS NOT NULL`)).rows[0].count), 0);
  });
});
