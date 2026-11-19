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
import { uuidv7 } from '../common/uuid7';
import { NotesService } from '../notes/notes.service';
import { AssistRunner } from './assist-runner';
import { onMaterialRemoved } from './removal';
import { aiDeps, aiReady, byAttempt } from '../testing/ai-runners';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const REVIEW_LABEL = 'Access review required';
const ORIGINAL = 'Confidential board note. The turbine replacement goes ahead next month. The supplier was late again.';
const SUMMARY = 'The turbine replacement goes ahead next month.';
const QUESTION = 'What is happening with the turbine?';

class SummaryModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  constructor(private readonly body = SUMMARY) {}
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ summary_markdown: this.body, omitted_categories: [] }), usage: USAGE };
  }
}

/** Writes one narrative per requested section, citing P1. */
class ReportModel implements JsonSchemaModel {
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    const sections = [...req.user.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    return { content: JSON.stringify({ sections: sections.map((section) => ({ section, markdown: `Narrative for ${section} [P1].`, cited: ['P1'] })) }), usage: USAGE };
  }
}

const MODERATED_SINCE = 'A message this draft was built from has since been hidden or deleted. Draft the summary again before approving.';

class AnswerModel implements JsonSchemaModel {
  async callJson(): Promise<{ content: unknown; usage: Usage }> {
    return { content: JSON.stringify({ answer_markdown: 'The turbine replacement goes ahead [P1].', not_found: false, cited: ['P1'] }), usage: USAGE };
  }
}

