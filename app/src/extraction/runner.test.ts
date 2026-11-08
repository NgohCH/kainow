import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { UsersService } from '../users/users.service';
import { seedProject } from '../testing/projects';
import { ModelBadResponse, ModelCallError, type ModelClient, type ModelRequest, type ModelResult, type RawItem } from './model';
import { ExtractionRunner } from './runner';

const NOTES = 'Weekly sync.\nWe agreed to ship on Friday.\nAli will email Sam by Monday.\nok. ok.\nRisk: the vendor may be late.';
const USAGE = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 };

class FakeModel implements ModelClient {
  calls: ModelRequest[] = [];
  constructor(public next: () => ModelResult | Promise<ModelResult>) {}
  async extract(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req);
    return this.next();
  }
}

type FakeItem = Omit<RawItem, 'due_event' | 'alternatives'> & Partial<Pick<RawItem, 'due_event' | 'alternatives'>>;
const answer = (items: FakeItem[], meetingDate: string | null = null): ModelResult => ({
  meetingDate,
  items: items.map((i) => ({ due_event: null, alternatives: [], ...i })),
  usage: USAGE,
});

describe('extraction runner', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let clock: FakeClock;
  let spend: SpendService;
  let userId: string;
  let versionId: string;
  let projectId: string;
  const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });

  async function addVersion(text: string): Promise<string> {
    const sourceId = uuidv7();
    await pool.query('INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, $2, $3, $4, $5)', [sourceId, 'T', userId, clock.now(), projectId]);
    const id = uuidv7();
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'paste', $3, 'x', $4, $5, $6)`,
      [id, sourceId, text, text.length, userId, clock.now()],
    );
    return id;
  }

  async function newRun(vId: string = versionId): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'queued', $4)`,
      [id, vId, userId, clock.now()],
    );
    return id;
  }

  const runner = (model: ModelClient | null) => new ExtractionRunner({ pool, spend, model, clock: clock.now });
  const run = async (id: string) => (await pool.query('SELECT * FROM extraction_runs WHERE id = $1', [id])).rows[0];
  const entries = async (id: string) => (await pool.query('SELECT * FROM ai_spend_entries WHERE request_id = $1 ORDER BY attempt_no', [id])).rows;

  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    spend = new SpendService(pool, clock.now);
    userId = (await new UsersService(pool, clock.now).create({ email: 'admin@example.org', displayName: 'Admin' })).id;
    await new SpendSettingsService(pool, clock.now).apply(MVP_SPEND_SETTINGS, userId);
    projectId = await seedProject(pool, { members: [{ userId, role: 'pm' }] });
    versionId = await addVersion(NOTES);
  });

  test('a good answer saves proposals with offsets and settles the real cost', async () => {
    const model = new FakeModel(() =>
      answer([
        { kind: 'decision', text: 'Ship Friday', owner: null, due: 'Friday', source_quote: 'We agreed to ship on Friday.' },
        { kind: 'action', text: 'Ali emails Sam', owner: 'Ali', due: 'Monday', source_quote: 'Ali will email Sam by Monday.' },
        { kind: 'question', text: 'Repeated', owner: null, due: null, source_quote: 'ok.' },
        { kind: 'risk', text: 'Invented', owner: null, due: null, source_quote: 'Nothing like this was said.' },
      ]),
    );
    const id = await newRun();
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');

    const r = await run(id);
    assert.equal(r.status, 'succeeded');
    assert.equal(r.item_count, 4);
    assert.equal(r.unlocated_count, 1);
    assert.equal(r.model_id, 'gpt-6.1-sol');

    const items = (await pool.query('SELECT * FROM extraction_items WHERE run_id = $1 ORDER BY position', [id])).rows;
    const first = items[0];
    assert.equal(NOTES.slice(first.quote_start, first.quote_end), 'We agreed to ship on Friday.');
    assert.equal(first.quote_matches, 1);
    assert.equal(items[2].quote_matches, 2, 'a repeated quote is flagged as ambiguous');
    assert.equal(items[3].quote_matches, 0);
    assert.equal(items[3].quote_start, null, 'an unfound quote has no offsets');
    assert.ok(items.every((i) => i.review_status === 'pending'));

    const [entry] = await entries(id);
    assert.equal(entry.status, 'confirmed');
    assert.equal(BigInt(entry.amount_micro_myr), 164_000n, 'the example extraction costs MYR 0.164');
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0].modelId, 'gpt-6.1-sol');
  });

  test('saves the meeting date on the run and due_event and alternatives on each item', async () => {
    const model = new FakeModel(() =>
      answer(
        [
          { kind: 'question', text: 'Ship Friday or wait?', owner: null, due: null, source_quote: 'We agreed to ship on Friday.', alternatives: ['Ship Friday', 'Wait'] },
          { kind: 'action', text: 'Ali emails Sam', owner: 'Ali', due: null, due_event: 'after the vendor replies', source_quote: 'Ali will email Sam by Monday.' },
        ],
        '2026-11-04',
      ),
    );
    const id = await newRun();
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');
    const r = (await pool.query(`SELECT to_char(meeting_date, 'YYYY-MM-DD') AS meeting_date FROM extraction_runs WHERE id = $1`, [id])).rows[0];
    assert.equal(r.meeting_date, '2026-11-04');
    const items = (await pool.query('SELECT due_event, alternatives FROM extraction_items WHERE run_id = $1 ORDER BY position', [id])).rows;
    assert.deepEqual(items[0].alternatives, ['Ship Friday', 'Wait']);
    assert.equal(items[0].due_event, null);
    assert.equal(items[1].due_event, 'after the vendor replies');
    assert.deepEqual(items[1].alternatives, []);
  });

  test('a note with a credential is never sent and costs nothing', async () => {
    const vId = await addVersion('Deploy notes. password: Hunter2!xyz and key AKIAABCDEFGHIJKLMNOP');
    const model = new FakeModel(() => answer([]));
    const id = await newRun(vId);
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    const r = await run(id);
    assert.equal(r.failure_code, 'credential_detected');
    assert.ok(!r.failure_detail.includes('Hunter2') && !r.failure_detail.includes('AKIA'), 'the secret is not repeated');
    assert.match(r.failure_detail, /AWS access key/);
    assert.equal(model.calls.length, 0);
    assert.deepEqual(await entries(id), []);
  });

  test('with no approved spend settings or a blank limit nothing is sent', async () => {
    const model = new FakeModel(() => answer([]));
    await new SpendSettingsService(pool, clock.now).apply({ ...MVP_SPEND_SETTINGS, monthlyLimitMicroMyr: null }, userId);
    const id = await newRun();
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    assert.equal((await run(id)).failure_code, 'spend_no_allowance');
    assert.equal(model.calls.length, 0);

    await pool.query('DELETE FROM ai_spend_settings');
    const id2 = await addVersion('other notes').then(newRun);
    assert.equal(await runner(model).process(id2, 1, false), 'blocked');
    assert.equal((await run(id2)).failure_code, 'spend_not_configured');
    assert.equal(model.calls.length, 0);
  });

  test('a request that could pass the monthly cap is refused before it is sent', async () => {
    await new SpendSettingsService(pool, clock.now).apply({ ...MVP_SPEND_SETTINGS, monthlyLimitMicroMyr: 100_000n }, userId); // MYR 0.10
    const model = new FakeModel(() => answer([]));
    const id = await newRun();
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    assert.equal((await run(id)).failure_code, 'spend_cap_would_be_exceeded');
    assert.equal(model.calls.length, 0);
  });

  test('without an AI key the run fails and nothing is reserved', async () => {
    const id = await newRun();
    assert.equal(await runner(null).process(id, 1, false), 'failed');
    assert.equal((await run(id)).failure_code, 'model_not_configured');
    assert.deepEqual(await entries(id), []);
  });

  test('a disabled requester cannot run an extraction', async () => {
    const other = (await new UsersService(pool, clock.now).create({ email: 'b@example.org', displayName: 'B' })).id;
    await pool.query('UPDATE extraction_runs SET requested_by = requested_by'); // no-op, keeps the table touched
    const id = await newRun();
    await pool.query('UPDATE extraction_runs SET requested_by = $2 WHERE id = $1', [id, other]);
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [other]);
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    assert.equal((await run(id)).failure_code, 'requester_not_allowed');
    assert.equal(model.calls.length, 0);
  });

  test('a requester who no longer holds a role that may run extractions in the project is blocked', async () => {
    const id = await newRun();
    await pool.query('UPDATE memberships SET revoked_at = now() WHERE project_id = $1', [projectId]);
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    assert.equal((await run(id)).failure_code, 'requester_not_allowed');
    assert.equal(model.calls.length, 0);
  });

  test('a run on a Deferred project is blocked', async () => {
    const id = await newRun();
    await pool.query("UPDATE projects SET status = 'deferred' WHERE id = $1", [projectId]);
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    assert.equal(model.calls.length, 0);
  });

  test('a timeout keeps the full estimate counted, and the retry is a second counted attempt', async () => {
    let n = 0;
    const model = new FakeModel(() => {
      if (++n === 1) throw new ModelCallError('The AI request timed out', 'unknown', true);
      return answer([{ kind: 'decision', text: 'd', owner: null, due: null, source_quote: 'We agreed to ship on Friday.' }]);
    });
    const id = await newRun();
    assert.equal(await runner(model).process(id, 1, false), 'retry');
    assert.equal((await run(id)).status, 'queued');
    let e = await entries(id);
    assert.equal(e[0].status, 'uncertain');
    assert.equal(BigInt(e[0].amount_micro_myr), BigInt(e[0].estimate_micro_myr), 'the whole estimate still counts');

    assert.equal(await runner(model).process(id, 2, false), 'succeeded');
    e = await entries(id);
    assert.deepEqual(e.map((x) => x.status), ['uncertain', 'confirmed']);
    assert.equal(e[1].attempt_no, 2);
  });

  test('a 429 is retried and, since the provider did no work, is not charged', async () => {
    const model = new FakeModel(() => {
      throw new ModelCallError('The AI service asked us to slow down (429)', 'rejected', true, 429);
    });
    const id = await newRun();
    assert.equal(await runner(model).process(id, 1, false), 'retry');
    const [e] = await entries(id);
    assert.equal(e.status, 'released');
    assert.equal(BigInt(e.amount_micro_myr), 0n);
  });

  test('a refusal such as a bad key fails at once without retrying', async () => {
    const model = new FakeModel(() => {
      throw new ModelCallError('The AI service refused the request (401)', 'rejected', false, 401);
    });
    const id = await newRun();
    assert.equal(await runner(model).process(id, 1, false), 'failed');
    assert.equal((await run(id)).failure_code, 'model_rejected');
  });

  test('an unusable answer is still charged, and the third failure ends the run', async () => {
    const model = new FakeModel(() => {
      throw new ModelBadResponse('The answer was not valid JSON', USAGE);
    });
    const id = await newRun();
    assert.equal(await runner(model).process(id, 1, false), 'retry');
    assert.equal(await runner(model).process(id, 2, false), 'retry');
    assert.equal(await runner(model).process(id, 3, true), 'failed');
    const r = await run(id);
    assert.equal(r.failure_code, 'bad_response');
    const e = await entries(id);
    assert.equal(e.length, 3);
    assert.ok(e.every((x) => x.status === 'confirmed' && BigInt(x.amount_micro_myr) === 164_000n), 'every attempt is paid for');
  });

  test('a reservation left open by a crashed worker is kept counted, not forgotten', async () => {
    const id = await newRun();
    const held = await spend.reserve({ requestId: id, attemptNo: 1, estimateMicroMyr: 500_000n, purpose: 'extraction', actorUserId: userId });
    assert.equal(held.status, 'reserved');
    const model = new FakeModel(() => answer([{ kind: 'decision', text: 'd', owner: null, due: null, source_quote: 'We agreed to ship on Friday.' }]));
    assert.equal(await runner(model).process(id, 2, false), 'succeeded');
    const e = await entries(id);
    assert.equal(e[0].status, 'uncertain');
    assert.equal(BigInt(e[0].amount_micro_myr), 500_000n);
  });

  test('running a finished run again does nothing and costs nothing more', async () => {
    const model = new FakeModel(() => answer([{ kind: 'decision', text: 'd', owner: null, due: null, source_quote: 'We agreed to ship on Friday.' }]));
    const id = await newRun();
    await runner(model).process(id, 1, false);
    assert.equal(await runner(model).process(id, 1, false), 'skipped');
    assert.equal(model.calls.length, 1);
    assert.equal((await entries(id)).length, 1);
  });

  test('the audit trail records the outcome without any note text', async () => {
    const id = await newRun();
    await runner(new FakeModel(() => answer([{ kind: 'decision', text: 'd', owner: null, due: null, source_quote: 'We agreed to ship on Friday.' }]))).process(id, 1, false);
    const { rows } = await pool.query("SELECT detail FROM audit_events WHERE action = 'extraction.finished'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail.status, 'succeeded');
    assert.ok(!JSON.stringify(rows).includes('ship on Friday'));
  });
});
