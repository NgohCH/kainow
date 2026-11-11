import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp } from '../bootstrap';
import { loadConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedWorkingProject } from '../testing/projects';
import { CaptureSender, FakeClock, testEnv } from '../testing/fakes';
import { QUEUES, startQueues } from '../worker/queues';
import { registerAiWorker } from '../worker/ai-worker';
import { UsersService } from '../users/users.service';
import type { ModelClient, ModelRequest, ModelResult } from './model';
import type { ExtractionQueue } from './queue';
import { ExtractionRunner } from './runner';

const EMAIL = 'admin@example.org';
const USAGE = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 };
const ITEM = { kind: 'decision' as const, text: 'Ship Friday', owner: null, due: null, due_event: null, alternatives: [], source_quote: 'We agreed to ship on Friday.' };

describe('extraction over HTTP', { skip: SKIP_NO_DB }, () => {
  let projectId: string;
  let app: INestApplication;
  let pool: Pool;
  let base: string;
  let cookie: string;
  let csrf: string;
  let userId: string;
  let clock: FakeClock;
  let queued: string[];
  let queueFails: boolean;

  const queue: ExtractionQueue = {
    async enqueue(runId) {
      if (queueFails) throw new Error('queue down');
      queued.push(runId);
    },
  };

  async function start(extractionQueue: ExtractionQueue): Promise<void> {
    const sender = new CaptureSender();
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    const config = loadConfig(testEnv(testDatabaseUrl() as string));
    pool = new Pool({ connectionString: config.databaseUrl });
    await resetPublicSchema(pool);
    await runMigrations(pool, config.migrationsDir);
    userId = (await new UsersService(pool, clock.now).create({ email: EMAIL, displayName: 'Admin' })).id;
    await new SpendSettingsService(pool, clock.now).apply(MVP_SPEND_SETTINGS, userId);
    app = await createApp(config, { codeSender: sender, clock: clock.now, logger: false, extractionQueue });
    await app.listen(0);
    base = await app.getUrl();
    await fetch(`${base}/auth/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
    const verify = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, code: sender.lastCode(EMAIL) }),
    });
    cookie = (verify.headers.getSetCookie()[0] ?? '').split(';')[0];
    csrf = ((await verify.json()) as { csrfToken: string }).csrfToken;
    projectId = await seedWorkingProject(pool, (await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])).rows[0].id);
  }

  async function api(method: string, path: string, body?: unknown, signedIn = true): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(signedIn ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  async function note(text = 'We agreed to ship on Friday.\nAli will email Sam.'): Promise<string> {
    return (await api('POST', `/projects/${projectId}/notes`, { title: 'T', text })).body.source.id;
  }

  afterEach(async () => {
    await app?.close();
    await pool?.end();
  });

  describe('with a stand-in queue', () => {
    beforeEach(async () => {
      queued = [];
      queueFails = false;
      await start(queue);
    });

    test('every route needs a signed-in person', async () => {
      const id = '0197c3a0-0000-7000-8000-000000000000';
      assert.equal((await api('POST', `/notes/${id}/versions/1/extractions`, undefined, false)).status, 401);
      assert.equal((await api('GET', `/notes/${id}/versions/1/extractions`, undefined, false)).status, 401);
      assert.equal((await api('GET', `/extractions/${id}`, undefined, false)).status, 401);
    });

    test('starting an extraction records a queued run and hands it to the queue', async () => {
      const id = await note();
      const r = await api('POST', `/notes/${id}/versions/1/extractions`);
      assert.equal(r.status, 202);
      assert.equal(r.body.run.status, 'queued');
      assert.deepEqual(r.body.items, []);
      assert.deepEqual(queued, [r.body.run.id]);
      const { rows } = await pool.query("SELECT detail FROM audit_events WHERE action = 'extraction.requested'");
      assert.equal(rows.length, 1);
      assert.equal((await api('GET', `/extractions/${r.body.run.id}`)).body.run.status, 'queued');
      assert.equal((await api('GET', `/notes/${id}/versions/1/extractions`)).body.runs.length, 1);
    });

    test('a second request for the same version while one is waiting or running is refused', async () => {
      const id = await note();
      assert.equal((await api('POST', `/notes/${id}/versions/1/extractions`)).status, 202);
      assert.equal((await api('POST', `/notes/${id}/versions/1/extractions`)).status, 409);
      assert.equal(queued.length, 1);
      await pool.query("UPDATE extraction_runs SET status = 'failed', failure_code = 'x'");
      assert.equal((await api('POST', `/notes/${id}/versions/1/extractions`)).status, 202, 'allowed again once the first has finished');
    });

    test('different versions of the same notes can be extracted separately', async () => {
      const id = await note();
      await api('POST', `/notes/${id}/versions`, { text: 'A new version.' });
      assert.equal((await api('POST', `/notes/${id}/versions/1/extractions`)).status, 202);
      assert.equal((await api('POST', `/notes/${id}/versions/2/extractions`)).status, 202);
    });

    test('unknown notes, versions and malformed ids are a 404', async () => {
      const id = await note();
      assert.equal((await api('POST', `/notes/${id}/versions/9/extractions`)).status, 404);
      assert.equal((await api('POST', '/notes/0197c3a0-0000-7000-8000-000000000000/versions/1/extractions')).status, 404);
      assert.equal((await api('POST', '/notes/nope/versions/1/extractions')).status, 404);
      assert.equal((await api('GET', '/extractions/nope')).status, 404);
      assert.equal((await api('GET', '/extractions/0197c3a0-0000-7000-8000-000000000000')).status, 404);
      assert.equal(queued.length, 0);
    });

    test('if the queue is down the run is marked failed, says so, and can be asked for again', async () => {
      const id = await note();
      queueFails = true;
      assert.equal((await api('POST', `/notes/${id}/versions/1/extractions`)).status, 503);
      const runs = (await api('GET', `/notes/${id}/versions/1/extractions`)).body.runs;
      assert.equal(runs[0].status, 'failed');
      assert.equal(runs[0].failureCode, 'queue_unavailable');
      queueFails = false;
      assert.equal((await api('POST', `/notes/${id}/versions/1/extractions`)).status, 202);
    });
  });

  describe('end to end with the worker and a stand-in model', () => {
    const SCHEMA = 'pgboss_e2e';
    let boss: Awaited<ReturnType<typeof startQueues>>;
    let inFlight = 0;
    let maxInFlight = 0;
    let delayMs = 0;

    const model: ModelClient = {
      async extract(_req: ModelRequest): Promise<ModelResult> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, delayMs));
        inFlight--;
        return { meetingDate: null, items: [ITEM], usage: USAGE };
      },
    };

    beforeEach(async () => {
      inFlight = 0;
      maxInFlight = 0;
      delayMs = 0;
      const admin = new Pool({ connectionString: testDatabaseUrl() });
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.end();
      boss = await startQueues(testDatabaseUrl() as string, SCHEMA);
      await start({ enqueue: async (runId) => void (await boss.send(QUEUES.ai, { runId })) });
      const runner = new ExtractionRunner({ pool, spend: new SpendService(pool, clock.now), model, clock: clock.now });
      await registerAiWorker(boss, runner, pool);
    });
    afterEach(async () => {
      await boss.stop({ graceful: true, timeout: 5000 });
    });

    async function waitFor(runId: string, done: (s: string) => boolean): Promise<any> {
      for (let i = 0; i < 100; i++) {
        const r = (await api('GET', `/extractions/${runId}`)).body;
        if (done(r.run.status)) return r;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error('timed out waiting for the run');
    }

    test('a run goes from queued to succeeded with located, source-linked proposals and a settled cost', async () => {
      const id = await note();
      const started = await api('POST', `/notes/${id}/versions/1/extractions`);
      const done = await waitFor(started.body.run.id, (s) => s === 'succeeded');
      assert.equal(done.items.length, 1);
      const item = done.items[0];
      assert.equal(item.quoteStart, 0);
      assert.equal(item.quoteEnd, 'We agreed to ship on Friday.'.length);
      assert.equal(item.reviewStatus, 'pending');
      const spend = (await api('GET', '/ai/spend')).body;
      assert.equal(spend.month.usedMyr, '0.164000');
    });

    test('no more than two AI requests run at the same moment', async () => {
      delayMs = 300;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const nid = await note(`We agreed to ship on Friday. Note number ${i}`);
        ids.push((await api('POST', `/notes/${nid}/versions/1/extractions`)).body.run.id);
      }
      for (const runId of ids) await waitFor(runId, (s) => s === 'succeeded');
      assert.equal(maxInFlight, 2);
    });
  });
});
