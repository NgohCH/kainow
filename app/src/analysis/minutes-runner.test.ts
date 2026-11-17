import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { ModelBadResponse, type MinutesModel, type ModelRequest } from '../extraction/model';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { CasesService } from '../quarantine/cases.service';
import { AnalysisRunner } from './analysis-runner';
import { MinutesRunner } from './minutes-runner';
import type { MinutesAnswer } from './minutes';
import { insertRun } from './runs';

const USAGE = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 };
const ANSWER: MinutesAnswer = {
  summary: 'We agreed to ship.',
  discussionPoints: ['Timing'],
  decisions: ['Ship on Friday'],
  actionItems: [{ text: 'Email the vendor', owner: 'Bob', due: null }],
  openQuestions: [],
  risks: [],
};
type Answer = MinutesAnswer & { usage: typeof USAGE };

class FakeModel implements MinutesModel {
  calls: ModelRequest[] = [];
  constructor(public next: (req: ModelRequest) => Answer | Promise<Answer> = () => ({ ...ANSWER, usage: USAGE })) {}
  async draftMinutes(req: ModelRequest): Promise<Answer> {
    this.calls.push(req);
    return this.next(req);
  }
}

describe('minutes runner', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let ada: Client;
  let ids: Record<string, string>;
  let project: string;
  let meeting: string;
  let spend: SpendService;

  const post = async (c: Client, body: string) => {
    const r = await c.request('POST', `/threads/${meeting}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    t.clock.advanceSeconds(1);
    return r.body.id as string;
  };
  const queueRun = (over: { requestedBy?: string | null; trigger?: 'quiet_period' | 'meeting_end' | 'button' } = {}) =>
    insertRun(t.pool, {
      threadId: meeting,
      kind: 'minutes',
      trigger: over.trigger ?? 'button',
      requestedBy: over.requestedBy === undefined ? ids.ada : over.requestedBy,
      coversFromNo: 1,
      coversThroughNo: null,
      at: t.clock.now(),
    });
  const runner = (model: MinutesModel | null) => new MinutesRunner({ pool: t.pool, spend, model, clock: t.clock.now });
  const run = async (id: string) => (await t.pool.query(`SELECT * FROM analysis_runs WHERE id = $1`, [id])).rows[0];
  const drafts = async () => (await t.pool.query(`SELECT * FROM minutes_drafts WHERE thread_id = $1 ORDER BY version_no`, [meeting])).rows;
  const entries = async () => (await t.pool.query(`SELECT * FROM ai_spend_entries ORDER BY created_at, id`)).rows;
  /** Ends the run so another can be queued for the same meeting. */
  const retire = (id: string) => t.pool.query(`UPDATE analysis_runs SET status = 'succeeded' WHERE id = $1`, [id]);
  const withdraw = (where: string, value: string | number, state: 'deleted' | 'hidden') =>
    t.pool.query(`UPDATE discussion_messages SET state = $3, state_reason = 'test', state_by = $4, state_at = $5 WHERE thread_id = $1 AND ${where} = $2`, [
      meeting,
      value,
      state,
      ids.ada,
      t.clock.now(),
    ]);

  beforeEach(async () => {
    t = await startTestApp();
    ids = {};
    for (const k of ['admin', 'pm', 'ada', 'bob']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.bob, role: 'member' },
      ],
    });
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    spend = new SpendService(t.pool, t.clock.now);
    ada = await t.signIn('ada@example.org');
    const r = await ada.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Weekly check-in', meetingDate: '2026-11-11' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    meeting = r.body.id;
  });
  afterEach(async () => {
    await t.close();
  });

  test('a late success after the run was stalled inserts no draft and does not revive it', async () => {
    await post(ada, 'Shall we ship on Friday?');
    const id = await queueRun();
    const model = new FakeModel(async () => {
      await t.pool.query(`UPDATE analysis_runs SET status = 'failed', failure_code = 'stalled', failure_detail = 'x', finished_at = now() WHERE id = $1`, [id]);
      return { ...ANSWER, usage: USAGE };
    });
    assert.equal(await runner(model).process(id, 1, false), 'skipped');
    assert.deepEqual(await drafts(), []);
    const r = await run(id);
    assert.deepEqual([r.status, r.failure_code, r.minutes_draft_id], ['failed', 'stalled', null]);
    assert.equal((await entries()).length, 1, 'the call was made: its spend is recorded');
    assert.equal(await runner(model).process(id, 2, false), 'skipped');
    assert.equal(model.calls.length, 1, 'a late retry makes no second call');
  });

  test('button draft saves an ai version covering the newest message', async () => {
    await post(ada, 'Shall we ship on Friday?');
    await post(ada, 'Yes, Bob emails the vendor.');
    await t.pool.query(`INSERT INTO meeting_attendees (thread_id, user_id, marked_by, marked_at) VALUES ($1, $2, $3, $4), ($1, $5, $3, $4)`, [
      meeting,
      ids.ada,
      ids.ada,
      t.clock.now(),
      ids.bob,
    ]);
    const model = new FakeModel();
    const id = await queueRun();
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');

    const row = await run(id);
    const [draft] = await drafts();
    assert.deepEqual([row.status, row.attempts, row.covers_from_no, row.covers_through_no, row.minutes_draft_id], ['succeeded', 1, 1, 2, draft.id]);
    assert.ok(row.started_at && row.finished_at);
    assert.deepEqual([draft.origin, draft.version_no, draft.covers_through_no, draft.analysis_run_id, draft.created_by], ['ai', 1, 2, id, null]);
    assert.ok(draft.body.startsWith('# Weekly check-in\nDate: 11 November 2026\nPresent: ada, bob\nDrafted by AI from messages #1–#2\n'), draft.body);
    assert.ok(draft.body.includes('- Email the vendor — Owner: Bob; Due: not stated'));
    assert.equal(model.calls.length, 1);
    assert.match(model.calls[0].user, /^\[#1 · ada · 2026-11-\d\d \d\d:\d\d\]\nShall we ship on Friday\?\n\n\[#2 · ada · /);
    assert.ok(!model.calls[0].user.includes('--- New messages ---'));
  });

  test('automatic draft skipped when a human version appeared after queueing', async () => {
    await post(ada, 'Shall we ship on Friday?');
    const auto = await queueRun({ requestedBy: null, trigger: 'quiet_period' });
    await t.pool.query(
      `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, created_by, created_at) VALUES ($1, $2, 1, 'human', 'Edited by hand', 0, $3, $4)`,
      [uuidv7(), meeting, ids.ada, t.clock.now()],
    );
    const model = new FakeModel();
    assert.equal(await runner(model).process(auto, 1, false), 'blocked');
    const row = await run(auto);
    assert.deepEqual([row.status, row.failure_code, row.failure_detail], ['blocked', 'human_edited', 'Automatic minutes paused: edited by a person.']);
    assert.equal(model.calls.length, 0);
    assert.equal((await entries()).length, 0);
    assert.equal((await drafts()).length, 1);

    // The button still drafts, as a new ai version.
    const button = await queueRun();
    assert.equal(await runner(model).process(button, 1, false), 'succeeded');
    assert.deepEqual((await drafts()).map((d) => [d.version_no, d.origin]), [[1, 'human'], [2, 'ai']]);
  });

  test('automatic draft not saved when a person saved a version during the AI call', async () => {
    await post(ada, 'Shall we ship on Friday?');
    const auto = await queueRun({ requestedBy: null, trigger: 'quiet_period' });
    const model = new FakeModel(async () => {
      await t.pool.query(
        `INSERT INTO minutes_drafts (id, thread_id, version_no, origin, body, covers_through_no, created_by, created_at) VALUES ($1, $2, 1, 'human', 'Edited by hand', 0, $3, $4)`,
        [uuidv7(), meeting, ids.ada, t.clock.now()],
      );
      return { ...ANSWER, usage: USAGE };
    });
    assert.equal(await runner(model).process(auto, 1, false), 'blocked');
    const row = await run(auto);
    assert.deepEqual([row.status, row.failure_code, row.failure_detail, row.minutes_draft_id], ['blocked', 'human_edited', 'Automatic minutes paused: edited by a person.', null]);
    assert.deepEqual((await drafts()).map((d) => d.origin), ['human']);
    assert.equal((await entries()).length, 1, 'the call was made, so it stays charged');
  });

  test('too long meeting fails without a request', async () => {
    for (let i = 0; i < 14; i++) await post(ada, 'y'.repeat(9_000));
    const model = new FakeModel();
    const id = await queueRun();
    assert.equal(await runner(model).process(id, 1, false), 'failed');
    const row = await run(id);
    assert.deepEqual([row.status, row.failure_code, row.failure_detail], ['failed', 'too_long', 'This meeting is too long to draft in one request.']);
    assert.equal(model.calls.length, 0);
    assert.equal((await entries()).length, 0);
    assert.equal((await drafts()).length, 0);
  });

  test('spend purpose minutes_draft', async () => {
    await post(ada, 'Shall we ship on Friday?');
    const named = await queueRun();
    assert.equal(await runner(new FakeModel()).process(named, 1, false), 'succeeded');
    const auto = await queueRun({ requestedBy: null, trigger: 'meeting_end' });
    assert.equal(await runner(new FakeModel()).process(auto, 1, false), 'succeeded');
    const rows = await entries();
    assert.deepEqual(rows.map((e) => [e.purpose, e.status]), [['minutes_draft', 'confirmed'], ['minutes_draft', 'confirmed']]);
    assert.deepEqual(rows.map((e) => e.actor_user_id).sort(), [ids.ada, null].sort());
  });

  test('deleted message after queueing is not sent', async () => {
    await post(ada, 'Public remark about the schedule.');
    const withdrawn = await post(ada, 'Private remark that was withdrawn.');
    await post(ada, 'Closing remark.');
    const id = await queueRun();
    await withdraw('id', withdrawn, 'deleted');
    const model = new FakeModel();
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');
    assert.ok(!model.calls[0].user.includes('Private remark'));
    assert.ok(model.calls[0].user.includes('[#3 · ada'));
    const row = await run(id);
    assert.deepEqual([row.covers_from_no, row.covers_through_no], [1, 3]);

    // A retry rebuilds the input from what is visible then: a deletion between attempts is honoured too.
    await retire(id);
    const again = await queueRun();
    const flaky = new FakeModel(() => {
      throw new ModelBadResponse('cut off', USAGE);
    });
    assert.equal(await runner(flaky).process(again, 1, false), 'retry');
    await withdraw('message_no', 3, 'hidden');
    const second = new FakeModel();
    assert.equal(await runner(second).process(again, 2, false), 'succeeded');
    assert.ok(!second.calls[0].user.includes('Closing remark'));
    assert.equal((await run(again)).covers_through_no, 1);
  });

  test('bad response fails visibly and saves nothing', async () => {
    await post(ada, 'Shall we ship on Friday?');
    const id = await queueRun();
    const bad = new FakeModel(() => {
      throw new ModelBadResponse('The minutes answer was malformed: summary', USAGE);
    });
    assert.equal(await runner(bad).process(id, 1, false), 'retry');
    assert.equal((await run(id)).status, 'queued');
    assert.equal(await runner(bad).process(id, 3, true), 'failed');
    const row = await run(id);
    assert.deepEqual([row.status, row.failure_code, row.failure_detail, row.minutes_draft_id], ['failed', 'bad_response', 'The minutes answer was malformed: summary', null]);
    assert.equal((await drafts()).length, 0);
    const spent = await entries();
    assert.equal(spent.length, 2);
    assert.ok(spent.every((e) => e.purpose === 'minutes_draft' && e.status === 'confirmed'), 'a bad answer is still charged');
  });

  test('minutes finding a stored key in a message opens a case on that message and blocks without charge', async () => {
    const first = await post(ada, 'We agreed to ship on Friday.');
    const m = await post(ada, 'Shall we ship on Friday?');
    const key = `sk-${'a1B2c3D4e5F6g7H8i9J0'}kLmN`;
    await t.pool.query(`INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, 2, $3, 'x', $4)`, [uuidv7(), m, `Use ${key} for the vendor`, t.clock.now()]);
    const model = new FakeModel();
    const id = await queueRun();
    const withCases = new MinutesRunner({ pool: t.pool, spend, model, clock: t.clock.now, quarantine: t.app.get(CasesService) });
    assert.equal(await withCases.process(id, 1, false), 'blocked');
    assert.equal((await run(id)).failure_code, 'secret_found');
    assert.equal(model.calls.length, 0);
    assert.equal((await entries()).length, 0);
    const cases = (await t.pool.query(`SELECT * FROM quarantine_cases`)).rows;
    assert.equal(cases.length, 1);
    assert.deepEqual([cases[0].item_kind, cases[0].item_id, cases[0].reporter_id], ['message', m, null]);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM discussion_messages WHERE id = $1`, [first])).rows[0].held_case_id, null);
    assert.equal((await t.pool.query(`SELECT held_case_id FROM discussion_messages WHERE id = $1`, [m])).rows[0].held_case_id, cases[0].id);
  });

  test('a secret and a deferred project block without a request', async () => {
    const m = await post(ada, 'Shall we ship on Friday?');
    const key = `sk-${'a1B2c3D4e5F6g7H8i9J0'}kLmN`;
    await t.pool.query(`INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, 2, $3, 'x', $4)`, [uuidv7(), m, `Use ${key} for the vendor`, t.clock.now()]);
    const model = new FakeModel();
    const secret = await queueRun();
    assert.equal(await runner(model).process(secret, 1, false), 'blocked');
    const s = await run(secret);
    assert.equal(s.failure_code, 'secret_found');
    assert.ok(s.failure_detail.includes('API secret key') && !s.failure_detail.includes(key));

    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    const deferred = await queueRun();
    assert.equal(await runner(model).process(deferred, 1, false), 'blocked');
    assert.equal((await run(deferred)).failure_code, 'project_not_open');
    assert.equal(model.calls.length, 0);
    assert.equal((await entries()).length, 0);
  });

  test('the analysis runner hands minutes runs over, and no key fails without a charge', async () => {
    await post(ada, 'Shall we ship on Friday?');
    const id = await queueRun();
    const dispatcher = new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction: { process: async () => 'skipped' }, minutes: runner(null) });
    assert.equal(await dispatcher.process(id, 1, true), 'failed');
    assert.equal((await run(id)).failure_code, 'model_not_configured');
    assert.equal((await entries()).length, 0);
  });
});
