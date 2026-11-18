import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { JsonSchemaModel, ModelRequest } from '../extraction/model';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { AssistRunner } from './assist-runner';
import { aiDeps, aiReady, byAttempt } from '../testing/ai-runners';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const QUESTION = 'When is the pump service?';
const ANSWER = 'The pump service is on Thursday [P1].';
const NO_LONGER = 'This answer used information you can no longer read';

class FakeModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ answer_markdown: ANSWER, not_found: false, cited: ['P1'] }), usage: USAGE };
  }
}

describe('removal of material and review of shared AI outputs', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let dep: Client;
  let ada: Client;
  let ben: Client;
  let outsider: Client;
  let thread: string;

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const run = (id: string) => byAttempt(t.pool, 'ai_requests', new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(new FakeModel()), clock: t.clock.now })).process(id, 1, false);
  const state = async (id: string) => (await t.pool.query(`SELECT review_state, review_reason FROM ai_answers WHERE request_id = $1`, [id])).rows[0];
  const reviewList = (c: Client, projectId = project) => c.request('GET', `/projects/${projectId}/assist-review`);
  const decide = (c: Client, action: 'clear' | 'withdraw', id: string, reason: unknown = 'Checked with the team', kind = 'answer') =>
    c.request('POST', `/assist-review/${kind}/${id}/${action}`, { reason });
  const moderate = (c: Client, action: 'hide' | 'unhide' | 'delete' | 'restore', messageId: string) =>
    c.request('POST', `/messages/${messageId}/${action}`, { reason: 'Posted in error' });
  const aiAnswers = async (c: Client) => {
    const r = await c.request('GET', `/threads/${thread}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.aiAnswers as Array<Record<string, unknown>>;
  };
  const myQuestions = async (c: Client) => (await c.request('GET', `/projects/${project}/questions`)).body.items as Array<{ id: string }>;
  const post = async (c: Client, body: string) => {
    const r = await c.request('POST', `/threads/${thread}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const note = async (title: string, text: string) => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  const setAudience = async (sourceId: string, mode: 'project' | 'restricted', namedUserIds: string[]) => {
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    const r = await pm.request('PUT', `/audiences/${audienceId}`, { mode, namedUserIds, reason: 'Audience review' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  /** The person asks and the AI answers. */
  const answered = async (c: Client = ada, question = QUESTION) => {
    const r = await c.request('POST', `/projects/${project}/questions`, { question });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.sources.length > 0, 'material was found');
    assert.equal(await run(r.body.id), 'succeeded');
    return r.body.id as string;
  };
  const shared = async (c: Client = ada, question = QUESTION) => {
    const id = await answered(c, question);
    const r = await c.request('POST', `/questions/${id}/share`, { threadId: thread });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return id;
  };
  const events = async (id: string) =>
    (await t.pool.query(`SELECT action, actor_id, target_kind, reason, detail FROM ai_assist_events WHERE target_id = $1 ORDER BY at, id`, [id])).rows;

  beforeEach(async () => {
    t = await startTestApp(undefined, { assistQueue: { enqueue: async () => undefined } });
    for (const k of ['pm', 'dep', 'ada', 'ben', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    await aiReady(t.pool, project);
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, dep, ada, ben, outsider] = [
      await t.signIn('pm@example.org'),
      await t.signIn('dep@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('outsider@example.org'),
    ];
    const r = await pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plant' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    thread = r.body.id;
  });
  afterEach(async () => {
    await t.close();
  });

  test('hiding a cited message withdraws a private answer completely', async () => {
    const msg = await post(ben, 'The pump service is booked for Thursday morning.');
    const id = await answered();
    assert.equal((await ada.request('GET', `/questions/${id}`)).body.answerMarkdown, ANSWER);

    assert.equal((await moderate(pm, 'hide', msg)).status, 200);
    assert.equal((await ada.request('GET', `/questions/${id}`)).status, 404, 'gone for the requester');
    assert.deepEqual(await myQuestions(ada), [], 'not in their Ask list, no placeholder');
    assert.deepEqual(await state(id), { review_state: 'withdrawn', review_reason: 'material_removed' });
    const ev = await events(id);
    assert.deepEqual(
      ev.filter((e) => e.action === 'withdrawn').map((e) => [e.actor_id, e.target_kind, e.reason, e.detail]),
      [[null, 'answer', 'material_removed', { cause: 'hidden' }]],
    );
    assert.ok(!JSON.stringify(ev).includes('pump'), 'no question or answer text in events');
    // The rows stay for history; nobody reviews a private answer.
    assert.equal(await count(`SELECT count(*) AS n FROM ai_answers WHERE request_id = $1 AND answer_markdown IS NOT NULL`, [id]), 1);
    assert.deepEqual((await reviewList(pm)).body.items, []);
  });

  test('hiding a message sends a shared answer to review, hidden from members', async () => {
    const msg = await post(ben, 'The pump service is booked for Thursday morning.');
    const id = await shared();
    assert.equal((await aiAnswers(ben)).length, 1);

    t.clock.advanceSeconds(60);
    assert.equal((await moderate(pm, 'hide', msg)).status, 200);
    assert.deepEqual(await state(id), { review_state: 'review_required', review_reason: 'material_removed' });
    // Hidden from everyone except PM and Deputy, the requester included.
    for (const c of [ada, ben]) {
      assert.deepEqual(await aiAnswers(c), []);
      assert.equal((await c.request('GET', `/questions/${id}`)).status, 404);
    }
    assert.deepEqual(await myQuestions(ada), []);
    assert.equal((await pm.request('GET', `/questions/${id}`)).status, 200);
    for (const c of [pm, dep]) {
      const r = await reviewList(c);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.items.length, 1);
      const item = r.body.items[0];
      assert.equal(item.kind, 'answer');
      assert.equal(item.id, id);
      assert.equal(item.title, QUESTION);
      assert.equal(item.reviewReason, 'material_removed');
      assert.equal(item.reason, 'Something it used was hidden.');
      assert.deepEqual(item.by, { id: ids.ada, displayName: 'ada' });
      assert.equal(item.sharedThreadId, thread);
      assert.equal(new Date(item.flaggedAt).getTime(), t.clock.now().getTime());
      assert.equal(item.href, `#/projects/${project}/threads/${thread}?answer=${id}`);
      assert.equal(item.answerMarkdown, undefined, 'no answer text in the list');
    }
    const ev = (await events(id)).filter((e) => e.action === 'review_required');
    assert.deepEqual(ev.map((e) => [e.actor_id, e.reason, e.detail]), [[null, 'material_removed', { cause: 'hidden', threadId: thread }]]);
  });

  test('PM clears it and it shows again with per-viewer rechecks', async () => {
    const plant = await note('Plant room', 'The pump service is booked for Thursday morning.');
    const id = await shared();
    await setAudience(plant, 'restricted', [ids.ada]);
    assert.equal((await state(id)).review_state, 'review_required');
    assert.deepEqual(await aiAnswers(ben), []);

    assert.equal((await decide(pm, 'clear', id, '')).status, 400, 'a reason is required');
    assert.equal((await decide(pm, 'clear', id, 'x'.repeat(501))).status, 400);
    assert.equal((await decide(pm, 'clear', id, 'Fine', 'nonsense')).status, 404);
    const r = await decide(pm, 'clear', id, 'Ada may still share this; others get the notice');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { kind: 'answer', id, reviewState: 'cleared' });
    assert.equal((await decide(pm, 'clear', id)).status, 409, 'no longer waiting for review');
    assert.deepEqual((await reviewList(pm)).body.items, []);

    // Visible again, with the per-viewer recheck: Ben can no longer read the note, Ada can.
    const forBen = (await aiAnswers(ben)).find((i) => i.id === id) as Record<string, unknown>;
    assert.equal(forBen.answerMarkdown, null);
    assert.deepEqual(forBen.sources, []);
    assert.equal(forBen.notice, NO_LONGER);
    assert.equal((await aiAnswers(ada)).find((i) => i.id === id)?.answerMarkdown, ANSWER);
    const row = (await t.pool.query(`SELECT reviewed_by, reviewed_at FROM ai_answers WHERE request_id = $1`, [id])).rows[0];
    assert.deepEqual(row, { reviewed_by: ids.pm, reviewed_at: t.clock.now() });
    const cleared = (await events(id)).filter((e) => e.action === 'cleared');
    assert.deepEqual(cleared.map((e) => [e.actor_id, e.reason]), [[ids.pm, 'Ada may still share this; others get the notice']]);

    // A cleared answer touched by a new removal goes back to review.
    await setAudience(plant, 'restricted', []);
    assert.equal((await state(id)).review_state, 'review_required');
  });

  test('withdraw keeps history', async () => {
    const msg = await post(ben, 'The pump service is booked for Thursday morning.');
    const id = await shared();
    t.clock.advanceSeconds(60);
    assert.equal((await moderate(pm, 'delete', msg)).status, 200);
    assert.equal((await reviewList(dep)).body.items[0].reason, 'Something it used was deleted.');
    t.clock.advanceSeconds(60);
    // Review works in a Deferred project too.
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    const r = await decide(dep, 'withdraw', id, 'The source was removed for good');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reviewState, 'withdrawn');
    for (const c of [pm, dep, ada, ben]) assert.equal((await c.request('GET', `/questions/${id}`)).status, 404);
    assert.deepEqual((await reviewList(pm)).body.items, []);
    assert.equal((await decide(pm, 'clear', id)).status, 404, 'withdrawn is final');
    // Kept: the row with its text, and the events in order (no text in them).
    assert.equal(await count(`SELECT count(*) AS n FROM ai_answers WHERE request_id = $1 AND answer_markdown = $2`, [id, ANSWER]), 1);
    // Events at the same instant (asked, shared) are compared without relying on their order.
    const ev = await events(id);
    const rank = (a: string) => ['asked', 'shared', 'review_required', 'withdrawn'].indexOf(a);
    assert.deepEqual(
      ev.map((e) => [e.action, e.actor_id, e.reason]).sort((a, b) => rank(a[0]) - rank(b[0])),
      [
        ['asked', ids.ada, null],
        ['shared', ids.ada, null],
        ['review_required', null, 'material_removed'],
        ['withdrawn', ids.dep, 'The source was removed for good'],
      ],
    );
    assert.ok(!JSON.stringify(ev).includes('pump'));
  });

  test("restricting a source's audience triggers review", async () => {
    const plant = await note('Plant room', 'The pump service is booked for Thursday morning.');
    const sharedId = await shared();
    const privateId = await answered(ben, 'Who books the pump service?');
    const elsewhere = await note('Canteen', 'The canteen menu changes on Monday.');
    const untouched = await answered(ben, 'When does the canteen menu change?');
    await setAudience(plant, 'restricted', [ids.ada]);
    assert.equal((await state(sharedId)).review_state, 'review_required');
    assert.equal((await state(privateId)).review_state, 'withdrawn');
    assert.equal((await state(untouched)).review_state, 'none', 'built on other material');
    assert.equal((await reviewList(pm)).body.items[0].reason, 'The audience of something it used was narrowed.');
    const causes = (await t.pool.query(`SELECT action, detail->>'cause' AS cause FROM ai_assist_events WHERE action IN ('withdrawn', 'review_required') ORDER BY action`)).rows;
    assert.deepEqual(causes, [
      { action: 'review_required', cause: 'audience_tightened' },
      { action: 'withdrawn', cause: 'audience_tightened' },
    ]);
    assert.ok(elsewhere);
  });

  test('adding named people does not', async () => {
    const plant = await note('Plant room', 'The pump service is booked for Thursday morning.');
    await setAudience(plant, 'restricted', [ids.ada]);
    const id = await answered();
    await setAudience(plant, 'restricted', [ids.ada, ids.ben]);
    await setAudience(plant, 'project', []);
    assert.deepEqual(await state(id), { review_state: 'none', review_reason: null });
    assert.equal((await ada.request('GET', `/questions/${id}`)).body.answerMarkdown, ANSWER);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_assist_events WHERE action IN ('withdrawn', 'review_required')`), 0);
    // Project-wide to Restricted is narrowing, whoever is named (removing a named person is tested above, with Clear).
    await setAudience(plant, 'restricted', [ids.ada, ids.ben]);
    assert.equal((await state(id)).review_state, 'withdrawn');
  });

  test('unhiding does not restore a withdrawn private answer', async () => {
    const msg = await post(ben, 'The pump service is booked for Thursday morning.');
    const id = await answered();
    assert.equal((await moderate(pm, 'hide', msg)).status, 200);
    assert.equal((await moderate(pm, 'unhide', msg)).status, 200);
    assert.equal((await ada.request('GET', `/questions/${id}`)).status, 404);
    assert.deepEqual(await myQuestions(ada), []);
    assert.equal((await state(id)).review_state, 'withdrawn');

    // Nor does restoring a deleted message bring a shared answer out of review.
    const other = await post(ben, 'The chiller service is booked for Friday.');
    const sharedId = await shared(ada, 'When is the chiller service?');
    assert.equal((await moderate(pm, 'delete', other)).status, 200);
    assert.equal((await moderate(pm, 'restore', other)).status, 200);
    assert.equal((await state(sharedId)).review_state, 'review_required');
    assert.deepEqual(await aiAnswers(ben), []);
  });

  test('Member cannot open the review list (403)', async () => {
    const msg = await post(ben, 'The pump service is booked for Thursday morning.');
    const visible = await shared(ada, 'Who booked the pump service?');
    const r = await reviewList(ben);
    assert.equal(r.status, 403);
    assert.equal(r.body.message, 'Only the Project Manager or a Deputy can hide, clear or withdraw AI output.');
    assert.equal((await reviewList(outsider)).status, 404, 'outside the project it does not exist');
    // A Member acting on an answer they can see is refused (403); on one in review they find nothing (404).
    assert.equal((await decide(ada, 'clear', visible)).status, 403);
    assert.equal((await moderate(pm, 'hide', msg)).status, 200);
    assert.equal((await decide(ada, 'withdraw', visible)).status, 404);
    assert.equal((await decide(ben, 'clear', visible)).status, 404);
    assert.equal((await decide(outsider, 'clear', visible)).status, 404);
    assert.equal((await state(visible)).review_state, 'review_required');
  });

  test('PM never sees private questions in the review list', async () => {
    await post(ben, 'The pump service is booked for Thursday morning.');
    const mine = await answered();
    const theirs = await answered(ben, 'Who books the pump service?');
    // Even a private answer marked for review by mistake is not listed and cannot be acted on.
    await t.pool.query(`UPDATE ai_answers SET review_state = 'review_required', review_reason = 'material_removed' WHERE request_id = $1`, [mine]);
    for (const c of [pm, dep]) {
      const r = await reviewList(c);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items, []);
      assert.equal((await decide(c, 'clear', mine)).status, 404);
      assert.equal((await decide(c, 'withdraw', theirs)).status, 404);
    }
    assert.equal((await state(theirs)).review_state, 'none');
  });
});
