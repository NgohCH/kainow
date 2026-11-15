import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { type JsonSchemaModel, ModelCallError, type ModelRequest } from '../extraction/model';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import type { Usage } from '../spend/cost';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { AssistRunner, registerCompletion, registerInputBuilder } from './assist-runner';
import { type MaterialItem, findMaterial } from './material';
import { QUESTION_SYSTEM, SUMMARY_SYSTEM } from './prompts';
import { createRequest, loadRequest } from './requests';
import { buildTerms } from './terms';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };

class FakeModel implements JsonSchemaModel {
  calls: Array<{ req: ModelRequest; schema: object }> = [];
  constructor(public next: (req: ModelRequest, n: number) => unknown = () => ({ answer_markdown: 'The pump is booked [P1].', not_found: false, cited: ['P1'] })) {}
  async callJson(req: ModelRequest, schema: object): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push({ req, schema });
    const out = await this.next(req, this.calls.length);
    return { content: JSON.stringify(out), usage: USAGE };
  }
}

describe('assist runner', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  const ids: Record<string, string> = {};
  let project: string;
  let spend: SpendService;

  const ctxOf = async (userId: string): Promise<ProjectContext> => {
    const ctx = await t.app.get(ProjectAccess).load(project, { id: userId, email: 'x@example.org', displayName: 'x', role: 'member' });
    assert.ok(ctx);
    return ctx;
  };
  const note = async (title: string, text: string) => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  /** A question as the questions service will store it: the request, its material, and the answer row holding the question. */
  const ask = async (question: string, opts: { by?: string; scope?: 'personal' | 'thread'; threadId?: string; material?: MaterialItem[] } = {}) => {
    const by = opts.by ?? ids.ada;
    const material = opts.material ?? (await findMaterial(t.pool, { kind: 'personal', ctx: await ctxOf(by) }, buildTerms(question)));
    const id = await createRequest(t.pool, {
      projectId: project,
      kind: 'question',
      requestedBy: by,
      scope: opts.scope ?? 'personal',
      scopeThreadId: opts.threadId,
      material,
      at: t.clock.now(),
    });
    await t.pool.query(`INSERT INTO ai_answers (request_id, project_id, question) VALUES ($1, $2, $3)`, [id, project, question]);
    return id;
  };
  const runner = (model: JsonSchemaModel | null) => new AssistRunner({ pool: t.pool, spend, model, clock: t.clock.now });
  const request = async (id: string) => (await t.pool.query(`SELECT * FROM ai_requests WHERE id = $1`, [id])).rows[0];
  const answer = async (id: string) => (await t.pool.query(`SELECT * FROM ai_answers WHERE request_id = $1`, [id])).rows[0];
  const material = async (id: string) => (await t.pool.query(`SELECT * FROM ai_request_material WHERE request_id = $1 ORDER BY ordinal`, [id])).rows;
  const entries = async () => (await t.pool.query(`SELECT * FROM ai_spend_entries ORDER BY created_at, attempt_no, id`)).rows;

  beforeEach(async () => {
    t = await startTestApp();
    for (const k of ['admin', 'pm', 'ada']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    spend = new SpendService(t.pool, t.clock.now);
    pm = await t.signIn('pm@example.org');
  });
  afterEach(async () => {
    await t.close();
  });

  test('ok settles spend under purpose question_answer charged to the requester', async () => {
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    const id = await ask('When is the pump service?');
    assert.equal((await request(id)).status, 'queued');
    const model = new FakeModel();
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');

    const r = await request(id);
    assert.deepEqual([r.status, r.attempts, r.failure_code, r.model_id], ['succeeded', 1, null, MVP_SPEND_SETTINGS.modelId]);
    assert.ok(r.started_at && r.finished_at);
    const a = await answer(id);
    assert.deepEqual([a.answer_markdown, a.not_found], ['The pump is booked [P1].', false]);
    assert.deepEqual((await material(id)).map((m) => [m.marker, m.cited, m.dropped_at_start]), [['P1', true, false]]);
    const spent = await entries();
    assert.deepEqual(spent.map((e) => [e.purpose, e.status, e.actor_user_id, e.request_id]), [['question_answer', 'confirmed', ids.ada, id]]);

    assert.equal(model.calls.length, 1);
    const { req } = model.calls[0];
    assert.equal(req.system, QUESTION_SYSTEM);
    assert.equal(req.maxOutputTokens, 1_500);
    assert.equal(req.timeoutMs, 120_000);
    assert.ok(req.user.includes('When is the pump service?'));
    assert.ok(req.user.includes('[P1] Plant room — Paragraph 1\nThe pump service is booked for Thursday morning.'), req.user);

    // A finished request is left alone.
    assert.equal(await runner(model).process(id, 2, false), 'skipped');
    assert.equal(model.calls.length, 1);
  });

  test('bad citation fails as bad_response, charged, nothing saved', async () => {
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    const id = await ask('When is the pump service?');
    const model = new FakeModel(() => ({ answer_markdown: 'Booked for Thursday [P1], paid by the client [P4].', not_found: false, cited: ['P1', 'P4'] }));
    assert.equal(await runner(model).process(id, 1, false), 'retry', 'a bad answer is retried like any bad response');
    assert.equal((await request(id)).status, 'queued');
    assert.equal(await runner(model).process(id, 3, true), 'failed');

    const r = await request(id);
    assert.deepEqual([r.status, r.failure_code, r.model_id], ['failed', 'bad_response', null]);
    assert.ok(r.failure_detail.includes('P4') && !r.failure_detail.includes('client'), r.failure_detail);
    const a = await answer(id);
    assert.deepEqual([a.answer_markdown, a.not_found], [null, false]);
    assert.ok((await material(id)).every((m) => !m.cited));
    const spent = await entries();
    assert.equal(spent.length, 2);
    assert.ok(spent.every((e) => e.purpose === 'question_answer' && e.status === 'confirmed' && e.actor_user_id === ids.ada), 'the provider did the work');
  });

  test('passage hidden after queueing is dropped at start', async () => {
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    const hidden = await note('Pump costs', 'The pump service invoice was disputed with the vendor.');
    const id = await ask('pump service');
    assert.equal((await material(id)).length, 2);
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [hidden]);

    const model = new FakeModel((req) => {
      const marker = /\[(P\d)\] Plant room/.exec(req.user)?.[1] as string;
      return { answer_markdown: `Thursday [${marker}].`, not_found: false, cited: [marker] };
    });
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');
    const user = model.calls[0].req.user;
    assert.ok(!user.includes('disputed'), 'the deleted note never reaches the AI');
    const rows = await material(id);
    const gone = rows.find((m) => m.location.startsWith('Pump costs'));
    const kept = rows.find((m) => m.location.startsWith('Plant room'));
    assert.deepEqual([gone.dropped_at_start, gone.cited, kept.dropped_at_start, kept.cited], [true, false, false, true]);
    assert.ok(!user.includes(`[${gone.marker}]`), 'its marker was not sent either');
  });

  test('all material dropped at start blocks without an AI call or spend', async () => {
    const only = await note('Pump costs', 'The pump service invoice was disputed with the vendor.');
    const id = await ask('pump service');
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [only]);
    const model = new FakeModel();
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    const r = await request(id);
    assert.deepEqual([r.status, r.failure_code], ['blocked', 'material_unavailable']);
    assert.equal(r.failure_detail, 'Nothing found for this question can be read any more, so nothing was sent to the AI.');
    assert.deepEqual((await material(id)).map((m) => m.dropped_at_start), [true]);
    assert.equal(model.calls.length, 0);
    assert.equal((await entries()).length, 0);
  });

  test('thread scope drops material the thread audience cannot read', async () => {
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    const closed = await note('Pump costs', 'The pump service invoice was disputed with the vendor.');
    const audience = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [closed])).rows[0].audience_id;
    await t.pool.query(`UPDATE audiences SET mode = 'restricted' WHERE id = $1`, [audience]);
    const r = await pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'General' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // The PM can read both notes; a thread-scope request keeps only what everyone in the thread may read.
    const mine = await findMaterial(t.pool, { kind: 'personal', ctx: await ctxOf(ids.pm) }, buildTerms('pump service'));
    assert.equal(mine.length, 2);
    const id = await ask('pump service', { by: ids.pm, scope: 'thread', threadId: r.body.id, material: mine });
    const model = new FakeModel((req) => {
      const marker = /\[(P\d)\] Plant room/.exec(req.user)?.[1] as string;
      return { answer_markdown: `Thursday [${marker}].`, not_found: false, cited: [marker] };
    });
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');
    assert.ok(!model.calls[0].req.user.includes('disputed'));
    assert.deepEqual((await material(id)).filter((m) => m.dropped_at_start).map((m) => m.location), ['Pump costs — Paragraph 1']);
  });

  test('project deferred after queueing blocks without spend', async () => {
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    const id = await ask('When is the pump service?');
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    const model = new FakeModel();
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    const r = await request(id);
    assert.deepEqual([r.status, r.failure_code, r.failure_detail], ['blocked', 'project_not_open', 'The project is no longer open, so the AI request did not run.']);
    assert.equal(model.calls.length, 0);
    assert.equal((await entries()).length, 0);
  });

  test('requester removed from project blocks without spend', async () => {
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    const id = await ask('When is the pump service?');
    await t.pool.query(`UPDATE memberships SET revoked_at = $2, revoked_by = $3 WHERE project_id = $1 AND user_id = $4`, [project, t.clock.now(), ids.pm, ids.ada]);
    const model = new FakeModel();
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    const r = await request(id);
    assert.deepEqual([r.status, r.failure_code], ['blocked', 'requester_not_allowed']);
    assert.equal(r.failure_detail, 'The person who asked can no longer read this project, so the AI request did not run.');
    assert.equal(model.calls.length, 0);
    assert.equal((await entries()).length, 0);
  });

  test('secret in assembled input blocks naming the kind', async () => {
    const key = `sk-${'a1B2c3D4e5F6g7H8i9J0'}kLmN`;
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, '2026-11-20', 'in_progress', $5, now())`,
      [uuidv7(), project, `Rotate the pump portal key ${key}`, ids.ada, ids.pm],
    );
    const id = await ask('pump portal key');
    assert.equal((await material(id)).length, 1);
    const model = new FakeModel();
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    const r = await request(id);
    assert.equal(r.failure_code, 'secret_found');
    assert.ok(r.failure_detail.includes('API secret key') && !r.failure_detail.includes(key), r.failure_detail);
    assert.equal(model.calls.length, 0);
    assert.equal((await entries()).length, 0);
  });

  test('timeout leaves the reservation uncertain and retries', async () => {
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    const id = await ask('When is the pump service?');
    const model = new FakeModel((_req, n) => {
      if (n === 1) throw new ModelCallError('The AI request timed out', 'unknown', true);
      return { answer_markdown: 'Thursday [P1].', not_found: false, cited: ['P1'] };
    });
    assert.equal(await runner(model).process(id, 1, false), 'retry');
    assert.deepEqual([(await request(id)).status, (await entries()).map((e) => e.status)], ['queued', ['uncertain']]);
    assert.equal((await answer(id)).answer_markdown, null);

    assert.equal(await runner(model).process(id, 2, false), 'succeeded');
    const spent = await entries();
    assert.deepEqual(spent.map((e) => [e.attempt_no, e.status]), [[1, 'uncertain'], [2, 'confirmed']], 'the unknown outcome stays counted');
    assert.equal((await request(id)).attempts, 2);
  });

  test('no key fails without a charge; not found is saved as an answer', async () => {
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    const id = await ask('When is the pump service?');
    assert.equal(await runner(null).process(id, 1, true), 'failed');
    assert.equal((await request(id)).failure_code, 'model_not_configured');
    assert.equal((await entries()).length, 0);

    const again = await ask('When is the pump service?');
    const model = new FakeModel(() => ({ answer_markdown: 'The passages do not say.', not_found: true, cited: [] }));
    assert.equal(await runner(model).process(again, 1, false), 'succeeded');
    assert.deepEqual([(await answer(again)).not_found, (await answer(again)).answer_markdown], [true, 'The passages do not say.']);
  });

  test('a registered kind builds its own input and completes in the same transaction', async () => {
    // Stand-ins for Task 9: the summary input is the source text, not passages.
    const seen: string[] = [];
    registerInputBuilder('summary', async (_db, req) => ({ system: SUMMARY_SYSTEM('the vendor name'), user: `Source text for ${req.id}` }));
    registerCompletion('summary', async (_db, req, output) => {
      seen.push(`${req.id}:${(output as { summary_markdown: string }).summary_markdown}`);
    });
    const id = await createRequest(t.pool, { projectId: project, kind: 'summary', requestedBy: ids.pm, scope: 'personal', material: [], at: t.clock.now() });
    const model = new FakeModel(() => ({ summary_markdown: 'The meeting agreed the schedule.', omitted_categories: ['prices'] }));
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');
    assert.deepEqual(seen, [`${id}:The meeting agreed the schedule.`]);
    const { req } = model.calls[0];
    assert.ok(req.system.includes('the vendor name') && !req.user.includes('the vendor name'), 'Leave out goes in the system part only');
    assert.equal(req.maxOutputTokens, 2_000);
    assert.deepEqual((await entries()).map((e) => [e.purpose, e.actor_user_id]), [['summary_draft', ids.pm]]);
    const loaded = await loadRequest(t.pool, id);
    assert.deepEqual([loaded?.kind, loaded?.status, loaded?.material.length], ['summary', 'succeeded', 0]);

    // A report with no builder registered fails visibly rather than guessing.
    const report = await createRequest(t.pool, { projectId: project, kind: 'report', requestedBy: ids.pm, scope: 'personal', material: [], at: t.clock.now() });
    assert.equal(await runner(model).process(report, 1, false), 'failed');
    assert.equal((await request(report)).failure_code, 'kind_not_available');
  });
});
