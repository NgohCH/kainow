import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { ModelCallError, type ModelRequest, type ModelResult } from '../extraction/model';
import { ExtractionRunner } from '../extraction/runner';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { aiDeps, aiReady } from '../testing/ai-runners';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { seedProject, seedUser } from '../testing/projects';
import { standaloneCases } from '../testing/quarantine';
import { WAITING_FOR_PLACE } from './guarded-call';

const USAGE = { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100 };
const NOTES = 'We agreed to ship on Friday.';

/** Records the model of every call; `before` runs first and may throw (an outage) or do something while the call is out. */
class Extractor {
  calls: string[] = [];
  constructor(private readonly before: (modelId: string, n: number) => void | Promise<void> = () => undefined) {}
  async extract(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req.modelId);
    await this.before(req.modelId, this.calls.length);
    return { meetingDate: null, items: [{ kind: 'decision', text: 'Ship', owner: null, due: null, due_event: null, alternatives: [], source_quote: NOTES }], usage: USAGE };
  }
}
const timeout = () => {
  throw new ModelCallError('The AI request timed out', 'unknown', true);
};

describe('runner attempts (spec 6.5, 6.6)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let clock: FakeClock;
  let spend: SpendService;
  let pm: string;
  let projectId: string;
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
    pm = await seedUser(pool, 'pm@example.org');
    await new SpendSettingsService(pool, clock.now).apply(MVP_SPEND_SETTINGS, pm);
    projectId = await seedProject(pool, { status: 'active', members: [{ userId: pm, role: 'pm' }, { userId: pm, role: 'owner' }] });
  });

  async function addSource(text: string): Promise<{ sourceId: string; versionId: string }> {
    const sourceId = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'Notes', $2, $3, $4)`, [sourceId, pm, clock.now(), projectId]);
    const versionId = uuidv7();
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'paste', $3, 'x', $4, $5, $6)`,
      [versionId, sourceId, text, text.length, pm, clock.now()],
    );
    return { sourceId, versionId };
  }
  async function newRun(): Promise<string> {
    const { versionId } = await addSource(NOTES);
    const id = uuidv7();
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'queued', $4)`, [id, versionId, pm, clock.now()]);
    return id;
  }
  const runner = (model: object) => new ExtractionRunner({ pool, spend, ...aiDeps(model), clock: clock.now, slotWait: { maxWaitMs: 0 } });
  const run = async (id: string) => (await pool.query(`SELECT * FROM extraction_runs WHERE id = $1`, [id])).rows[0];
  const entries = async (id: string) => (await pool.query(`SELECT * FROM ai_spend_entries WHERE request_id = $1 ORDER BY attempt_no`, [id])).rows;

  test('a resumed job keeps its attempt number and writes no second spend entry for it', async () => {
    await aiReady(pool, projectId);
    const id = await newRun();
    const model = new Extractor();
    // Every AI place is taken by someone else.
    await pool.query(`UPDATE ai_call_slots SET holder = 'someone-else:1', leased_until = now() + interval '1 hour'`);
    assert.equal(await runner(model).process(id, {}), 'wait');
    let r = await run(id);
    assert.deepEqual([r.status, r.attempts, r.failure_code, r.failure_detail], ['queued', 1, null, WAITING_FOR_PLACE]);
    assert.deepEqual(await entries(id), [], 'nothing is reserved while waiting');
    assert.equal(model.calls.length, 0);

    // Still no place: the resumed job waits again without using an attempt.
    assert.equal(await runner(model).process(id, { resume: 1 }), 'wait');
    assert.equal((await run(id)).attempts, 1);

    await pool.query(`UPDATE ai_call_slots SET holder = NULL, leased_until = NULL`);
    assert.equal(await runner(model).process(id, { resume: 1 }), 'succeeded');
    r = await run(id);
    assert.deepEqual([r.status, r.attempts, r.failure_detail], ['succeeded', 1, null]);
    assert.deepEqual((await entries(id)).map((e) => [e.attempt_no, e.status]), [[1, 'confirmed']]);

    // A job that is not a resume (or resumes a number already passed) counts a new attempt.
    const other = await newRun();
    await pool.query(`UPDATE extraction_runs SET attempts = 2 WHERE id = $1`, [other]);
    assert.equal(await runner(model).process(other, { resume: 1 }), 'succeeded');
    assert.equal((await run(other)).attempts, 3);
  });

  test('a sweep clash still uses an attempt and the next attempt starts on the first eligible connection', async () => {
    const [first, second] = [await aiReady(pool, projectId, { modelId: 'model-1' }), await aiReady(pool, projectId, { modelId: 'model-2' })];
    const secret = 'Zq7vault-Hinge88';
    const other = await addSource(`The boiler code is ${secret}.`);
    const reporter = standaloneCases(pool, clock.now);
    const model = new Extractor(async (modelId, n) => {
      if (modelId === 'model-1' && n === 1) timeout();
      // Attempt 2 answers, but a report elsewhere in the project moves the sweep marker while the call is out.
      if (n === 2) await reporter.report('kainow', { projectId, kind: 'source', id: other.sourceId, marked: [secret], reason: null });
    });
    const id = await newRun();
    assert.equal(await runner(model).process(id, {}), 'retry', 'attempt 1: an outage');
    assert.equal(await runner(model).process(id, {}), 'retry', 'attempt 2: answered, but swept while out, so nothing saved');
    assert.equal((await run(id)).attempts, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM extraction_items WHERE run_id = $1`, [id])).rows[0].n, 0);
    assert.equal(await runner(model).process(id, {}), 'succeeded');
    assert.deepEqual(model.calls, ['model-1', 'model-2', 'model-1']);
    assert.deepEqual((await entries(id)).map((e) => [e.attempt_no, e.connection_id, e.status]), [
      [1, first, 'uncertain'],
      [2, second, 'confirmed'],
      [3, first, 'confirmed'],
    ]);
    assert.equal((await run(id)).attempts, 3);
  });

  test('the runner saves model_id of the fallback that answered', async () => {
    await aiReady(pool, projectId, { modelId: 'model-1' });
    await aiReady(pool, projectId, { modelId: 'model-2' });
    const model = new Extractor((modelId) => (modelId === 'model-1' ? timeout() : undefined));
    const id = await newRun();
    assert.equal(await runner(model).process(id, {}), 'retry');
    assert.equal(await runner(model).process(id, {}), 'succeeded');
    const r = await run(id);
    assert.deepEqual([r.status, r.attempts, r.model_id], ['succeeded', 2, 'model-2']);
    const audit = (await pool.query(`SELECT detail FROM audit_events WHERE action = 'extraction.finished' AND subject_id = $1`, [id])).rows[0].detail;
    assert.equal(audit.modelId, 'model-2');
  });

  test('lowering the attempts ends the next attempt as attempts_used, sending nothing', async () => {
    await aiReady(pool, projectId);
    const model = new Extractor((_m, n) => (n === 1 ? timeout() : undefined));
    const id = await newRun();
    assert.equal(await runner(model).process(id, {}), 'retry');
    await pool.query(`UPDATE project_ai_limits SET max_attempts = 1 WHERE project_id = $1`, [projectId]);
    assert.equal(await runner(model).process(id, {}), 'failed');
    const r = await run(id);
    assert.deepEqual([r.status, r.failure_code, r.attempts], ['failed', 'attempts_used', 2]);
    assert.equal(model.calls.length, 1);
  });
});
