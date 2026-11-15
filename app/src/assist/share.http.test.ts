import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AnalysisRunner } from '../analysis/analysis-runner';
import { MinutesRunner } from '../analysis/minutes-runner';
import type { MinutesAnswer } from '../analysis/minutes';
import { insertRun } from '../analysis/runs';
import { uuidv7 } from '../common/uuid7';
import type { JsonSchemaModel, MinutesModel, ModelRequest } from '../extraction/model';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { AssistRunner } from './assist-runner';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const QUESTION = 'When is the pump service?';
const SOME_CANNOT_READ = 'This answer used information some people in this thread cannot read.';
const ANSWER_TEXT = (marker: string) => `The pump service is on Thursday [${marker}].`;

/** Answers citing only the given marker (P1 unless told otherwise). */
class FakeModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  constructor(private readonly marker = 'P1') {}
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ answer_markdown: ANSWER_TEXT(this.marker), not_found: false, cited: [this.marker] }), usage: USAGE };
  }
}

interface Source {
  marker: string;
  location: string | null;
  href: string | null;
  cited: boolean;
  dropped: boolean;
}

describe('sharing AI answers into threads', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let ada: Client;
  let ben: Client;
  let auditor: Client;
  let thread: string;
  let queued: string[];

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const ask = (c: Client, question = QUESTION) => c.request('POST', `/projects/${project}/questions`, { question });
  const run = (id: string, model: JsonSchemaModel = new FakeModel()) =>
    new AssistRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model, clock: t.clock.now }).process(id, 1, false);
  const share = (c: Client, id: string, threadId = thread) => c.request('POST', `/questions/${id}/share`, { threadId });
  const reanswer = (c: Client, id: string, threadId = thread) => c.request('POST', `/questions/${id}/reanswer`, { threadId });
  const note = async (title: string, text: string) => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  const restrictNote = async (sourceId: string, namedUserIds: string[], reason = 'Leaders only from now on') => {
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    const r = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds, reason });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const startThread = async (c: Client, body: Record<string, unknown>) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  /** Ada asks and the AI answers, citing the marker of the Plant room passage. */
  const answered = async (model?: FakeModel) => {
    const r = await ask(ada);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const plant = (r.body.sources as Source[]).find((s) => s.location?.startsWith('Plant room')) as Source;
    assert.equal(await run(r.body.id, model ?? new FakeModel(plant.marker)), 'succeeded');
    return { id: r.body.id as string, marker: plant.marker, sources: r.body.sources as Source[] };
  };
  const aiAnswers = async (c: Client, threadId = thread) => {
    const r = await c.request('GET', `/threads/${threadId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.aiAnswers as Array<Record<string, unknown>>;
  };

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
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), project, ids.auditor, ids.pm, ids.admin],
    );
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    [pm, ada, ben, auditor] = [
      await t.signIn('pm@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('auditor@example.org'),
    ];
    await note('Plant room', 'The pump service is booked for Thursday morning.');
    thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
  });
  afterEach(async () => {
    await t.close();
  });

  test('share succeeds when all sent material is Project-wide', async () => {
    const a = await answered();
    t.clock.advanceSeconds(30);
    // Only the requester shares; a grant holder is read-only; someone who cannot see the answer finds nothing.
    assert.equal((await share(ben, a.id)).status, 404);
    assert.equal((await share(pm, a.id)).status, 404);
    const r = await share(ada, a.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.visibility, 'shared');
    assert.equal(r.body.sharedThreadId, thread);
    const row = (await t.pool.query(`SELECT visibility, shared_thread_id, shared_by, shared_at FROM ai_answers WHERE request_id = $1`, [a.id])).rows[0];
    assert.deepEqual(row, { visibility: 'shared', shared_thread_id: thread, shared_by: ids.ada, shared_at: t.clock.now() });
    const events = (await t.pool.query(`SELECT action, actor_id, target_id, reason, detail FROM ai_assist_events WHERE action = 'shared'`)).rows;
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].actor_id, events[0].target_id], [ids.ada, a.id]);
    assert.ok(!JSON.stringify(events).includes('pump'), 'no question or answer text in the event');
    // Once shared, it cannot be shared again.
    assert.equal((await share(ada, a.id)).status, 409);
    // Bad thread ids.
    const other = await ask(ada, 'Who books the pump service?');
    assert.equal((await share(ada, other.body.id, 'nope')).status, 400);
    assert.equal((await share(ada, other.body.id, uuidv7())).status, 404);
  });

  test('Audit grant holder cannot share or re-answer (403)', async () => {
    const r = await ask(auditor);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await run(r.body.id), 'succeeded');
    assert.equal((await share(auditor, r.body.id)).status, 403);
    assert.equal((await reanswer(auditor, r.body.id)).status, 403);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests WHERE scope = 'thread'`), 0);
    assert.equal((await t.pool.query(`SELECT visibility FROM ai_answers WHERE request_id = $1`, [r.body.id])).rows[0].visibility, 'private');
  });

  test('share is refused when an uncited sent passage is restricted', async () => {
    const restricted = await note('Board notes', 'The pump service contract is under dispute.');
    await restrictNote(restricted, [ids.ada]);
    const a = await answered();
    const sent = (await t.pool.query(`SELECT marker, cited, dropped_at_start AS dropped, passage_id FROM ai_request_material WHERE request_id = $1 ORDER BY ordinal`, [a.id])).rows;
    assert.equal(sent.length, 2, 'both passages were sent');
    const board = a.sources.find((s) => s.location?.startsWith('Board notes')) as Source;
    const boardRow = sent.find((s) => s.marker === board.marker);
    assert.deepEqual([boardRow.cited, boardRow.dropped], [false, false], 'the restricted passage was sent but not cited');

    const r = await share(ada, a.id);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.message, SOME_CANNOT_READ);
    assert.equal(r.body.canReanswer, true);
    assert.equal((await t.pool.query(`SELECT visibility FROM ai_answers WHERE request_id = $1`, [a.id])).rows[0].visibility, 'private');
    assert.deepEqual(await aiAnswers(ben), []);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_assist_events WHERE action = 'shared'`), 0);
  });

  test('share is refused when a pending proposal was sent', async () => {
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', 'The pump service may slip a week', $3, now())`,
      [uuidv7(), project, ids.ada],
    );
    const a = await answered();
    const recordRows = await count(`SELECT count(*) AS n FROM ai_request_material WHERE request_id = $1 AND record_kind = 'human_proposal'`, [a.id]);
    assert.equal(recordRows, 1, 'the pending proposal was sent');
    const r = await share(ada, a.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.message, SOME_CANNOT_READ);
    assert.equal(r.body.canReanswer, true);
  });

  test('reanswer builds from thread scope only and posts', async () => {
    const restricted = await note('Board notes', 'The pump service contract is under dispute.');
    await restrictNote(restricted, [ids.ada]);
    const a = await answered();
    assert.equal((await share(ada, a.id)).status, 409);
    assert.equal((await reanswer(ben, a.id)).status, 404, 'only the requester');

    t.clock.advanceSeconds(10);
    queued.length = 0;
    const r = await reanswer(ada, a.id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.notEqual(r.body.id, a.id);
    assert.equal(r.body.status, 'queued');
    assert.equal(r.body.question, QUESTION);
    assert.equal(r.body.visibility, 'private', 'shared only once answered');
    assert.deepEqual(
      (r.body.sources as Source[]).map((s) => s.location),
      ['Plant room — Paragraph 1'],
      'only Project-wide material and the thread’s own audience',
    );
    assert.deepEqual(queued, [r.body.id]);
    const req = (await t.pool.query(`SELECT scope, scope_thread_id, requested_by FROM ai_requests WHERE id = $1`, [r.body.id])).rows[0];
    assert.deepEqual(req, { scope: 'thread', scope_thread_id: thread, requested_by: ids.ada });
    const ev = (await t.pool.query(`SELECT actor_id, target_id, detail FROM ai_assist_events WHERE action = 'reanswered'`)).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].target_id, r.body.id);
    assert.ok(!JSON.stringify(ev).includes('pump'));
    // Nothing in the thread until it is answered.
    assert.deepEqual(await aiAnswers(ben), []);

    t.clock.advanceSeconds(5);
    assert.equal(await run(r.body.id), 'succeeded');
    const done = (await ada.request('GET', `/questions/${r.body.id}`)).body;
    assert.equal(done.status, 'answered');
    assert.equal(done.visibility, 'shared');
    assert.equal(done.sharedThreadId, thread);
    const row = (await t.pool.query(`SELECT a.shared_by, a.shared_at, r.finished_at FROM ai_answers a JOIN ai_requests r ON r.id = a.request_id WHERE a.request_id = $1`, [r.body.id])).rows[0];
    assert.equal(row.shared_by, ids.ada);
    assert.deepEqual(row.shared_at, row.finished_at);
    const items = await aiAnswers(ben);
    assert.deepEqual(items.map((i) => i.id), [r.body.id]);
    assert.equal(items[0].answerMarkdown, ANSWER_TEXT('P1'));
    // The original private answer stays private.
    assert.equal((await t.pool.query(`SELECT visibility FROM ai_answers WHERE request_id = $1`, [a.id])).rows[0].visibility, 'private');
  });

  test('reanswer with nothing in thread scope ends as not found and is not posted', async () => {
    const restricted = await note('Board notes', 'The chiller contract is under dispute.');
    await restrictNote(restricted, [ids.ada]);
    const mine = await ask(ada, 'What about the chiller contract?');
    assert.equal(mine.body.sources.length, 1);
    queued.length = 0;
    const r = await reanswer(ada, mine.body.id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'not_found');
    assert.equal(r.body.visibility, 'private');
    assert.deepEqual(queued, []);
    assert.deepEqual(await aiAnswers(ben), []);
  });

  test('shared answer visible to thread readers, labelled with asker', async () => {
    const a = await answered();
    t.clock.advanceSeconds(30);
    assert.equal((await share(ada, a.id)).status, 200);
    const items = await aiAnswers(ben);
    assert.equal(items.length, 1);
    const item = items[0] as Record<string, unknown> & { sources: Source[] };
    assert.equal(item.id, a.id);
    assert.deepEqual(item.askedBy, { id: ids.ada, displayName: 'ada' });
    assert.equal(item.question, QUESTION);
    assert.equal(item.answerMarkdown, ANSWER_TEXT(a.marker));
    assert.equal(item.hidden, false);
    assert.equal(item.notice, null);
    assert.equal(new Date(item.sharedAt as string).getTime(), t.clock.now().getTime());
    assert.equal(item.sources[0].cited, true);
    assert.equal(item.sources[0].location, 'Plant room — Paragraph 1');
    // The direct link works for thread readers too.
    assert.equal((await ben.request('GET', `/questions/${a.id}`)).status, 200);
    // Not a message: the thread's numbered messages are unchanged.
    assert.equal(await count(`SELECT count(*) AS n FROM discussion_messages WHERE thread_id = $1`, [thread]), 0);

    // A Restricted meeting: people outside it see nothing of an answer shared there.
    const closedDoor = await startThread(pm, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    const b = await ask(ada, 'Who books the pump service?');
    assert.equal(await run(b.body.id), 'succeeded');
    assert.equal((await share(ada, b.body.id, closedDoor)).status, 200);
    assert.equal((await ben.request('GET', `/questions/${b.body.id}`)).status, 404);
    assert.equal((await ben.request('GET', `/threads/${closedDoor}`)).status, 404);
    assert.deepEqual((await aiAnswers(ada, closedDoor)).map((i) => i.id), [b.body.id]);

    // Per-viewer recheck: narrowing the note sends the answer to review (Task 7); once the PM clears it, Ben, who can
    // no longer read the note, sees the notice and no content, while Ada still sees the answer.
    const plant = (await t.pool.query(`SELECT id FROM sources WHERE title = 'Plant room'`)).rows[0].id;
    await restrictNote(plant, [ids.ada]);
    assert.equal((await aiAnswers(ben)).find((i) => i.id === a.id), undefined, 'in review: hidden from members');
    const cleared = await pm.request('POST', `/assist-review/answer/${a.id}/clear`, { reason: 'Fine for the thread; others get the notice' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    const after = (await aiAnswers(ben)).find((i) => i.id === a.id) as Record<string, unknown>;
    assert.equal(after.answerMarkdown, null);
    assert.deepEqual(after.sources, []);
    assert.equal(after.notice, 'This answer used information you can no longer read');
    assert.equal((await aiAnswers(ada)).find((i) => i.id === a.id)?.answerMarkdown, ANSWER_TEXT(a.marker), 'Ada can still read it');
  });

  test('shared answer never appears in a transcript or minutes input', async () => {
    const meeting = await startThread(ada, { kind: 'meeting', title: 'Weekly check-in', meetingDate: '2026-11-09' });
    for (const to of [thread, meeting]) {
      const posted = await ada.request('POST', `/threads/${to}/messages`, { body: 'Shall we move the filter order?' });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
    }
    t.clock.advanceSeconds(1);
    const a = await answered();
    assert.equal((await share(ada, a.id, thread)).status, 200);
    const b = await ask(ada, 'Who books the pump service?');
    assert.equal(await run(b.body.id), 'succeeded');
    assert.equal((await share(ada, b.body.id, meeting)).status, 200);
    assert.equal((await aiAnswers(ada, thread)).length, 1);
    assert.equal((await aiAnswers(ada, meeting)).length, 1);

    // Discussion analysis: the transcript stored for extraction holds the message only.
    const analysis = await insertRun(t.pool, { threadId: thread, kind: 'proposals', trigger: 'button', requestedBy: ids.ada, coversFromNo: 1, coversThroughNo: null, at: t.clock.now() });
    const dispatcher = new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction: { process: async () => 'skipped' } });
    await dispatcher.process(analysis, 1, false);
    const transcript = (
      await t.pool.query(`SELECT v.text_content AS text FROM analysis_runs r JOIN source_versions v ON v.id = r.source_version_id WHERE r.id = $1`, [analysis])
    ).rows[0].text as string;
    assert.match(transcript, /Shall we move the filter order\?/);
    assert.ok(!transcript.includes('pump'), 'neither the question nor the answer is in the transcript');

    // Minutes: the input sent to the AI holds the message only.
    const calls: ModelRequest[] = [];
    const answer: MinutesAnswer = { summary: 'Filters.', discussionPoints: [], decisions: [], actionItems: [], openQuestions: [], risks: [] };
    const minutesModel: MinutesModel = {
      draftMinutes: async (req: ModelRequest) => {
        calls.push(req);
        return { ...answer, usage: USAGE };
      },
    };
    const minutes = await insertRun(t.pool, { threadId: meeting, kind: 'minutes', trigger: 'button', requestedBy: ids.ada, coversFromNo: 1, coversThroughNo: null, at: t.clock.now() });
    const runner = new MinutesRunner({ pool: t.pool, spend: new SpendService(t.pool, t.clock.now), model: minutesModel, clock: t.clock.now });
    assert.equal(await runner.process(minutes, 1, false), 'succeeded');
    assert.equal(calls.length, 1);
    assert.match(calls[0].user, /Shall we move the filter order\?/);
    assert.ok(!calls[0].user.includes('pump'), 'neither the question nor the answer is in the minutes input');
  });

  test('share into an ended meeting refused', async () => {
    const meeting = await startThread(ada, { kind: 'meeting', title: 'Weekly check-in' });
    const ended = await ada.request('POST', `/threads/${meeting}/end`);
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    const a = await answered();
    const r = await share(ada, a.id, meeting);
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'This meeting has ended.');
    const re = await reanswer(ada, a.id, meeting);
    assert.equal(re.status, 409);
    assert.equal(re.body.message, 'This meeting has ended.');
    assert.equal(await count(`SELECT count(*) AS n FROM ai_requests WHERE scope = 'thread'`), 0);
    assert.equal((await t.pool.query(`SELECT visibility FROM ai_answers WHERE request_id = $1`, [a.id])).rows[0].visibility, 'private');
  });

  test('a re-answer for a meeting that ended before it ran is blocked with no AI call', async () => {
    const meeting = await startThread(ada, { kind: 'meeting', title: 'Weekly check-in' });
    const a = await answered();
    const r = await reanswer(ada, a.id, meeting);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await ada.request('POST', `/threads/${meeting}/end`)).status, 200);
    const spentBefore = await count(`SELECT count(*) AS n FROM ai_spend_entries`);
    const model = new FakeModel();
    assert.equal(await run(r.body.id, model), 'blocked');
    assert.equal(model.calls.length, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries`), spentBefore, 'nothing charged');
    const done = (await ada.request('GET', `/questions/${r.body.id}`)).body;
    assert.equal(done.status, 'blocked');
    assert.equal(done.notice, 'AI answer unavailable: the meeting has ended, so the answer could not be posted');
    assert.equal(done.visibility, 'private');
    assert.deepEqual(await aiAnswers(ada, meeting), []);
  });

  /** Runs the re-answer, changing something while the AI call is in progress; the answer must stay private. */
  const changedDuringCall = async (threadId: string, change: () => Promise<unknown>) => {
    const a = await answered();
    const r = await reanswer(ada, a.id, threadId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const model = new FakeModel();
    const call = model.callJson.bind(model);
    model.callJson = async (req) => {
      await change();
      return call(req);
    };
    assert.equal(await run(r.body.id, model), 'succeeded');
    assert.equal(model.calls.length, 1);
    const row = (await t.pool.query(`SELECT visibility, shared_thread_id FROM ai_answers WHERE request_id = $1`, [r.body.id])).rows[0];
    assert.deepEqual(row, { visibility: 'private', shared_thread_id: null });
    assert.equal(await count(`SELECT count(*) AS n FROM ai_assist_events WHERE action = 'shared' AND target_id = $1`, [r.body.id]), 0);
    return r.body.id as string;
  };

  test('a re-answer finishing after the meeting ended stays private', async () => {
    const meeting = await startThread(ada, { kind: 'meeting', title: 'Weekly check-in' });
    await changedDuringCall(meeting, () => ada.request('POST', `/threads/${meeting}/end`));
    assert.deepEqual(await aiAnswers(ada, meeting), []);
  });

  test('a re-answer finishing after the project was deferred stays private', async () => {
    const id = await changedDuringCall(thread, () => t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]));
    assert.equal((await ada.request('GET', `/questions/${id}`)).body.status, 'answered');
  });

  test('a re-answer finishing after the requester left the Restricted meeting stays private', async () => {
    const closedDoor = await startThread(pm, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    const audienceId = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [closedDoor])).rows[0].audience_id;
    await changedDuringCall(closedDoor, () => t.pool.query(`DELETE FROM audience_members WHERE audience_id = $1 AND user_id = $2`, [audienceId, ids.ada]));
  });

  test('a re-answer withdrawn for review while running is not posted', async () => {
    const id = await changedDuringCall(thread, async () => {
      const req = (await t.pool.query(`SELECT id FROM ai_requests WHERE scope = 'thread' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
      await t.pool.query(`UPDATE ai_answers SET review_state = 'withdrawn', review_reason = 'material_removed' WHERE request_id = $1`, [req]);
    });
    assert.equal((await t.pool.query(`SELECT review_state FROM ai_answers WHERE request_id = $1`, [id])).rows[0].review_state, 'withdrawn');
  });

  test('a second re-answer for the same thread is refused while the first is pending', async () => {
    const a = await answered();
    const first = await reanswer(ada, a.id);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await reanswer(ada, a.id);
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'This question is already being answered again for this thread.');
    // Another thread is fine; once the first has finished, the same thread is fine again.
    const other = await startThread(pm, { kind: 'discussion', title: 'Other' });
    assert.equal((await reanswer(ada, a.id, other)).status, 201);
    assert.equal(await run(first.body.id), 'succeeded');
    assert.equal((await reanswer(ada, a.id)).status, 201);
  });

  test('Member cannot hide; PM can', async () => {
    const a = await answered();
    assert.equal((await share(ada, a.id)).status, 200);
    const hide = (c: Client, reason: unknown = 'Off topic for this thread') => c.request('POST', `/questions/${a.id}/hide`, { reason });
    const r = await hide(ben);
    assert.equal(r.status, 403);
    assert.equal(r.body.message, 'Only the Project Manager or a Deputy can hide or delete messages written by others, and not while the project is Deferred or Closed.');
    assert.equal((await hide(ada)).status, 403, 'not even the requester');
    assert.equal((await hide(pm, '  ')).status, 400);
    const done = await hide(pm);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.hidden, true);
    assert.equal((await hide(pm)).status, 409);

    // Readers see that it was hidden, by whom and why, and nothing of it.
    const notice = 'Hidden by pm: Off topic for this thread';
    const seen = (await aiAnswers(ben))[0];
    assert.deepEqual(
      { ...seen, sharedAt: undefined },
      { id: a.id, askedBy: { id: ids.ada, displayName: 'ada' }, question: null, answerMarkdown: null, sources: [], droppedCount: 0, sharedAt: undefined, hidden: true, notice },
    );
    const direct = await ben.request('GET', `/questions/${a.id}`);
    assert.equal(direct.status, 200);
    assert.deepEqual([direct.body.hidden, direct.body.question, direct.body.answerMarkdown, direct.body.sources, direct.body.notice], [true, null, null, [], notice]);
    // Feedback needs the answer itself.
    const flag = await ben.request('POST', `/projects/${project}/feedback`, { targetKind: 'answer', targetId: a.id, category: 'incorrect', note: 'Wrong day.' });
    assert.equal(flag.status, 404);
    // PM and the requester still see the content with the hidden flag.
    for (const c of [pm, ada]) {
      const item = (await aiAnswers(c))[0];
      assert.deepEqual([item.hidden, item.answerMarkdown, item.notice], [true, ANSWER_TEXT(a.marker), notice]);
    }

    const events = (await t.pool.query(`SELECT action, actor_id, reason FROM ai_assist_events WHERE action IN ('hidden', 'unhidden') ORDER BY at, id`)).rows;
    assert.deepEqual(events, [{ action: 'hidden', actor_id: ids.pm, reason: 'Off topic for this thread' }]);

    assert.equal((await ben.request('POST', `/questions/${a.id}/unhide`, { reason: 'Back' })).status, 403);
    const back = await pm.request('POST', `/questions/${a.id}/unhide`, { reason: 'Back on topic' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.hidden, false);
    assert.equal((await pm.request('POST', `/questions/${a.id}/unhide`, { reason: 'Again' })).status, 409);
    const visible = (await aiAnswers(ben))[0];
    assert.deepEqual([visible.hidden, visible.notice, visible.answerMarkdown], [false, null, ANSWER_TEXT(a.marker)]);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_assist_events WHERE action = 'unhidden' AND reason = 'Back on topic'`), 1);

    // A private answer cannot be hidden: nobody but the requester knows of it.
    const other = await ask(ada, 'Who books the pump service?');
    assert.equal((await pm.request('POST', `/questions/${other.body.id}/hide`, { reason: 'x' })).status, 404);
  });

  test('dropped material shows no location or link', async () => {
    const a = await answered();
    await t.pool.query(`UPDATE ai_request_material SET dropped_at_start = true WHERE request_id = $1`, [a.id]);
    const r = await ada.request('GET', `/questions/${a.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.droppedCount, 1);
    assert.deepEqual(r.body.sources, [{ marker: a.marker, location: null, href: null, cited: true, dropped: true }]);
  });
});
