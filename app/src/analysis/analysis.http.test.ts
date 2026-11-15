import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { ALREADY_ACTIVE, NOTHING_NEW } from './analysis.service';
import { hhmm } from './state';

describe('analysis status and explicit requests', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let jobs: string[];
  let explicit: boolean[];
  let ids: Record<string, string>;
  let project: string;
  let pm: Client;
  let ada: Client;
  let ben: Client;
  let outsider: Client;

  const start = async (c: Client, body: Record<string, unknown>) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const post = async (c: Client, thread: string, body = 'We should ship on Friday.') => {
    const r = await c.request('POST', `/threads/${thread}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const runs = async () => (await t.pool.query(`SELECT * FROM analysis_runs ORDER BY created_at, id`)).rows;
  const finish = (through: number) =>
    t.pool.query(`UPDATE analysis_runs SET status = 'succeeded', covers_through_no = $1, finished_at = $2 WHERE status IN ('queued', 'running')`, [through, t.clock.now()]);

  beforeEach(async () => {
    jobs = [];
    explicit = [];
    // Giving an analysis queue also makes ending a meeting use the real hook, which requests the final draft.
    t = await startTestApp(undefined, { analysisQueue: { enqueue: async (id, opts) => void (jobs.push(id), explicit.push(opts?.explicit === true)) } });
    ids = {};
    for (const k of ['pm', 'ada', 'ben', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
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
    [pm, ada, ben, outsider] = [await t.signIn('pm@example.org'), await t.signIn('ada@example.org'), await t.signIn('ben@example.org'), await t.signIn('outsider@example.org')];
  });
  afterEach(async () => {
    await t.close();
  });

  test('status shows Waiting with the time', async () => {
    const thread = await start(ada, { kind: 'discussion', title: 'Release plan' });
    const empty = await ada.request('GET', `/threads/${thread}/analysis`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.line, 'Up to date');
    await post(ada, thread);
    const due = new Date(t.clock.now().getTime() + 5 * 60_000);
    const r = await ada.request('GET', `/threads/${thread}/analysis`);
    assert.equal(r.body.status.state, 'waiting');
    assert.equal(r.body.line, `Analysis at ${hhmm(due)} if no new messages`);
    assert.match(r.body.line, /^Analysis at 10:\d\d if no new messages$/, 'times are shown in UTC+8');
    assert.equal(r.body.explanation, 'Automatic analysis: after 5 minutes without new messages; maximum 2 analyses per thread in any rolling 20 minutes.');
    assert.equal(r.body.lastFailure, null);
    // Spend settings are not approved in this test, so once the quiet period has passed the status is Blocked, not Waiting.
    t.clock.advanceMinutes(5);
    assert.equal((await ada.request('GET', `/threads/${thread}/analysis`)).body.line, 'Blocked — The AI spend settings have not been approved yet.');
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    assert.equal((await ada.request('GET', `/threads/${thread}/analysis`)).body.line, 'Paused — The project is Deferred.');
  });

  test('status shows the last failure and a queued run', async () => {
    const thread = await start(ada, { kind: 'discussion', title: 'Release plan' });
    await post(ada, thread);
    await t.pool.query(
      `INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, failure_code, failure_detail, created_at, finished_at)
       VALUES ($1, $2, 'proposals', 'button', $3, 'failed', 'model_timeout', 'the AI service did not answer', $4, $4)`,
      [uuidv7(), thread, ids.ada, t.clock.now()],
    );
    assert.equal((await ada.request('GET', `/threads/${thread}/analysis`)).body.lastFailure, 'the AI service did not answer');
    t.clock.advanceMinutes(1);
    assert.equal((await ada.request('POST', `/threads/${thread}/analyse`, {})).status, 202);
    const r = await ben.request('GET', `/threads/${thread}/analysis`);
    assert.deepEqual([r.body.line, r.body.lastFailure], ['Queued', null]);
    assert.equal(r.body.lastRunId, null, 'no run has succeeded yet');
    const ok = uuidv7();
    await t.pool.query(
      `INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, created_at, finished_at) VALUES ($1, $2, 'proposals', 'button', $3, 'succeeded', $4, $4)`,
      [ok, thread, ids.ada, t.clock.now()],
    );
    assert.equal((await ben.request('GET', `/threads/${thread}/analysis`)).body.lastRunId, ok);
    assert.equal(typeof (await ben.request('GET', `/threads/${thread}/analysis`)).body.lastRunLabel, 'string');
  });

  test('Analyse now starts one run for the new messages and refuses a second', async () => {
    const thread = await start(ada, { kind: 'discussion', title: 'Release plan' });
    await post(ada, thread);
    await post(ada, thread, 'And the vendor must confirm.');
    const r = await ada.request('POST', `/threads/${thread}/analyse`, {});
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual([r.body.kind, r.body.trigger, r.body.status, r.body.requestedBy, r.body.coversFromNo, r.body.coversThroughNo], ['proposals', 'button', 'queued', ids.ada, 1, 2]);
    assert.deepEqual(jobs, [r.body.id]);
    assert.deepEqual(explicit, [true], 'a person asked: it goes ahead of automatic runs');
    const again = await ben.request('POST', `/threads/${thread}/analyse`, {});
    assert.deepEqual([again.status, again.body.message], [409, ALREADY_ACTIVE]);
    assert.equal(jobs.length, 1);
    assert.equal((await runs()).length, 1);
  });

  test('Analyse now with nothing new needs confirmation', async () => {
    const thread = await start(ada, { kind: 'discussion', title: 'Release plan' });
    assert.equal((await ada.request('POST', `/threads/${thread}/analyse`, { confirmRepeat: true })).status, 409, 'an empty thread has nothing to analyse');
    await post(ada, thread);
    await post(ada, thread, 'Second message.');
    await ada.request('POST', `/threads/${thread}/analyse`, {});
    await finish(2);
    const refused = await ada.request('POST', `/threads/${thread}/analyse`, {});
    assert.deepEqual([refused.status, refused.body.message], [409, NOTHING_NEW]);
    assert.equal((await ada.request('POST', `/threads/${thread}/analyse`, { confirmRepeat: 'yes' })).status, 409, 'only true confirms');
    assert.equal(jobs.length, 1);
    const repeat = await ada.request('POST', `/threads/${thread}/analyse`, { confirmRepeat: true });
    assert.equal(repeat.status, 202, JSON.stringify(repeat.body));
    assert.deepEqual([repeat.body.coversFromNo, repeat.body.coversThroughNo], [1, 2]);
    assert.equal(jobs.length, 2);
  });

  test('selected messages must belong to the thread', async () => {
    const thread = await start(ada, { kind: 'discussion', title: 'Release plan' });
    const other = await start(ada, { kind: 'discussion', title: 'Other topic' });
    const a = await post(ada, thread);
    const b = await post(ada, thread, 'Second message.');
    const foreign = await post(ada, other, 'Elsewhere.');
    const url = `/threads/${thread}/analyse-selected`;
    for (const messageIds of [[a, foreign], [], 'x', [a, 'not-an-id'], Array.from({ length: 51 }, () => uuidv7())]) {
      const bad = await ada.request('POST', url, { messageIds });
      assert.equal(bad.status, 400, JSON.stringify(messageIds));
    }
    assert.equal((await runs()).length, 0);
    // A deleted message cannot be selected.
    assert.equal((await pm.request('POST', `/messages/${b}/delete`, { reason: 'Posted by mistake' })).status, 200);
    assert.equal((await ada.request('POST', url, { messageIds: [a, b] })).status, 400);
    const ok = await ada.request('POST', url, { messageIds: [a] });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.trigger, ok.body.kind, ok.body.coversFromNo, ok.body.coversThroughNo], ['selection', 'proposals', 1, 1]);
    assert.deepEqual((await runs())[0].selected_message_ids, [a]);
    // A selection run does not move the cursor: the message is still unanalysed.
    await finish(1);
    assert.equal((await ada.request('GET', `/threads/${thread}/analysis`)).body.status.state, 'waiting');
  });

  test('a person outside the project, or outside a Restricted meeting, gets 404', async () => {
    const closed = await start(pm, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    await post(pm, closed, 'Private matter.');
    const discussion = await start(ada, { kind: 'discussion', title: 'Release plan' });
    await post(ada, discussion);
    for (const c of [ben, outsider]) {
      assert.equal((await c.request('GET', `/threads/${closed}/analysis`)).status, 404);
      assert.equal((await c.request('POST', `/threads/${closed}/minutes/draft`)).status, 404);
    }
    assert.equal((await outsider.request('POST', `/threads/${discussion}/analyse`, {})).status, 404);
    assert.equal((await outsider.request('GET', `/threads/${discussion}/analysis`)).status, 404);
    assert.equal((await runs()).length, 0);
    assert.equal((await ada.request('POST', `/threads/${closed}/minutes/draft`)).status, 202);
  });

  test('the wrong kind of thread, and a Deferred project, are refused', async () => {
    const discussion = await start(ada, { kind: 'discussion', title: 'Release plan' });
    const meeting = await start(ada, { kind: 'meeting', title: 'Weekly check-in' });
    await post(ada, discussion);
    await post(ada, meeting);
    assert.equal((await ada.request('POST', `/threads/${discussion}/minutes/draft`)).status, 404);
    assert.equal((await ada.request('POST', `/threads/${meeting}/analyse`, {})).status, 404);
    assert.equal((await ada.request('POST', `/threads/${meeting}/analyse-selected`, { messageIds: [uuidv7()] })).status, 404);
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    assert.equal((await ada.request('POST', `/threads/${discussion}/analyse`, {})).status, 403);
    assert.equal((await ada.request('POST', `/threads/${meeting}/minutes/draft`)).status, 403);
    assert.equal((await runs()).length, 0);
  });

  test('Draft minutes on an ended meeting by a participant in the audience works', async () => {
    const meeting = await start(ada, { kind: 'meeting', title: 'Weekly check-in' });
    await post(ada, meeting, 'Agreed to ship.');
    await post(ben, meeting, 'Fine by me.');
    assert.equal((await ada.request('POST', `/threads/${meeting}/end`)).status, 200);
    const [final] = await runs();
    assert.equal(final.trigger, 'meeting_end');
    await finish(2);
    const r = await ben.request('POST', `/threads/${meeting}/minutes/draft`);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual([r.body.kind, r.body.trigger, r.body.requestedBy, r.body.coversFromNo], ['minutes', 'button', ids.ben, 1]);
    assert.equal(jobs.length, 2);
    assert.equal((await outsider.request('POST', `/threads/${meeting}/minutes/draft`)).status, 404);
  });

  test('Analyse now while a run is active answers "already active", even with nothing new', async () => {
    const thread = await start(ada, { kind: 'discussion', title: 'Release plan' });
    await post(ada, thread);
    assert.equal((await ada.request('POST', `/threads/${thread}/analyse`, {})).status, 202);
    await finish(1);
    await t.pool.query(`INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, created_at) VALUES ($1, $2, 'proposals', 'button', $3, 'queued', now())`, [uuidv7(), thread, ids.ada]);
    const r = await ben.request('POST', `/threads/${thread}/analyse`, {});
    assert.deepEqual([r.status, r.body.message], [409, ALREADY_ACTIVE]);
  });

  test('ending a meeting queues one meeting_end run', async () => {
    const meeting = await start(ada, { kind: 'meeting', title: 'Weekly check-in' });
    await post(ada, meeting, 'Agreed to ship.');
    assert.equal((await ada.request('POST', `/threads/${meeting}/end`)).status, 200);
    const all = await runs();
    assert.equal(all.length, 1);
    assert.deepEqual([all[0].kind, all[0].trigger, all[0].requested_by, all[0].status, all[0].thread_id], ['minutes', 'meeting_end', null, 'queued', meeting]);
    assert.deepEqual(jobs, [all[0].id]);
    assert.deepEqual(explicit, [false], 'automatic');
    assert.equal((await ada.request('POST', `/threads/${meeting}/end`)).status, 409, 'ending twice is refused and queues nothing more');
    assert.equal((await runs()).length, 1);
  });

  test('ending a meeting queues nothing when a person edited the minutes, or nothing was said, and the meeting still ends', async () => {
    const edited = await start(ada, { kind: 'meeting', title: 'Edited minutes' });
    await post(ada, edited);
    await t.pool.query(
      `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, created_by, created_at) VALUES ($1, $2, 1, 'human', 'Edited minutes', 0, $3, $4)`,
      [uuidv7(), edited, ids.ada, t.clock.now()],
    );
    const silent = await start(ada, { kind: 'meeting', title: 'Silent' });
    assert.equal((await ada.request('POST', `/threads/${edited}/end`)).status, 200);
    assert.equal((await ada.request('POST', `/threads/${silent}/end`)).status, 200);
    assert.equal((await runs()).length, 0);
    assert.equal(jobs.length, 0);
  });

  test('ending a meeting that already has an active run starts no second one', async () => {
    const meeting = await start(ada, { kind: 'meeting', title: 'Weekly check-in' });
    await post(ada, meeting);
    assert.equal((await ada.request('POST', `/threads/${meeting}/minutes/draft`)).status, 202);
    assert.equal((await ada.request('POST', `/threads/${meeting}/end`)).status, 200);
    assert.equal((await runs()).length, 1);
  });
});