describe('shareable summaries when the original changes', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let dep: Client;
  let spo: Client;
  let ada: Client;
  let ben: Client;
  let queued: string[];

  const run = (id: string, model: JsonSchemaModel) =>
    byAttempt(t.pool, 'ai_requests', new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), ...aiDeps(model), clock: t.clock.now })).process(id, 1, false);
  const lastRequest = () => queued[queued.length - 1];
  const state = async (id: string) => (await t.pool.query(`SELECT state, review_reason FROM summaries WHERE id = $1`, [id])).rows[0];
  const answerState = async (id: string) => (await t.pool.query(`SELECT review_state, review_reason FROM ai_answers WHERE request_id = $1`, [id])).rows[0];
  const audienceOf = async (sourceId: string) => (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id as string;
  const setAudience = async (audienceId: string, namedUserIds: string[]) => {
    const r = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds, reason: 'Board only' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const listed = async (c: Client) => ((await c.request('GET', `/projects/${project}/notes`)).body.sources as Array<{ id: string }>).map((s) => s.id);
  const searched = async (c: Client) =>
    ((await c.request('GET', `/search?q=turbine&project=${project}`)).body.projects?.[0]?.results ?? [])
      .filter((x: { kind: string }) => x.kind === 'note')
      .map((x: { id: string }) => x.id);
  const view = (c: Client, id: string) => c.request('GET', `/summaries/${id}`);
  const decide = (c: Client, action: 'confirm' | 'withdraw', id: string, reason: unknown = 'Checked with the board') =>
    c.request('POST', `/summaries/${id}/${action}`, { reason });
  const reviewNotices = async () =>
    (await t.pool.query(`SELECT user_id, summary, link, email_off FROM notifications WHERE kind = 'summary_access_review' ORDER BY user_id`)).rows;

  /** Drafted by the Deputy, every mark ticked, approved Project-wide by the PM. */
  const approve = async (request: () => Promise<{ status: number; body: { id: string } }>) => {
    const r = await request();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await run(lastRequest(), new SummaryModel()), 'succeeded');
    t.clock.advanceSeconds(1);
    const v = (await view(pm, r.body.id)).body;
    for (const m of v.current.marks) assert.equal((await pm.request('POST', `/summaries/${r.body.id}/marks/${m.id}/intended`, { versionNo: v.current.no })).status, 200);
    const a = await pm.request('POST', `/summaries/${r.body.id}/approve`, { versionNo: v.current.no, reason: 'Fine to share with the team' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    t.clock.advanceSeconds(1);
    return { id: r.body.id, sourceId: a.body.approved.sourceId as string };
  };
  /** A Restricted board note (Ada named) summarised for the whole project. */
  const approvedNote = async () => {
    const n = await pm.request('POST', `/projects/${project}/notes`, { title: 'Board note', text: ORIGINAL });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    const original = n.body.source.id as string;
    await setAudience(await audienceOf(original), [ids.ada]);
    const s = await approve(() => dep.request('POST', `/sources/${original}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' }));
    return { original, ...s };
  };
  /** A Restricted meeting (Ada named) with two messages, summarised for the whole project. */
  const approvedMeeting = async () => {
    const m = await pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Board meeting', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const messages: string[] = [];
    for (const body of ['The turbine replacement goes ahead next month.', 'The supplier was late again.']) {
      const p = await ada.request('POST', `/threads/${m.body.id}/messages`, { body });
      assert.equal(p.status, 201, JSON.stringify(p.body));
      messages.push(p.body.id);
    }
    t.clock.advanceSeconds(1);
    const s = await approve(() => dep.request('POST', `/threads/${m.body.id}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' }));
    return { thread: m.body.id as string, messages, ...s };
  };
  /** Ben (outside the original's audience) asks; his private answer is built on the summary. */
  const bensAnswer = async () => {
    const r = await ben.request('POST', `/projects/${project}/questions`, { question: QUESTION });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.sources.length > 0, 'material was found');
    assert.equal(await run(r.body.id, new AnswerModel()), 'succeeded');
    assert.equal((await ben.request('GET', `/questions/${r.body.id}`)).status, 200);
    return r.body.id as string;
  };

  beforeEach(async () => {
    queued = [];
    t = await startTestApp(undefined, { assistQueue: { enqueue: async (id: string) => void queued.push(id) } });
    for (const k of ['pm', 'dep', 'spo', 'ada', 'ben']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`UPDATE users SET display_name = 'Ada Lim' WHERE id = $1`, [ids.ada]);
    await t.pool.query(`UPDATE users SET display_name = 'Ben Tan' WHERE id = $1`, [ids.ben]);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.spo, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    await aiReady(t.pool, project);
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, dep, spo, ada, ben] = [
      await t.signIn('pm@example.org'),
      await t.signIn('dep@example.org'),
      await t.signIn('spo@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
    ];
  });
  afterEach(async () => {
    await t.close();
  });

  test('tightening the original keeps the summary visible and flags it', async () => {
    const { original, id, sourceId } = await approvedNote();
    // Before any change, the wider audience reads the approved summary view only.
    const shared = await view(ben, id);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.view, 'shared');
    assert.equal(shared.body.label, 'Summary approved for sharing');
    assert.equal(shared.body.from, 'From a restricted source');
    assert.equal(shared.body.body, SUMMARY);
    const text = JSON.stringify(shared.body);
    for (const hidden of [original, 'Board note', 'marks', 'leaveOut', 'omitted', 'versions']) assert.ok(!text.includes(hidden), hidden);

    await setAudience(await audienceOf(original), []);
    assert.deepEqual(await state(id), { state: 'review_required', review_reason: 'audience_tightened' });
    // Still visible to its audience everywhere.
    assert.ok((await listed(ben)).includes(sourceId));
    assert.equal((await ben.request('GET', `/notes/${sourceId}`)).status, 200);
    assert.deepEqual(await searched(ben), [sourceId]);
    const benView = (await view(ben, id)).body;
    assert.equal(benView.view, 'shared');
    assert.ok(!JSON.stringify(benView).includes(REVIEW_LABEL), 'the review label is for PM, Owner and Sponsor');
    // PM, Owner and Sponsor see the label, with the reason, on the summary and in Summaries to review.
    const pmView = (await view(pm, id)).body;
    assert.equal(pmView.reviewLabel, REVIEW_LABEL);
    assert.equal(pmView.reviewReason, "The original's audience was narrowed.");
    assert.equal(pmView.canReview, true);
    assert.equal((await view(dep, id)).body.reviewLabel, null, 'not for a Deputy');
    const items = (await spo.request('GET', `/projects/${project}/summaries-to-review`)).body.items;
    assert.deepEqual(items.map((i: { id: string; label: string; reason: string }) => [i.id, i.label, i.reason]), [[id, REVIEW_LABEL, "The original's audience was narrowed."]]);
    // PM/Owner and the Sponsor are told, with the summary's own title only.
    const notices = await reviewNotices();
    assert.deepEqual(notices.map((n) => n.user_id).sort(), [ids.pm, ids.spo].sort());
    const title = (await t.pool.query(`SELECT title FROM sources WHERE id = $1`, [sourceId])).rows[0].title;
    assert.ok(notices.every((n) => n.summary === `${REVIEW_LABEL}: ${title}` && n.link === `#/summaries/${id}` && n.email_off));
    assert.ok(!notices.some((n) => n.summary.includes('Board note')));
    const ev = (await t.pool.query(`SELECT action, actor_id, reason FROM ai_assist_events WHERE target_id = $1 AND action = 'review_required'`, [id])).rows;
    assert.deepEqual(ev, [{ action: 'review_required', actor_id: null, reason: 'audience_tightened' }]);
    // Narrowing again does not tell anyone twice.
    await setAudience(await audienceOf(original), []);
    assert.equal((await reviewNotices()).length, 2);
  });

  test('hiding a message of the meeting hides the summary from its wider audience', async () => {
    const { messages, id, sourceId, thread } = await approvedMeeting();
    const answer = await bensAnswer();
    // A message posted after the approved version was not summarised: hiding it changes nothing.
    const late = await ada.request('POST', `/threads/${thread}/messages`, { body: 'A later note about lunch.' });
    assert.equal(late.status, 201);
    assert.equal((await pm.request('POST', `/messages/${late.body.id}/hide`, { reason: 'Off topic' })).status, 200);
    assert.equal((await state(id)).state, 'approved');
    assert.equal((await reviewNotices()).length, 0);

    assert.equal((await pm.request('POST', `/messages/${messages[1]}/hide`, { reason: 'Posted in error' })).status, 200);
    assert.deepEqual(await state(id), { state: 'hidden', review_reason: 'message_hidden' });
    // Gone for the wider audience everywhere.
    assert.ok(!(await listed(ben)).includes(sourceId));
    assert.equal((await ben.request('GET', `/notes/${sourceId}`)).status, 404);
    assert.deepEqual(await searched(ben), []);
    assert.equal((await view(ben, id)).status, 404);
    // Still visible to the original's audience.
    assert.ok((await listed(ada)).includes(sourceId));
    assert.equal((await ada.request('GET', `/notes/${sourceId}`)).status, 200);
    assert.ok((await searched(ada)).includes(sourceId));
    const pmView = (await view(pm, id)).body;
    assert.equal(pmView.state, 'hidden');
    assert.equal(pmView.reviewLabel, REVIEW_LABEL);
    assert.equal(pmView.reviewReason, 'A message of the summarised meeting was hidden.');
    // Dependent outputs are treated as removed material: Ben's private answer disappears.
    assert.deepEqual(await answerState(answer), { review_state: 'withdrawn', review_reason: 'material_removed' });
    assert.equal((await ben.request('GET', `/questions/${answer}`)).status, 404);
    const cause = (await t.pool.query(`SELECT detail FROM ai_assist_events WHERE target_id = $1 AND action = 'withdrawn'`, [answer])).rows[0].detail.cause;
    assert.equal(cause, 'summary_withdrawn');
    assert.deepEqual((await reviewNotices()).map((n) => n.user_id).sort(), [ids.pm, ids.spo].sort());
    const items = (await pm.request('GET', `/projects/${project}/summaries-to-review`)).body.items;
    assert.deepEqual(items.map((i: { id: string; state: string }) => [i.id, i.state]), [[id, 'hidden']]);
  });

  test('confirm restores visibility', async () => {
    const { messages, id, sourceId } = await approvedMeeting();
    const answer = await bensAnswer();
    assert.equal((await pm.request('POST', `/messages/${messages[0]}/delete`, { reason: 'Posted in error' })).status, 200);
    assert.deepEqual(await state(id), { state: 'hidden', review_reason: 'message_deleted' });

    assert.equal((await decide(pm, 'confirm', id, '')).status, 400, 'a reason is required');
    assert.equal((await decide(dep, 'confirm', id)).status, 403, 'not a Deputy');
    assert.equal((await decide(ben, 'confirm', id)).status, 404, 'outside the original audience');
    const r = await decide(spo, 'confirm', id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'approved');
    assert.equal(r.body.reviewLabel, null);
    assert.deepEqual(await state(id), { state: 'approved', review_reason: null });
    assert.ok((await listed(ben)).includes(sourceId));
    assert.equal((await view(ben, id)).status, 200);
    assert.deepEqual(await searched(ben), [sourceId]);
    // Dependent outputs already withdrawn are not brought back.
    assert.equal((await answerState(answer)).review_state, 'withdrawn');
    const ev = (await t.pool.query(`SELECT actor_id, reason, detail FROM ai_assist_events WHERE target_id = $1 AND action = 'summary_confirmed'`, [id])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor_id, ids.spo);
    assert.equal(ev[0].reason, 'Checked with the board');
    assert.ok(!JSON.stringify(ev).includes('turbine'), 'no summary text in the event');
    assert.equal((await decide(pm, 'confirm', id)).status, 409, 'nothing to review now');
    assert.equal((await pm.request('GET', `/projects/${project}/summaries-to-review`)).body.items.length, 0);
  });

  test('withdraw hides it and withdraws private answers that used it', async () => {
    const { original, id, sourceId } = await approvedNote();
    const answer = await bensAnswer();
    await setAudience(await audienceOf(original), []);
    assert.equal((await answerState(answer)).review_state, 'none');

    const r = await decide(pm, 'withdraw', id, 'No longer suitable to share');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'withdrawn');
    assert.equal((await state(id)).state, 'withdrawn');
    // Hidden from everyone's notes and search, and from the wider audience's summary view; kept in history.
    for (const c of [ben, ada, pm]) assert.ok(!(await listed(c)).includes(sourceId));
    assert.equal((await ben.request('GET', `/notes/${sourceId}`)).status, 404);
    assert.equal((await ada.request('GET', `/notes/${sourceId}`)).status, 404);
    assert.deepEqual(await searched(ben), []);
    assert.equal((await view(ben, id)).status, 404);
    assert.equal((await view(pm, id)).body.state, 'withdrawn');
    // Ben's private answer that used it is withdrawn.
    assert.deepEqual(await answerState(answer), { review_state: 'withdrawn', review_reason: 'material_removed' });
    assert.equal((await ben.request('GET', `/questions/${answer}`)).status, 404);
    const ev = (await t.pool.query(`SELECT actor_id, reason FROM ai_assist_events WHERE target_id = $1 AND action = 'summary_withdrawn'`, [id])).rows;
    assert.deepEqual(ev, [{ actor_id: ids.pm, reason: 'No longer suitable to share' }]);
    assert.equal((await decide(pm, 'withdraw', id)).status, 409, 'already withdrawn');
    assert.equal((await decide(pm, 'confirm', id)).status, 409);
  });

  test('Access review required alone does not touch dependent answers', async () => {
    const { original, id } = await approvedNote();
    const answer = await bensAnswer();
    await setAudience(await audienceOf(original), []);
    assert.equal((await state(id)).state, 'review_required');
    assert.deepEqual(await answerState(answer), { review_state: 'none', review_reason: null });
    assert.equal((await ben.request('GET', `/questions/${answer}`)).status, 200);
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM ai_assist_events WHERE target_id = $1`, [answer])).rows[0].n), 1, 'only the asked event');
  });

  test('confirm allowed in a Closed project', async () => {
    const { original, id } = await approvedNote();
    await setAudience(await audienceOf(original), []);
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [project]);
    const r = await decide(pm, 'confirm', id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'approved');
  });

  test('deleting the original (the sub-project 5 hook) hides the summary', async () => {
    const { original, id, sourceId } = await approvedNote();
    const answer = await bensAnswer();
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [original]);
      await onMaterialRemoved(client, { sourceIds: [original] }, 'deleted', t.clock.now());
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    assert.deepEqual(await state(id), { state: 'hidden', review_reason: 'original_deleted' });
    assert.equal((await ben.request('GET', `/notes/${sourceId}`)).status, 404);
    assert.equal((await answerState(answer)).review_state, 'withdrawn');
    assert.equal((await view(pm, id)).body.reviewReason, 'The original was deleted.');
  });

  /** A Restricted meeting (Ada named) with the given messages; returns the thread and message ids. */
  const meeting = async (bodies: string[]) => {
    const m = await pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Board meeting', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const messages: string[] = [];
    for (const body of bodies) {
      const p = await ada.request('POST', `/threads/${m.body.id}/messages`, { body });
      assert.equal(p.status, 201, JSON.stringify(p.body));
      messages.push(p.body.id);
    }
    t.clock.advanceSeconds(1);
    return { thread: m.body.id as string, messages };
  };
  const hide = async (messageId: string) => assert.equal((await pm.request('POST', `/messages/${messageId}/hide`, { reason: 'Posted in error' })).status, 200);

  test('a message hidden after drafting began blocks approval; one hidden before the request does not', async () => {
    const { thread, messages } = await meeting(['The turbine replacement goes ahead next month.', 'The supplier was late again.', 'Old remark.']);
    // Hidden before any request: never sent, so it does not block.
    await hide(messages[2]);
    t.clock.advanceSeconds(1);
    const r = await dep.request('POST', `/threads/${thread}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const model = new SummaryModel();
    assert.equal(await run(lastRequest(), model), 'succeeded');
    assert.equal(model.calls.length, 1);
    assert.ok(!model.calls[0].user.includes('Old remark.'), 'a hidden message is never sent');
    assert.ok(model.calls[0].user.includes('The supplier was late again.'));
    t.clock.advanceSeconds(1);
    // Hidden after the draft was made, before approval: approving is refused, nothing reaches the wider audience.
    await hide(messages[1]);
    t.clock.advanceSeconds(1);
    const refused = await pm.request('POST', `/summaries/${r.body.id}/approve`, { versionNo: 1, reason: 'Fine to share' });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.message, MODERATED_SINCE);
    assert.equal((await state(r.body.id)).state, 'draft');
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM sources WHERE kind = 'summary'`)).rows[0].n), 0);
    // A fresh draft, requested after both were hidden, can be approved.
    const again = await approve(() => dep.request('POST', `/threads/${thread}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' }));
    assert.equal((await state(again.id)).state, 'approved');
  });

  test('hidden and deleted messages never reach the summary prompt, including one hidden while the request waited', async () => {
    const { thread, messages } = await meeting(['The turbine replacement goes ahead next month.', 'Old remark.', 'Deleted remark.', 'Late remark.']);
    await hide(messages[1]);
    assert.equal((await ada.request('POST', `/messages/${messages[2]}/delete`, { reason: 'Posted by mistake' })).status, 200);
    t.clock.advanceSeconds(1);
    const r = await dep.request('POST', `/threads/${thread}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // Hidden while the request was queued: the input is rebuilt at job start, so it is not sent either.
    t.clock.advanceSeconds(1);
    await hide(messages[3]);
    const model = new SummaryModel();
    assert.equal(await run(lastRequest(), model), 'succeeded');
    assert.equal(model.calls.length, 1);
    const sent = model.calls[0].user;
    assert.ok(sent.includes('The turbine replacement goes ahead next month.'));
    for (const gone of ['Old remark.', 'Deleted remark.', 'Late remark.']) assert.ok(!sent.includes(gone), `${gone} is not sent`);
    assert.ok(!model.calls[0].system.includes('remark'), 'nor put in the instructions');
  });

  test('a newer version is refused when a message posted before it is hidden before approval', async () => {
    const { thread, id } = await approvedMeeting();
    const late = await ada.request('POST', `/threads/${thread}/messages`, { body: 'The supplier will be replaced.' });
    assert.equal(late.status, 201);
    t.clock.advanceSeconds(1);
    const v2 = await dep.request('PUT', `/summaries/${id}`, { body: 'The turbine replacement goes ahead next month. The supplier will be replaced.', basedOnVersion: 1 });
    assert.equal(v2.status, 200, JSON.stringify(v2.body));
    t.clock.advanceSeconds(1);
    await hide(late.body.id);
    // Not in the approved version 1, so the approved summary stays as it is.
    assert.equal((await state(id)).state, 'approved');
    const refused = await pm.request('POST', `/summaries/${id}/approve`, { versionNo: 2, reason: 'Updated' });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.message, MODERATED_SINCE);
    assert.equal((await view(ben, id)).body.body, SUMMARY, 'the wider audience still reads version 1');
  });

  /** Ben asks for a specification from the summary source; drafted by the AI. */
  const bensDraft = async (sourceId: string) => {
    const r = await ben.request('POST', `/projects/${project}/reports`, { kind: 'specification', title: 'Turbine specification', chosen: { sourceIds: [sourceId] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await run(lastRequest(), new ReportModel()), 'succeeded');
    t.clock.advanceSeconds(1);
    return r.body.id as string;
  };
  const draftState = async (id: string) => (await t.pool.query(`SELECT review_state, review_reason FROM report_drafts WHERE id = $1`, [id])).rows[0];

  test('a hidden summary sends shared answers and drafts to review and withdraws private drafts', async () => {
    const { messages, sourceId, id } = await approvedMeeting();
    const d = await pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plant' });
    assert.equal(d.status, 201);
    const sharedAnswer = await bensAnswer();
    const s = await ben.request('POST', `/questions/${sharedAnswer}/share`, { threadId: d.body.id });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const privateDraft = await bensDraft(sourceId);
    const sharedDraft = await bensDraft(sourceId);
    assert.equal((await ben.request('POST', `/reports/${sharedDraft}/share`)).status, 200);

    await hide(messages[0]);
    assert.equal((await state(id)).state, 'hidden');
    assert.deepEqual(await answerState(sharedAnswer), { review_state: 'review_required', review_reason: 'material_removed' });
    assert.deepEqual(await draftState(privateDraft), { review_state: 'withdrawn', review_reason: 'material_removed' });
    assert.deepEqual(await draftState(sharedDraft), { review_state: 'review_required', review_reason: 'material_removed' });
    const causes = (await t.pool.query(`SELECT target_id, detail->>'cause' AS cause FROM ai_assist_events WHERE target_id = ANY($1::uuid[]) AND action IN ('withdrawn', 'review_required')`, [[sharedAnswer, privateDraft, sharedDraft]])).rows;
    assert.equal(causes.length, 3);
    assert.ok(causes.every((c) => c.cause === 'summary_withdrawn'));
    const items = (await pm.request('GET', `/projects/${project}/assist-review`)).body.items as Array<{ id: string }>;
    assert.deepEqual(items.map((i) => i.id).sort(), [sharedAnswer, sharedDraft].sort());
  });

  test('withdrawing a summary sends a shared draft built on it to review', async () => {
    const { original, id, sourceId } = await approvedNote();
    const sharedDraft = await bensDraft(sourceId);
    assert.equal((await ben.request('POST', `/reports/${sharedDraft}/share`)).status, 200);
    await setAudience(await audienceOf(original), []);
    assert.deepEqual(await draftState(sharedDraft), { review_state: 'none', review_reason: null }, 'review alone touches nothing');
    assert.equal((await decide(spo, 'withdraw', id)).status, 200);
    assert.deepEqual(await state(id), { state: 'withdrawn', review_reason: null });
    assert.deepEqual(await draftState(sharedDraft), { review_state: 'review_required', review_reason: 'material_removed' });
  });

  test('a meeting and its minutes share an audience row: tightening flags both summaries', async () => {
    const { thread } = await meeting(['The turbine replacement goes ahead next month.']);
    const audienceId = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [thread])).rows[0].audience_id as string;
    const minutes = uuidv7(t.clock.now().getTime());
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id, publication) VALUES ($1, 'Board meeting', $2, $3, $4, 'minutes', $5, $6, 'published')`,
        [minutes, ids.pm, t.clock.now(), project, audienceId, thread],
      );
      await t.app.get(NotesService).addVersionText(client, minutes, ORIGINAL, ids.pm, t.clock.now());
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    t.clock.advanceSeconds(1);
    const ofMinutes = await approve(() => dep.request('POST', `/sources/${minutes}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' }));
    const ofMeeting = await approve(() => dep.request('POST', `/threads/${thread}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' }));
    await setAudience(audienceId, []);
    assert.equal((await state(ofMinutes.id)).state, 'review_required');
    assert.equal((await state(ofMeeting.id)).state, 'review_required');
    assert.equal((await reviewNotices()).length, 4, 'PM/Owner and Sponsor, for each summary');
  });
});
