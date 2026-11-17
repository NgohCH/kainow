import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import type { JsonSchemaModel, ModelRequest } from '../extraction/model';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { AssistRunner } from './assist-runner';

const KEY = `sk-${'a1B2c3D4e5'.repeat(3)}`;
const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const QUESTION = 'When is the pump service?';
const NOT_FOUND = 'Nothing in this project matched your question';

class FakeModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ answer_markdown: 'The pump service is on Thursday [P1].', not_found: false, cited: ['P1'] }), usage: USAGE };
  }
}

describe('AI questions', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let closed: string;
  let pm: Client;
  let ada: Client;
  let ben: Client;
  let auditor: Client;
  let admin: Client;
  let noteId: string;
  let queued: string[];

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const ask = (c: Client, question: unknown, projectId = project) => c.request('POST', `/projects/${projectId}/questions`, { question });
  const settings = () => new SpendSettingsService(t.pool, t.clock.now);
  const run = async (id: string, model: JsonSchemaModel = new FakeModel()) =>
    new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model, clock: t.clock.now }).process(id, 1, false);
  const grant = (projectId: string, userId: string) =>
    t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), projectId, userId, ids.pm, ids.admin],
    );

  beforeEach(async () => {
    queued = [];
    t = await startTestApp(undefined, { assistQueue: { enqueue: async (id: string) => void queued.push(id) } });
    for (const k of ['pm', 'ada', 'ben', 'auditor']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    closed = await seedProject(t.pool, {
      name: 'Beta Project',
      status: 'closed',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    await grant(project, ids.auditor);
    await grant(closed, ids.auditor);
    await settings().apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, ada, ben, auditor, admin] = [
      await t.signIn('pm@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('auditor@example.org'),
      await t.signIn('admin@example.org'),
    ];
    const note = await pm.request('POST', `/projects/${project}/notes`, { title: 'Plant room', text: 'The pump service is booked for Thursday morning.' });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    noteId = note.body.source.id;
  });
  afterEach(async () => {
    await t.close();
  });

  test('member asks and sees sources at once', async () => {
    const r = await ask(ada, `  ${QUESTION} `);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const v = r.body;
    assert.equal(v.status, 'queued');
    assert.equal(v.question, QUESTION);
    assert.equal(v.answerMarkdown, null);
    assert.equal(v.unavailableReason, null);
    assert.equal(v.label, 'AI answer — check the sources');
    assert.deepEqual(v.askedBy, { id: ids.ada, displayName: 'ada' });
    assert.equal(v.askedByLabel, 'Asked by ada');
    assert.equal(v.visibility, 'private');
    assert.equal(v.sharedThreadId, null);
    assert.equal(v.model, null);
    assert.deepEqual(v.sources, [{ marker: 'P1', location: 'Plant room — Paragraph 1', href: `#/notes/${noteId}`, cited: false, dropped: false }]);
    assert.equal(v.droppedCount, 0);
    assert.deepEqual(queued, [v.id]);
    const req = (await t.pool.query(`SELECT status, scope, kind, requested_by FROM ai_requests WHERE id = $1`, [v.id])).rows[0];
    assert.deepEqual(req, { status: 'queued', scope: 'personal', kind: 'question', requested_by: ids.ada });

    // The history row carries a length and hash, never the question.
    const events = (await t.pool.query(`SELECT action, target_id, detail FROM ai_assist_events`)).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'asked');
    assert.ok(!JSON.stringify(events).includes('pump'));
    assert.equal(await count(`SELECT count(*) AS n FROM audit_events WHERE detail::text ILIKE '%pump%'`), 0);

    const got = await ada.request('GET', `/questions/${v.id}`);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.id, v.id);
    assert.equal(got.body.sources.length, 1);
    const list = await ada.request('GET', `/projects/${project}/questions`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((i: { id: string }) => i.id), [v.id]);

    // Answered: the answer, the model and the cited source first.
    assert.equal(await run(v.id), 'succeeded');
    const done = (await ada.request('GET', `/questions/${v.id}`)).body;
    assert.equal(done.status, 'answered');
    assert.equal(done.answerMarkdown, 'The pump service is on Thursday [P1].');
    assert.equal(done.model, MVP_SPEND_SETTINGS.modelId);
    assert.ok(done.answeredAt);
    assert.equal(done.sources[0].cited, true);

    // A newer question lists first.
    t.clock.advanceSeconds(60);
    const second = await ask(ada, 'Who books the pump service?');
    assert.equal(second.status, 201);
    const again = await ada.request('GET', `/projects/${project}/questions`);
    assert.deepEqual(again.body.items.map((i: { id: string }) => i.id), [second.body.id, v.id]);
  });

  test('question with no terms makes no AI call', async () => {
    for (const q of ['apa yang ada?', 'what is it?']) {
      const r = await ask(ada, q);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.status, 'not_found');
      assert.equal(r.body.notice, NOT_FOUND);
      assert.deepEqual(r.body.searchedWords, []);
      assert.deepEqual(r.body.sources, []);
    }
    const none = await ask(ada, 'zebra giraffe');
    assert.equal(none.status, 201);
    assert.equal(none.body.status, 'not_found');
    assert.equal(none.body.notice, NOT_FOUND);
    assert.deepEqual(none.body.searchedWords, ['zebra', 'giraffe']);

    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests WHERE status = 'queued'`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries`), 0);
    assert.deepEqual(queued, []);
    // Kept, finished, in the person's own list.
    const list = await ada.request('GET', `/projects/${project}/questions`);
    assert.equal(list.body.items.length, 3);
    assert.ok(list.body.items.every((i: { status: string }) => i.status === 'not_found'));
    // The runner leaves a finished request alone.
    assert.equal(await run(none.body.id), 'skipped');
  });

  test('501 characters refused', async () => {
    const r = await ask(ada, 'a'.repeat(501));
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'A question must be 1 to 500 characters.');
    assert.equal((await ask(ada, '   ')).status, 400);
    assert.equal((await ask(ada, 42)).status, 400);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests`), 0);
    assert.equal((await ask(ada, `pump ${'a'.repeat(495)}`)).status, 201);
  });

  test('secret in question refused, nothing stored', async () => {
    const r = await ask(ada, `Is the pump key ${KEY}?`);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /^Not posted: this looks like it contains .+\. Remove it and post again\.$/);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_answers`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_assist_events`), 0);
    assert.deepEqual(queued, []);
  });

  test('Audit grant holder may ask privately', async () => {
    const r = await ask(auditor, QUESTION);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.visibility, 'private');
    assert.equal(r.body.sources.length, 1);
    const req = (await t.pool.query(`SELECT scope, scope_thread_id FROM ai_requests WHERE id = $1`, [r.body.id])).rows[0];
    assert.deepEqual(req, { scope: 'personal', scope_thread_id: null });
    assert.equal((await auditor.request('GET', `/questions/${r.body.id}`)).status, 200);
    // Read-only still: the grant does not reach a Closed project.
    assert.equal((await ask(auditor, QUESTION, closed)).status, 403);
  });

  test('Administrator with no role gets 404', async () => {
    assert.equal((await ask(admin, QUESTION)).status, 404);
    assert.equal((await admin.request('GET', `/projects/${project}/questions`)).status, 404);
    const mine = await ask(ada, QUESTION);
    assert.equal((await admin.request('GET', `/questions/${mine.body.id}`)).status, 404);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests WHERE requested_by = $1`, [ids.admin]), 0);
  });

  test('asking in a Closed project refused (403)', async () => {
    const r = await ask(ada, QUESTION, closed);
    assert.equal(r.status, 403);
    assert.equal(r.body.message, 'Only people in the project can ask the AI, and not while the project is Deferred or Closed.');
    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests`), 0);
    // Reading the list stays allowed in every state.
    assert.equal((await ada.request('GET', `/projects/${closed}/questions`)).status, 200);
  });

  test('another member cannot read my private answer (404)', async () => {
    const mine = await ask(ada, QUESTION);
    assert.equal(mine.status, 201);
    assert.equal((await ben.request('GET', `/questions/${mine.body.id}`)).status, 404);
    assert.equal((await pm.request('GET', `/questions/${mine.body.id}`)).status, 404);
    assert.deepEqual((await ben.request('GET', `/projects/${project}/questions`)).body.items, []);
    assert.equal((await ben.request('GET', `/questions/not-a-uuid`)).status, 404);
    assert.equal((await ben.request('GET', `/questions/${uuidv7()}`)).status, 404);
    // A private answer withdrawn for removed material disappears, even for the requester.
    await t.pool.query(`UPDATE ai_answers SET review_state = 'withdrawn', review_reason = 'material_removed' WHERE request_id = $1`, [mine.body.id]);
    assert.equal((await ada.request('GET', `/questions/${mine.body.id}`)).status, 404);
    assert.deepEqual((await ada.request('GET', `/projects/${project}/questions`)).body.items, []);
  });

  test('answer hidden from me after my access to a cited source ends', async () => {
    // Ada reads the Restricted note only through a Deputy role that expires; the member role stays. Her role ending is
    // not an audience change, so the answer is not withdrawn: the per-viewer recheck alone hides its content.
    await t.pool.query(
      `INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on) VALUES ($1, $2, $3, 'deputy_pm', '2026-11-01', '2026-11-09')`,
      [uuidv7(), project, ids.ada],
    );
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [noteId])).rows[0].audience_id;
    const narrowed = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds: [], reason: 'Leaders only from now on' });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    const mine = await ask(ada, QUESTION);
    assert.equal(mine.body.sources.length, 1, 'the Restricted note was found through the Deputy role');
    assert.equal(await run(mine.body.id), 'succeeded');
    assert.equal((await ada.request('GET', `/questions/${mine.body.id}`)).body.answerMarkdown, 'The pump service is on Thursday [P1].');

    t.clock.advanceSeconds(2 * 24 * 3600);
    ada = await t.signIn('ada@example.org');
    const r = await ada.request('GET', `/questions/${mine.body.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.answerMarkdown, null);
    assert.equal(r.body.notice, 'This answer used information you can no longer read');
    assert.deepEqual(r.body.sources, []);
    const listed = (await ada.request('GET', `/projects/${project}/questions`)).body.items;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].answerMarkdown, null);
  });

  test('blocked by no allowance shows AI answer unavailable with the sources', async () => {
    await settings().apply({ ...MVP_SPEND_SETTINGS, userMonthly: { mode: 'limit', limitMicroMyr: 0n } }, ids.admin);
    const mine = await ask(ada, QUESTION);
    const model = new FakeModel();
    assert.equal(await run(mine.body.id, model), 'blocked');
    assert.equal(model.calls.length, 0);
    const r = (await ada.request('GET', `/questions/${mine.body.id}`)).body;
    assert.equal(r.status, 'blocked');
    assert.equal(r.answerMarkdown, null);
    assert.equal(r.unavailableReason, 'you have no personal AI allowance');
    assert.equal(r.notice, 'AI answer unavailable: you have no personal AI allowance');
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].location, 'Plant room — Paragraph 1');
  });

  test('feedback on an answer is accepted', async () => {
    const mine = await ask(ada, QUESTION);
    assert.equal(await run(mine.body.id), 'succeeded');
    const flag = (c: Client, targetKind: string, targetId: string) =>
      c.request('POST', `/projects/${project}/feedback`, { targetKind, targetId, category: 'incorrect', note: 'The service is on Friday, not Thursday.' });
    const r = await flag(ada, 'answer', mine.body.id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.targetKind, 'answer');
    // Someone who cannot see the answer finds nothing.
    assert.equal((await flag(ben, 'answer', mine.body.id)).status, 404);
    // Report and summary versions are not readable until their screens exist.
    assert.equal((await flag(ada, 'report_version', uuidv7())).status, 404);
    assert.equal((await flag(ada, 'summary_version', uuidv7())).status, 404);
    // The Administrator's escalated list names the answer's model.
    const escalated = await pm.request('POST', `/feedback/${r.body.id}/escalate`, { note: 'Please check the answer.' });
    assert.equal(escalated.status, 200, JSON.stringify(escalated.body));
    const listed = (await admin.request('GET', '/admin/feedback')).body.feedback;
    assert.deepEqual(listed.map((f: { runRef: string; model: string }) => [f.runRef, f.model]), [[mine.body.id, MVP_SPEND_SETTINGS.modelId]]);
  });
});
