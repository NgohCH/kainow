import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { PgBoss } from 'pg-boss';
import { AnalysisRunner } from '../analysis/analysis-runner';
import { insertRun } from '../analysis/runs';
import type { AnalysisJob } from '../analysis/queue';
import { ExtractionRunner } from '../extraction/runner';
import type { ModelClient, ModelResult } from '../extraction/model';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { Pool } from 'pg';
import { AssistRunner } from '../assist/assist-runner';
import { findMaterial } from '../assist/material';
import { enqueueAssist } from '../assist/queue';
import { createRequest } from '../assist/requests';
import { buildTerms } from '../assist/terms';
import { ProjectAccess } from '../projects/access.service';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { uuidv7 } from '../common/uuid7';
import { loadWorkerConfig } from '../config';
import { JOB_OPTIONS, type ExtractionJob } from '../extraction/queue';
import { ModelCallError } from '../extraction/model';
import { WAITING_FOR_PLACE } from '../ai/guarded-call';
import { aiDeps, aiReady } from '../testing/ai-runners';
import { AI_CONCURRENCY, registerAiWorker } from './ai-worker';
import { POLICY_BOUNDS } from '../ai/policy';
import { QUEUES, startQueues } from './queues';

describe('ai worker dispatch', { skip: SKIP_NO_DB }, () => {
  const SCHEMA = 'pgboss_ai_dispatch';
  let t: TestApp;
  let boss: PgBoss;

  beforeEach(async () => {
    t = await startTestApp();
    const admin = new Pool({ connectionString: testDatabaseUrl() });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
    boss = await startQueues(testDatabaseUrl() as string, SCHEMA);
  });
  afterEach(async () => {
    await boss.stop({ graceful: true, timeout: 5000 });
    await t.close();
  });

  test('a job with analysisRunId goes to the analysis runner and ends the analysis run', async () => {
    const [admin, ada] = [await seedUser(t.pool, 'admin@example.org'), await seedUser(t.pool, 'ada@example.org')];
    const project = await seedProject(t.pool, { status: 'active', members: [{ userId: ada, role: 'pm' }, { userId: ada, role: 'owner' }, { userId: admin, role: 'member' }] });
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, admin);
    const client = await t.signIn('ada@example.org');
    const thread = (await client.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plan' })).body.id as string;
    assert.equal((await client.request('POST', `/threads/${thread}/messages`, { body: 'We decided to ship on Friday.' })).status, 201);

    const model: ModelClient = {
      async extract(): Promise<ModelResult> {
        return { meetingDate: null, items: [{ kind: 'decision', text: 'Ship', owner: null, due: null, due_event: null, alternatives: [], source_quote: 'ship on Friday' }], usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 } };
      },
    };
    await aiReady(t.pool, project);
    const extraction = new ExtractionRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(model), clock: t.clock.now });
    await registerAiWorker(boss, { extraction, analysis: new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction }) }, t.pool);

    const runId = await insertRun(t.pool, { threadId: thread, kind: 'proposals', trigger: 'button', requestedBy: ada, coversFromNo: 1, coversThroughNo: null, at: t.clock.now() });
    await boss.send(QUEUES.ai, { analysisRunId: runId } satisfies AnalysisJob);
    let status = '';
    for (let i = 0; i < 100 && status !== 'succeeded'; i++) {
      status = (await t.pool.query(`SELECT status FROM analysis_runs WHERE id = $1`, [runId])).rows[0].status;
      if (status !== 'succeeded') await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(status, 'succeeded');
    const items = (await t.pool.query(`SELECT count(*)::int AS n FROM extraction_items i JOIN analysis_runs a ON a.extraction_run_id = i.run_id WHERE a.id = $1`, [runId])).rows[0].n;
    assert.equal(items, 1);
  });

  test('a job with assistRequestId goes to the assist runner and answers the question', async () => {
    const [admin, ada] = [await seedUser(t.pool, 'admin@example.org'), await seedUser(t.pool, 'ada@example.org')];
    const project = await seedProject(t.pool, { status: 'active', members: [{ userId: ada, role: 'pm' }, { userId: ada, role: 'owner' }, { userId: admin, role: 'member' }] });
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, admin);
    const client = await t.signIn('ada@example.org');
    assert.equal((await client.request('POST', `/projects/${project}/notes`, { title: 'Plant', text: 'The pump service is on Thursday.' })).status, 201);
    const ctx = await t.app.get(ProjectAccess).load(project, { id: ada, email: 'ada@example.org', displayName: 'ada', role: 'member' });
    assert.ok(ctx);
    const material = await findMaterial(t.pool, { kind: 'personal', ctx }, buildTerms('pump service'));
    const id = await createRequest(t.pool, { projectId: project, kind: 'question', requestedBy: ada, scope: 'personal', material, at: t.clock.now() });
    await t.pool.query(`INSERT INTO ai_answers (request_id, project_id, question) VALUES ($1, $2, 'When is the pump service?')`, [id, project]);

    const usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 };
    const model = { callJson: async () => ({ content: JSON.stringify({ answer_markdown: 'Thursday [P1].', not_found: false, cited: ['P1'] }), usage }) };
    await aiReady(t.pool, project);
    const extraction = new ExtractionRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(null), clock: t.clock.now });
    const assist = new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(model), clock: t.clock.now });
    await registerAiWorker(boss, { extraction, analysis: new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction }), assist }, t.pool);

    await enqueueAssist(boss, id);
    let status = '';
    for (let i = 0; i < 100 && status !== 'succeeded'; i++) {
      status = (await t.pool.query(`SELECT status FROM ai_requests WHERE id = $1`, [id])).rows[0].status;
      if (status !== 'succeeded') await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(status, 'succeeded');
    assert.equal((await t.pool.query(`SELECT answer_markdown FROM ai_answers WHERE request_id = $1`, [id])).rows[0].answer_markdown, 'Thursday [P1].');
  });
  /** An Active project ready for AI with one queued extraction run on a short note; returns the run id. */
  async function queuedExtraction(): Promise<string> {
    const pm = await seedUser(t.pool, 'pm@example.org');
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, pm);
    const project = await seedProject(t.pool, { status: 'active', members: [{ userId: pm, role: 'pm' }, { userId: pm, role: 'owner' }] });
    await aiReady(t.pool, project);
    const sourceId = uuidv7();
    await t.pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'Notes', $2, $3, $4)`, [sourceId, pm, t.clock.now(), project]);
    const versionId = uuidv7();
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'paste', 'We agreed to ship on Friday.', 'x', 28, $3, $4)`,
      [versionId, sourceId, pm, t.clock.now()],
    );
    const runId = uuidv7();
    await t.pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'queued', $4)`, [runId, versionId, pm, t.clock.now()]);
    return runId;
  }
  const jobsOf = async (runId: string) =>
    (
      await t.pool.query(
        `SELECT id, data, state, singleton_key AS "singletonKey", retry_limit AS "retryLimit", priority,
                extract(epoch FROM start_after - created_on)::int AS delay
           FROM ${SCHEMA}.job WHERE name = $1 AND singleton_key = $2 ORDER BY created_on, id`,
        [QUEUES.ai, runId],
      )
    ).rows;
  async function until(what: string, check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`timed out waiting for ${what}`);
  }
  const extracted = { meetingDate: null, items: [], usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 } };

  test('wait: the job is sent again with resume and the same singletonKey, completes, and the run stays queued', async () => {
    const runId = await queuedExtraction();
    let calls = 0;
    const model = { extract: async () => (calls++, extracted) };
    const extraction = new ExtractionRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(model), clock: t.clock.now, slotWait: { maxWaitMs: 0 } });
    await registerAiWorker(boss, { extraction, analysis: new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction }) }, t.pool);
    await t.pool.query(`UPDATE ai_call_slots SET holder = 'someone-else:1', leased_until = now() + interval '1 hour'`);

    await boss.send(QUEUES.ai, { runId } satisfies ExtractionJob, { ...JOB_OPTIONS, singletonKey: runId, priority: 10 });
    await until('the job to be sent again', async () => {
      const jobs = await jobsOf(runId);
      return jobs.length === 2 && jobs[0].state === 'completed';
    });
    const [first, again] = await jobsOf(runId);
    assert.equal(first.state, 'completed', 'the waiting job completes; it is not failed or retried');
    assert.deepEqual(again.data, { runId, resume: 1 });
    assert.deepEqual([again.state, again.singletonKey, again.retryLimit, again.priority], ['created', runId, JOB_OPTIONS.retryLimit, 10]);
    assert.ok(again.delay >= 29 && again.delay <= 31, `starts about 30 s later (${again.delay})`);
    const r = (await t.pool.query(`SELECT status, attempts, failure_detail FROM extraction_runs WHERE id = $1`, [runId])).rows[0];
    assert.deepEqual([r.status, r.attempts, r.failure_detail], ['queued', 1, WAITING_FOR_PLACE]);
    assert.equal(calls, 0);

    // A place frees up and the resumed job runs as the same attempt.
    await t.pool.query(`UPDATE ai_call_slots SET holder = NULL, leased_until = NULL`);
    await t.pool.query(`UPDATE ${SCHEMA}.job SET start_after = now() WHERE id = $1`, [again.id]);
    await until('the run to succeed', async () => (await t.pool.query(`SELECT status FROM extraction_runs WHERE id = $1`, [runId])).rows[0].status === 'succeeded');
    assert.equal((await t.pool.query(`SELECT attempts FROM extraction_runs WHERE id = $1`, [runId])).rows[0].attempts, 1);
    assert.deepEqual((await t.pool.query(`SELECT attempt_no FROM ai_spend_entries WHERE request_id = $1`, [runId])).rows, [{ attempt_no: 1 }]);
  });

  test('a resumed attempt that ends retry is retried by pg-boss as the next attempt, on the next connection (final review I1)', async () => {
    const runId = await queuedExtraction();
    const project = (
      await t.pool.query(`SELECT s.project_id FROM extraction_runs r JOIN source_versions v ON v.id = r.source_version_id JOIN sources s ON s.id = v.source_id WHERE r.id = $1`, [runId])
    ).rows[0].project_id as string;
    const first = (await t.pool.query(`SELECT id FROM ai_connections WHERE project_id = $1`, [project])).rows[0].id as string;
    const second = await aiReady(t.pool, project, { modelId: 'model-2' });
    const calls: string[] = [];
    const model = {
      async extract(req: { modelId: string }) {
        calls.push(req.modelId);
        if (calls.length === 1) throw new ModelCallError('The AI request timed out', 'unknown', true);
        return extracted;
      },
    };
    const extraction = new ExtractionRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(model), clock: t.clock.now, slotWait: { maxWaitMs: 0 } });
    await registerAiWorker(boss, { extraction, analysis: new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction }) }, t.pool);
    await t.pool.query(`UPDATE ai_call_slots SET holder = 'someone-else:1', leased_until = now() + interval '1 hour'`);

    await boss.send(QUEUES.ai, { runId } satisfies ExtractionJob, { ...JOB_OPTIONS, singletonKey: runId });
    await until('the job to be sent again', async () => {
      const jobs = await jobsOf(runId);
      return jobs.length === 2 && jobs[0].state === 'completed';
    });
    const again = (await jobsOf(runId))[1];
    assert.deepEqual(again.data, { runId, resume: 1 });

    // A place frees up; the resumed attempt 1 times out, so pg-boss retries the same job (still carrying resume: 1).
    await t.pool.query(`UPDATE ai_call_slots SET holder = NULL, leased_until = NULL`);
    await t.pool.query(`UPDATE ${SCHEMA}.job SET start_after = now() WHERE id = $1`, [again.id]);
    await until('pg-boss to schedule its retry', async () => (await jobsOf(runId))[1].state === 'retry');
    await t.pool.query(`UPDATE ${SCHEMA}.job SET start_after = now() WHERE id = $1`, [again.id]);
    await until('the run to end', async () => !['queued', 'running'].includes((await t.pool.query(`SELECT status FROM extraction_runs WHERE id = $1`, [runId])).rows[0].status));

    const r = (await t.pool.query(`SELECT status, attempts, failure_code FROM extraction_runs WHERE id = $1`, [runId])).rows[0];
    assert.deepEqual([r.status, r.attempts, r.failure_code], ['succeeded', 2, null]);
    assert.deepEqual(calls, ['gpt-6.1-sol', 'model-2'], 'the retry falls back to the next connection');
    assert.deepEqual(
      (await t.pool.query(`SELECT attempt_no, connection_id, status FROM ai_spend_entries WHERE request_id = $1 ORDER BY attempt_no`, [runId])).rows.map((e) => [e.attempt_no, e.connection_id, e.status]),
      [
        [1, first, 'uncertain'],
        [2, second, 'confirmed'],
      ],
    );
  });

  test('a retry on the final pg-boss retry is sent again, so the run is not left queued', async () => {
    const runId = await queuedExtraction();
    let calls = 0;
    const model = {
      async extract() {
        if (++calls === 1) throw new ModelCallError('The AI request timed out', 'unknown', true);
        return extracted;
      },
    };
    const extraction = new ExtractionRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(model), clock: t.clock.now });
    await registerAiWorker(boss, { extraction, analysis: new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction }) }, t.pool);
    // pg-boss treats this first try as its last (an older job, or one whose retries went on errors before the claim).
    await boss.send(QUEUES.ai, { runId } satisfies ExtractionJob, { ...JOB_OPTIONS, retryLimit: 0, singletonKey: runId });
    await until('the job to be sent again', async () => (await jobsOf(runId)).length === 2);
    const [first, again] = await jobsOf(runId);
    assert.equal(first.state, 'completed');
    assert.deepEqual([again.data, again.state, again.retryLimit], [{ runId }, 'created', JOB_OPTIONS.retryLimit]);
    assert.equal((await t.pool.query(`SELECT status FROM extraction_runs WHERE id = $1`, [runId])).rows[0].status, 'queued');

    await t.pool.query(`UPDATE ${SCHEMA}.job SET start_after = now() WHERE id = $1`, [again.id]);
    await until('the run to succeed', async () => (await t.pool.query(`SELECT status FROM extraction_runs WHERE id = $1`, [runId])).rows[0].status === 'succeeded');
    assert.equal((await t.pool.query(`SELECT attempts FROM extraction_runs WHERE id = $1`, [runId])).rows[0].attempts, 2);
  });
});

describe('worker start', () => {
  test('worker main builds no client at start and logs no OPENAI_API_KEY warning', async () => {
    // No AI key in the worker's configuration: keys live on the project connections.
    assert.ok(!('openAiApiKey' in loadWorkerConfig({ DATABASE_URL: 'postgres://x', LOG_SIGN_IN_CODES: 'true', OPENAI_API_KEY: `sk-test-${'x'.repeat(40)}` })));
    const source = readFileSync(resolve(__dirname, '..', '..', 'src', 'worker', 'main.ts'), 'utf8');
    assert.ok(!/OpenAiModelClient|AnthropicModelClient|OPENAI_API_KEY|openAiApiKey/.test(source), 'main builds no model client and reads no AI key');
    assert.match(source, /factory: realClientFactory/);

    // Started without OPENAI_API_KEY against a database that refuses connections, it fails to start without the old warning.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none', LOG_SIGN_IN_CODES: 'true' };
    const child = spawn(process.execPath, [join(__dirname, 'main.js')], { env });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        done(c);
      });
    });
    assert.equal(code, 1, output);
    assert.match(output, /Worker failed to start/);
    assert.ok(!output.includes('OPENAI_API_KEY'), output);
  });
});

describe('ai worker concurrency (spec 6.5)', () => {
  test('pg-boss localConcurrency is the concurrency bound maximum, so the database-held AI places govern', async () => {
    const seen: Array<{ name: string; options: { localConcurrency?: number } }> = [];
    const boss = { work: async (name: string, options: { localConcurrency?: number }) => (seen.push({ name, options }), 'worker-id') } as unknown as PgBoss;
    await registerAiWorker(boss, {} as never, {} as Pool);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, QUEUES.ai);
    assert.equal(seen[0].options.localConcurrency, POLICY_BOUNDS.concurrency[1]);
    assert.equal(AI_CONCURRENCY, POLICY_BOUNDS.concurrency[1]);
  });
});
