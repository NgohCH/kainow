import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { AssistRunner, registerCompletion, registerInputBuilder } from '../assist/assist-runner';
import type { MaterialItem } from '../assist/material';
import { createRequest } from '../assist/requests';
import { ModelCallError, type ModelRequest, type ModelResult } from '../extraction/model';
import { ExtractionRunner } from '../extraction/runner';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { aiDeps, aiReady } from '../testing/ai-runners';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { FakeClock } from '../testing/fakes';
import { seedProject, seedUser } from '../testing/projects';

const USAGE = { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100 };
const NOT_FOR_RESTRICTED = (noun: string) => `No AI connection in this project is approved for ${noun} with restricted material and usable now.`;

/** An extraction model that records the model of every call; `fail` decides per model id whether the call times out. */
class Extractor {
  calls: string[] = [];
  constructor(private readonly fail: (modelId: string) => boolean = () => false) {}
  async extract(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req.modelId);
    if (this.fail(req.modelId)) throw new ModelCallError('The AI request timed out', 'unknown', true);
    return { meetingDate: null, items: [], usage: USAGE };
  }
}

describe('restricted material (spec 6.3)', { skip: SKIP_NO_DB }, () => {
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

  async function audience(mode: 'project' | 'restricted'): Promise<string> {
    const id = uuidv7();
    await pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, $3, $4)`, [id, projectId, mode, clock.now()]);
    return id;
  }

  async function thread(mode: 'project' | 'restricted'): Promise<{ id: string; audienceId: string }> {
    const audienceId = await audience(mode);
    const id = uuidv7();
    await pool.query(
      `INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, created_by, created_at) VALUES ($1, $2, 'discussion', 'Plan', $3, $4, $5)`,
      [id, projectId, audienceId, pm, clock.now()],
    );
    return { id, audienceId };
  }

  /** A source with one version; returns the source, its version and its audience. */
  async function source(o: { mode?: 'project' | 'restricted'; intendedMode?: 'restricted'; threadId?: string; text?: string } = {}) {
    const audienceId = await audience(o.mode ?? 'project');
    const sourceId = uuidv7();
    await pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id, intended_mode) VALUES ($1, 'Notes', $2, $3, $4, $5, $6, $7, $8)`,
      [sourceId, pm, clock.now(), projectId, o.threadId ? 'discussion' : 'notes', audienceId, o.threadId ?? null, o.intendedMode ?? null],
    );
    const versionId = uuidv7();
    const text = o.text ?? 'We agreed to ship on Friday.';
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, $3, $4, 'x', $5, $6, $7)`,
      [versionId, sourceId, o.threadId ? 'discussion' : 'paste', text, text.length, pm, clock.now()],
    );
    return { sourceId, versionId, audienceId };
  }

  async function extractionRun(versionId: string, trigger: 'request' | 'discussion' = 'request'): Promise<string> {
    const id = uuidv7();
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at, trigger) VALUES ($1, $2, $3, 'queued', $4, $5)`, [
      id,
      versionId,
      pm,
      clock.now(),
      trigger,
    ]);
    return id;
  }

  const extraction = (model: object) => new ExtractionRunner({ pool, spend, ...aiDeps(model), clock: clock.now });
  const run = async (id: string) => (await pool.query(`SELECT * FROM extraction_runs WHERE id = $1`, [id])).rows[0];
  const entries = async (id: string) => (await pool.query(`SELECT * FROM ai_spend_entries WHERE request_id = $1 ORDER BY attempt_no`, [id])).rows;

  test('extraction of a restricted source passes carriesRestricted true', async () => {
    await aiReady(pool, projectId, { modelId: 'model-open', restrictedOk: false });
    const model = new Extractor();

    // Project-wide material may use a connection that is not approved for restricted material.
    const open = await extractionRun((await source()).versionId);
    assert.equal(await extraction(model).process(open, {}), 'succeeded');

    // A Restricted audience, or a note submitted to be Restricted, may not.
    for (const s of [await source({ mode: 'restricted' }), await source({ intendedMode: 'restricted' })]) {
      const id = await extractionRun(s.versionId);
      assert.equal(await extraction(model).process(id, {}), 'blocked');
      const r = await run(id);
      assert.deepEqual([r.failure_code, r.failure_detail], ['no_eligible_connection', NOT_FOR_RESTRICTED('extraction')]);
      assert.deepEqual(await entries(id), []);
    }
    assert.deepEqual(model.calls, ['model-open']);
  });

  test('transcript of a restricted discussion thread passes true', async () => {
    await aiReady(pool, projectId, { modelId: 'model-open', restrictedOk: false });
    const model = new Extractor();
    // The transcript's own audience row is Project-wide; the thread was narrowed to Restricted after it was stored.
    const narrowed = await thread('restricted');
    const id = await extractionRun((await source({ threadId: narrowed.id })).versionId, 'discussion');
    assert.equal(await extraction(model).process(id, {}), 'blocked');
    assert.deepEqual([(await run(id)).failure_code, (await run(id)).failure_detail], ['no_eligible_connection', NOT_FOR_RESTRICTED('analysis')]);

    // A Project-wide thread's transcript may use it.
    const open = await thread('project');
    const ok = await extractionRun((await source({ threadId: open.id })).versionId, 'discussion');
    assert.equal(await extraction(model).process(ok, {}), 'succeeded');
    assert.deepEqual(model.calls, ['model-open']);
  });

  test('summary draft always passes true; a question passes true only for restricted material', async () => {
    await aiReady(pool, projectId, { modelId: 'model-open', restrictedOk: false });
    // Stand-ins for the summary kind: its input is one source's text, here plain project-wide words.
    registerInputBuilder('summary', async () => ({ system: 'Summarise.', user: 'Plain project-wide text.' }));
    registerCompletion('summary', async () => undefined);
    const calls: string[] = [];
    const model = {
      async callJson(req: ModelRequest) {
        calls.push(req.modelId);
        const content = req.system === 'Summarise.' ? { summary_markdown: 'Short.', omitted_categories: [] } : { answer_markdown: 'Friday [P1].', not_found: false, cited: ['P1'] };
        return { content: JSON.stringify(content), usage: USAGE };
      },
    };
    const assist = () => new AssistRunner({ pool, spend, ...aiDeps(model), clock: clock.now });
    const status = async (id: string) => (await pool.query(`SELECT status, failure_code, failure_detail FROM ai_requests WHERE id = $1`, [id])).rows[0];

    const summary = await createRequest(pool, { projectId, kind: 'summary', requestedBy: pm, scope: 'personal', material: [], at: clock.now() });
    assert.equal(await assist().process(summary, {}), 'blocked');
    assert.deepEqual(Object.values(await status(summary)), ['blocked', 'no_eligible_connection', NOT_FOR_RESTRICTED('summary drafting')]);

    const question = async (mode: 'project' | 'restricted') => {
      const s = await source({ mode });
      const passageId = uuidv7();
      await pool.query(
        `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body) VALUES ($1, $2, 'source_version', $3, 0, 'Notes — Paragraph 1', 0, 28, 'We agreed to ship on Friday.')`,
        [passageId, projectId, s.versionId],
      );
      const material = [{ marker: 'P1', passageId, recordKind: null, recordId: null, recordAudienceId: null, snapshot: null, location: 'Notes — Paragraph 1' }] as unknown as MaterialItem[];
      const id = await createRequest(pool, { projectId, kind: 'question', requestedBy: pm, scope: 'personal', material, at: clock.now() });
      await pool.query(`INSERT INTO ai_answers (request_id, project_id, question) VALUES ($1, $2, 'When do we ship?')`, [id, projectId]);
      return id;
    };
    const open = await question('project');
    assert.equal(await assist().process(open, {}), 'succeeded');
    const closed = await question('restricted');
    assert.equal(await assist().process(closed, {}), 'blocked');
    assert.deepEqual(Object.values(await status(closed)), ['blocked', 'no_eligible_connection', NOT_FOR_RESTRICTED('answering')]);
    assert.deepEqual(calls, ['model-open']);
  });

  test('audience turned restricted between attempts skips the unapproved connection', async () => {
    const [first, second, third] = [
      await aiReady(pool, projectId, { modelId: 'model-open-1', restrictedOk: false }),
      await aiReady(pool, projectId, { modelId: 'model-open-2', restrictedOk: false }),
      await aiReady(pool, projectId, { modelId: 'model-restricted', restrictedOk: true }),
    ];
    const model = new Extractor((m) => m === 'model-open-1');
    const s = await source();
    const id = await extractionRun(s.versionId);
    // Attempt 1: Project-wide, on the first connection, which times out (the next attempt moves on).
    assert.equal(await extraction(model).process(id, {}), 'retry');
    // While it waits for attempt 2, the source's audience is narrowed.
    await pool.query(`UPDATE audiences SET mode = 'restricted' WHERE id = $1`, [s.audienceId]);
    assert.equal(await extraction(model).process(id, {}), 'succeeded');
    // Moving on would take the second connection; it is not approved for restricted material, so the third answers.
    assert.deepEqual(model.calls, ['model-open-1', 'model-restricted']);
    assert.deepEqual((await entries(id)).map((e) => [e.attempt_no, e.connection_id]), [[1, first], [2, third]]);
    assert.notEqual(second, third);
    assert.equal((await run(id)).model_id, 'model-restricted');
  });
});
