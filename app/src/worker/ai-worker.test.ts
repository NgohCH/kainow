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
import { registerAiWorker } from './ai-worker';
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
    const extraction = new ExtractionRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model, clock: t.clock.now });
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
    const extraction = new ExtractionRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model: null, clock: t.clock.now });
    const assist = new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model, clock: t.clock.now });
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
});
