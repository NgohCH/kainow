import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { DISCUSSION_PREAMBLE, EXTRACTION_SYSTEM_PROMPT } from '../extraction/prompt';
import { ExtractionRunner } from '../extraction/runner';
import { ModelCallError, type ModelClient, type ModelRequest, type ModelResult, type RawItem } from '../extraction/model';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { AnalysisRunner } from './analysis-runner';
import { insertRun } from './runs';

const USAGE = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 };

class FakeModel implements ModelClient {
  calls: ModelRequest[] = [];
  constructor(public next: (req: ModelRequest) => ModelResult | Promise<ModelResult>) {}
  async extract(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req);
    return this.next(req);
  }
}

type FakeItem = Omit<RawItem, 'due_event' | 'alternatives'>;
const answer = (items: FakeItem[]): ModelResult => ({ meetingDate: null, items: items.map((i) => ({ due_event: null, alternatives: [], ...i })), usage: USAGE });
const item = (quote: string, text = 'Proposal', kind: FakeItem['kind'] = 'decision'): FakeItem => ({ kind, text, owner: null, due: kind === 'action' ? 'by 20 November 2026' : null, source_quote: quote });

describe('analysis runner (discussion proposals)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let ada: Client;
  let ids: Record<string, string>;
  let project: string;
  let thread: string;
  let spend: SpendService;

  const post = async (c: Client, body: string, to = thread) => {
    const r = await c.request('POST', `/threads/${to}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    t.clock.advanceSeconds(1);
    return r.body.id as string;
  };
  const queueRun = (over: { requestedBy?: string | null; trigger?: 'quiet_period' | 'button' | 'selection'; from?: number; selected?: string[]; threadId?: string } = {}) =>
    insertRun(t.pool, {
      threadId: over.threadId ?? thread,
      kind: 'proposals',
      trigger: over.trigger ?? 'button',
      requestedBy: over.requestedBy === undefined ? ids.ada : over.requestedBy,
      coversFromNo: over.from ?? 1,
      coversThroughNo: null,
      selectedMessageIds: over.selected,
      at: t.clock.now(),
    });
  const runner = (model: ModelClient | null) => new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction: new ExtractionRunner({ pool: t.pool, spend, model, clock: t.clock.now }) });
  const analysisRun = async (id: string) => (await t.pool.query(`SELECT * FROM analysis_runs WHERE id = $1`, [id])).rows[0];
  const itemsOf = async (extractionRunId: string) => (await t.pool.query(`SELECT * FROM extraction_items WHERE run_id = $1 ORDER BY position`, [extractionRunId])).rows;
  const spendEntries = async () => (await t.pool.query(`SELECT * FROM ai_spend_entries ORDER BY created_at, id`)).rows;
  /** Marks the thread's active run done so another can be queued. */
  const settle = (id: string) => t.pool.query(`UPDATE analysis_runs SET status = 'succeeded', finished_at = $2 WHERE id = $1`, [id, t.clock.now()]);

  beforeEach(async () => {
    t = await startTestApp();
    ids = {};
    for (const k of ['admin', 'pm', 'ada', 'bob']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.bob, role: 'member' },
      ],
    });
    await new SpendSettingsService(t.pool, t.clock.now).apply(MVP_SPEND_SETTINGS, ids.admin);
    spend = new SpendService(t.pool, t.clock.now);
    ada = await t.signIn('ada@example.org');
    const r = await ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Release plan' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    thread = r.body.id;
  });
  afterEach(async () => {
    await t.close();
  });

  test('proposals quote new messages with offsets and spans', async () => {
    await post(ada, 'Hello team.');
    await post(ada, 'We decided to ship on Friday.');
    await post(ada, 'Bob will email the vendor.');
    const model = new FakeModel(() => answer([item('ship on Friday'), item('Bob will email the vendor.'), item('Nothing like this was said.'), item('Hello team.\n\nx')]));
    const id = await queueRun();
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');

    const run = await analysisRun(id);
    assert.equal(run.status, 'succeeded');
    assert.deepEqual([run.covers_from_no, run.covers_through_no, run.attempts], [1, 3, 1]);
    assert.ok(run.started_at && run.finished_at);

    const src = (await t.pool.query(`SELECT s.*, v.origin, v.text_content AS text, v.created_by AS version_creator, v.version_no FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE v.id = $1`, [run.source_version_id])).rows[0];
    const thr = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [thread])).rows[0];
    assert.deepEqual([src.kind, src.title, src.thread_id, src.audience_id, src.project_id, src.created_by], ['discussion', 'Discussion: Release plan', thread, thr.audience_id, project, ids.ada]);
    assert.deepEqual([src.origin, src.version_creator, src.version_no], ['discussion', ids.ada, 1]);

    const spans = (await t.pool.query(`SELECT * FROM transcript_spans WHERE source_version_id = $1 ORDER BY header_start`, [run.source_version_id])).rows;
    assert.deepEqual(spans.map((s) => [s.message_no, s.is_context]), [[1, false], [2, false], [3, false]]);
    assert.equal(src.text.slice(spans[1].body_start, spans[1].body_end), 'We decided to ship on Friday.');
    assert.ok(src.text.slice(spans[1].header_start).startsWith('[#2 · ada · 2026-11-09 10:0'));

    const ex = (await t.pool.query(`SELECT * FROM extraction_runs WHERE id = $1`, [run.extraction_run_id])).rows[0];
    assert.deepEqual([ex.trigger, ex.requested_by, ex.status, ex.item_count, ex.unlocated_count, ex.source_version_id], ['discussion', ids.ada, 'succeeded', 4, 2, run.source_version_id]);
    const items = await itemsOf(ex.id);
    assert.equal(src.text.slice(items[0].quote_start, items[0].quote_end), 'ship on Friday');
    assert.equal(items[0].quote_matches, 1);
    assert.ok(items[0].quote_start >= spans[1].body_start && items[0].quote_end <= spans[1].body_end);
    assert.equal(src.text.slice(items[1].quote_start, items[1].quote_end), 'Bob will email the vendor.');
    assert.deepEqual([items[2].quote_matches, items[2].quote_start], [0, null]);
    assert.deepEqual([items[3].quote_matches, items[3].quote_start], [0, null], 'a quote across two messages is not placed');
    assert.equal(model.calls[0].user, src.text, 'what was stored is exactly what was sent');
  });

  test('repeated items are dropped and counted', async () => {
    await post(ada, 'We agreed to use the shared budget.');
    await post(ada, 'The vendor must confirm.');
    const first = await queueRun();
    assert.equal(await runner(new FakeModel(() => answer([item('shared budget')]))).process(first, 1, false), 'succeeded');
    await post(ada, 'Ship on Friday.');
    const second = await queueRun({ from: 3 });
    const model = new FakeModel(() => answer([item('shared budget', 'Old'), item('The vendor must confirm.', 'Old two'), item('Ship on Friday.', 'New')]));
    assert.equal(await runner(model).process(second, 1, false), 'succeeded');

    const run = await analysisRun(second);
    assert.equal(run.repeated_count, 2);
    assert.deepEqual([run.covers_from_no, run.covers_through_no], [3, 3]);
    const ex = (await t.pool.query(`SELECT * FROM extraction_runs WHERE id = $1`, [run.extraction_run_id])).rows[0];
    assert.equal(ex.item_count, 1);
    const items = await itemsOf(ex.id);
    assert.deepEqual(items.map((i) => i.text), ['New']);
    assert.ok(model.calls[0].user.includes('--- New messages ---'));
    const spans = (await t.pool.query(`SELECT message_no, is_context FROM transcript_spans WHERE source_version_id = $1 ORDER BY header_start`, [run.source_version_id])).rows;
    assert.deepEqual(spans.map((s) => [s.message_no, s.is_context]), [[1, true], [2, true], [3, false]]);
    const sources = (await t.pool.query(`SELECT count(*)::int AS n FROM sources WHERE kind = 'discussion' AND thread_id = $1`, [thread])).rows[0].n;
    assert.equal(sources, 1, 'one discussion source per thread');
    const versions = (await t.pool.query(`SELECT version_no FROM source_versions WHERE source_id = (SELECT id FROM sources WHERE thread_id = $1) ORDER BY version_no`, [thread])).rows;
    assert.deepEqual(versions.map((v) => v.version_no), [1, 2]);
  });

  test('spend purpose is discussion_analysis with the requester or null', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const model = new FakeModel(() => answer([item('ship on Friday')]));
    const byAda = await queueRun();
    assert.equal(await runner(model).process(byAda, 1, false), 'succeeded');
    await post(ada, 'Another decision: hire two testers.');
    const auto = await queueRun({ requestedBy: null, trigger: 'quiet_period', from: 2 });
    assert.equal(await runner(model).process(auto, 1, false), 'succeeded');
    const entries = await spendEntries();
    assert.deepEqual(entries.map((e) => [e.purpose, e.actor_user_id, e.status]), [['discussion_analysis', ids.ada, 'confirmed'], ['discussion_analysis', null, 'confirmed']]);
    const run = await analysisRun(auto);
    const ex = (await t.pool.query(`SELECT requested_by, trigger FROM extraction_runs WHERE id = $1`, [run.extraction_run_id])).rows[0];
    assert.deepEqual([ex.requested_by, ex.trigger], [null, 'discussion']);
    const src = (await t.pool.query(`SELECT created_by FROM sources WHERE thread_id = $1`, [thread])).rows[0];
    assert.equal(src.created_by, ids.ada, 'the source keeps the person who first caused it');
  });

  test('an automatic first run creates the source with no creator', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const auto = await queueRun({ requestedBy: null, trigger: 'quiet_period' });
    assert.equal(await runner(new FakeModel(() => answer([item('ship on Friday')]))).process(auto, 1, false), 'succeeded');
    const src = (await t.pool.query(`SELECT s.created_by, v.created_by AS version_by FROM sources s JOIN source_versions v ON v.source_id = s.id WHERE s.thread_id = $1`, [thread])).rows[0];
    assert.deepEqual([src.created_by, src.version_by], [null, null]);
  });

  test('deleted message after queueing is not in the transcript', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const secretMsg = await post(ada, 'Private remark about Sam that was removed.');
    await post(ada, 'Bob will email the vendor.');
    const hidden = await post(ada, 'Hidden remark about the budget.');
    const id = await queueRun();
    await t.pool.query(`UPDATE discussion_messages SET state = 'deleted', state_reason = 'removed', state_by = $2, state_at = $3 WHERE id = $1`, [secretMsg, ids.pm, t.clock.now()]);
    await t.pool.query(`UPDATE discussion_messages SET state = 'hidden', state_reason = 'off topic', state_by = $2, state_at = $3 WHERE id = $1`, [hidden, ids.pm, t.clock.now()]);
    const model = new FakeModel(() => answer([item('ship on Friday')]));
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');
    const sent = model.calls[0].user;
    assert.ok(!sent.includes('Private remark') && !sent.includes('Hidden remark'));
    assert.ok(!sent.includes('[#2 ') && !sent.includes('[#4 '));
    const run = await analysisRun(id);
    assert.deepEqual([run.covers_from_no, run.covers_through_no], [1, 3], 'the cursor reflects what was sent');
    const spans = (await t.pool.query(`SELECT message_no FROM transcript_spans WHERE source_version_id = $1 ORDER BY message_no`, [run.source_version_id])).rows;
    assert.deepEqual(spans.map((s) => s.message_no), [1, 3]);
  });

  test('a message edited after queueing is sent as its current version', async () => {
    const m = await post(ada, 'Original wording about launch.');
    const id = await queueRun();
    const edit = await ada.request('PUT', `/messages/${m}`, { body: 'Revised wording about launch.', basedOnVersion: 1 });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');
    assert.ok(model.calls[0].user.includes('Revised wording') && !model.calls[0].user.includes('Original wording'));
  });

  test('project deferred after queueing blocks without spend', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const byAda = await queueRun();
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    const model = new FakeModel(() => answer([item('ship on Friday')]));
    assert.equal(await runner(model).process(byAda, 1, false), 'blocked');
    const run = await analysisRun(byAda);
    assert.equal(run.status, 'blocked');
    assert.equal(run.failure_code, 'project_not_open');
    assert.ok(run.finished_at);
    assert.deepEqual([model.calls.length, (await spendEntries()).length], [0, 0]);

    // An automatic run has no person to name in the reason.
    const auto = await queueRun({ requestedBy: null, trigger: 'quiet_period' });
    assert.equal(await runner(model).process(auto, 1, false), 'blocked');
    const autoRun = await analysisRun(auto);
    assert.equal(autoRun.failure_code, 'project_not_open');
    assert.ok(!/person|who asked/i.test(autoRun.failure_detail), autoRun.failure_detail);
    assert.deepEqual([model.calls.length, (await spendEntries()).length], [0, 0]);
  });

  test('a project deferred after the snapshot stops a retry, and the extraction run ends blocked too', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    const model = new FakeModel(() => {
      throw new ModelCallError('The AI service did not answer.', 'unknown', true);
    });
    assert.equal(await runner(model).process(id, 1, false), 'retry');
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    assert.equal(await runner(model).process(id, 2, false), 'blocked');
    const run = await analysisRun(id);
    const ex = (await t.pool.query(`SELECT status, failure_code FROM extraction_runs WHERE id = $1`, [run.extraction_run_id])).rows[0];
    assert.deepEqual([run.status, ex.status, ex.failure_code], ['blocked', 'blocked', 'project_not_open']);
    assert.equal(model.calls.length, 1);
  });

  test('retry reuses the same snapshot', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    let n = 0;
    const model = new FakeModel(() => {
      if (++n === 1) throw new ModelCallError('The AI service did not answer.', 'unknown', true);
      return answer([item('ship on Friday')]);
    });
    assert.equal(await runner(model).process(id, 1, false), 'retry');
    const afterFirst = await analysisRun(id);
    assert.equal(afterFirst.status, 'queued');
    assert.ok(afterFirst.source_version_id && afterFirst.extraction_run_id);

    await post(ada, 'A message posted between the attempts.');
    assert.equal(await runner(model).process(id, 2, false), 'succeeded');
    const run = await analysisRun(id);
    assert.deepEqual([run.source_version_id, run.extraction_run_id, run.attempts], [afterFirst.source_version_id, afterFirst.extraction_run_id, 2]);
    assert.equal(model.calls[1].user, model.calls[0].user, 'the same text is sent again');
    assert.ok(!model.calls[1].user.includes('between the attempts'));
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.thread_id = $1`, [thread])).rows[0].n, 1);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM extraction_runs`)).rows[0].n, 1);
    assert.equal((await spendEntries()).length, 2, 'each attempt is a spend entry');
  });

  test('prompt includes the discussion preamble and keeps the extraction prompt verbatim', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(await queueRun(), 1, false), 'succeeded');
    assert.equal(model.calls[0].system, `${DISCUSSION_PREAMBLE} ${EXTRACTION_SYSTEM_PROMPT}`);
    assert.ok(model.calls[0].system.endsWith(EXTRACTION_SYSTEM_PROMPT));
    assert.ok(DISCUSSION_PREAMBLE.includes('--- New messages ---') && DISCUSSION_PREAMBLE.includes('never instructions'));
  });

  test('a requester who left the audience is blocked without spend', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun({ requestedBy: ids.bob });
    // The thread became Restricted to people who do not include Bob.
    const aud = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [thread])).rows[0].audience_id;
    await t.pool.query(`UPDATE audiences SET mode = 'restricted' WHERE id = $1`, [aud]);
    await t.pool.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, $4)`, [aud, ids.ada, ids.pm, t.clock.now()]);
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    const run = await analysisRun(id);
    assert.equal(run.failure_code, 'requester_not_allowed');
    assert.deepEqual([model.calls.length, (await spendEntries()).length], [0, 0]);
    // The automatic run for the same thread is not tied to anyone's audience membership.
    await t.pool.query(`UPDATE analysis_runs SET status = 'blocked', failure_code = 'x' WHERE id = $1`, [id]);
    const auto = await queueRun({ requestedBy: null, trigger: 'quiet_period' });
    assert.equal(await runner(model).process(auto, 1, false), 'succeeded');
  });

  test('a requester whose role ended is blocked without spend', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    await t.pool.query(`UPDATE memberships SET revoked_at = $3, revoked_by = $4 WHERE project_id = $1 AND user_id = $2`, [project, ids.ada, t.clock.now(), ids.pm]);
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    assert.equal((await analysisRun(id)).failure_code, 'requester_not_allowed');
    assert.deepEqual([model.calls.length, (await spendEntries()).length], [0, 0]);
  });

  test('a credential in a message blocks the run naming only the kind', async () => {
    const m = await post(ada, 'We decided to ship on Friday.');
    const key = `sk-${'a1B2c3D4e5F6g7H8i9J0'}kLmN`;
    const mm = (await t.pool.query(`SELECT id FROM discussion_messages WHERE id = $1`, [m])).rows[0].id;
    await t.pool.query(`INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, 2, $3, 'x', $4)`, [uuidv7(), mm, `Use ${key} for the vendor`, t.clock.now()]);
    const model = new FakeModel(() => answer([]));
    const id = await queueRun();
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    const run = await analysisRun(id);
    assert.equal(run.failure_code, 'secret_found');
    assert.ok(!run.failure_detail.includes(key));
    assert.match(run.failure_detail, /API secret key/);
    assert.deepEqual([model.calls.length, (await spendEntries()).length, run.source_version_id], [0, 0, null]);
  });

  test('a run with no visible messages left is blocked with a plain reason', async () => {
    const m = await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    await t.pool.query(`UPDATE discussion_messages SET state = 'deleted', state_reason = 'removed', state_by = $2, state_at = $3 WHERE id = $1`, [m, ids.pm, t.clock.now()]);
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    const run = await analysisRun(id);
    assert.equal(run.failure_code, 'nothing_to_analyse');
    assert.deepEqual([model.calls.length, (await spendEntries()).length], [0, 0]);
  });

  test('a selection run sends only the selected messages that are still visible and keeps its selection', async () => {
    const a = await post(ada, 'Selected remark one about launch.');
    await post(ada, 'Unselected remark two.');
    const c = await post(ada, 'Selected remark three about budget.');
    await post(ada, 'Later remark four.');
    const id = await queueRun({ trigger: 'selection', selected: [a, c] });
    await t.pool.query(`UPDATE discussion_messages SET state = 'hidden', state_reason = 'off topic', state_by = $2, state_at = $3 WHERE id = $1`, [c, ids.pm, t.clock.now()]);
    const model = new FakeModel(() => answer([item('Selected remark one about launch.')]));
    assert.equal(await runner(model).process(id, 1, false), 'succeeded');
    const sent = model.calls[0].user;
    const after = sent.slice(sent.indexOf('--- New messages ---'));
    assert.ok(after.includes('Selected remark one') && !after.includes('remark three') && !after.includes('Unselected') && !after.includes('Later remark'));
    const run = await analysisRun(id);
    assert.deepEqual(run.selected_message_ids, [a, c]);
    assert.deepEqual([run.covers_from_no, run.covers_through_no], [1, 1]);
  });

  test('a selection run whose messages are all gone is blocked', async () => {
    const a = await post(ada, 'Selected remark one about launch.');
    await post(ada, 'Other remark.');
    const id = await queueRun({ trigger: 'selection', selected: [a] });
    await t.pool.query(`UPDATE discussion_messages SET state = 'deleted', state_reason = 'removed', state_by = $2, state_at = $3 WHERE id = $1`, [a, ids.pm, t.clock.now()]);
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'blocked');
    assert.equal((await analysisRun(id)).failure_code, 'nothing_to_analyse');
    assert.equal(model.calls.length, 0);
  });

  test('review item from a transcript names message number and author', async () => {
    const pm = await t.signIn('pm@example.org');
    await post(ada, 'Hello team.');
    const second = await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    assert.equal(await runner(new FakeModel(() => answer([item('ship on Friday', 'Ship on Friday', 'action'), item('Nothing like this was said.')]))).process(id, 1, false), 'succeeded');
    const run = await analysisRun(id);
    const threadRow = (await t.pool.query(`SELECT created_at FROM discussion_messages WHERE id = $1`, [second])).rows[0];

    const review = await pm.request('GET', `/extractions/${run.extraction_run_id}`);
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.deepEqual(review.body.items[0].discussionEvidence, { threadId: thread, messageNo: 2, authorName: 'ada', at: threadRow.created_at.toISOString() });
    assert.equal(review.body.items[1].discussionEvidence, null, 'an unplaced quote has no message');

    // The approved record carries the same evidence; a hidden message shows the flag and names nobody.
    const auth = await pm.request('POST', `/extractions/${run.extraction_run_id}/items/${review.body.items[0].id}/authorise`, {
      sourceVersionId: run.source_version_id,
      assigneeId: ids.ada,
      dueOn: '2026-11-20',
    });
    assert.equal(auth.status, 201, JSON.stringify(auth.body));
    const evidence = async () => (await ada.request('GET', `/projects/${project}/records`)).body.tasks[0].source;
    assert.deepEqual((await evidence()).discussionEvidence, { threadId: thread, messageNo: 2, authorName: 'ada', at: threadRow.created_at.toISOString() });
    await t.pool.query(`UPDATE discussion_messages SET state = 'hidden', state_reason = 'off topic', state_by = $2, state_at = $3 WHERE id = $1`, [second, ids.pm, t.clock.now()]);
    const hidden = await evidence();
    assert.deepEqual([hidden.sourceFlag, hidden.discussionEvidence], ['hidden', null]);
    assert.equal((await pm.request('GET', `/extractions/${run.extraction_run_id}`)).body.items[0].discussionEvidence, null);
  });

  test('a restricted source gives an outsider no evidence', async () => {
    const pm = await t.signIn('pm@example.org');
    const bob = await t.signIn('bob@example.org');
    await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    assert.equal(await runner(new FakeModel(() => answer([item('ship on Friday', 'Ship on Friday', 'action')]))).process(id, 1, false), 'succeeded');
    const run = await analysisRun(id);
    const review = await pm.request('GET', `/extractions/${run.extraction_run_id}`);
    const auth = await pm.request('POST', `/extractions/${run.extraction_run_id}/items/${review.body.items[0].id}/authorise`, {
      sourceVersionId: run.source_version_id,
      assigneeId: ids.ada,
      dueOn: '2026-11-20',
    });
    assert.equal(auth.status, 201, JSON.stringify(auth.body));
    const aud = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [thread])).rows[0].audience_id;
    assert.equal((await pm.request('PUT', `/audiences/${aud}`, { mode: 'restricted', namedUserIds: [ids.ada], reason: 'Sensitive' })).status, 200);
    const task = (await bob.request('GET', `/projects/${project}/records`)).body.tasks[0];
    assert.deepEqual(task.source, { restricted: true });
  });

  test('a finished run is skipped', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    await settle(id);
    const model = new FakeModel(() => answer([]));
    assert.equal(await runner(model).process(id, 1, false), 'skipped');
    assert.equal(model.calls.length, 0);
  });

  test('a failed AI call fails the analysis run with the extraction outcome', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    const model = new FakeModel(() => {
      throw new ModelCallError('The AI service refused the request.', 'rejected', false, 400);
    });
    assert.equal(await runner(model).process(id, 1, true), 'failed');
    const run = await analysisRun(id);
    assert.deepEqual([run.status, run.failure_code], ['failed', 'model_rejected']);
    assert.ok(run.failure_detail && run.finished_at);
  });

  test('the internal error text names the analysis, not an extraction', async () => {
    await post(ada, 'We decided to ship on Friday.');
    const id = await queueRun();
    const model = new FakeModel(() => {
      throw new Error('boom');
    });
    assert.equal(await runner(model).process(id, 1, true), 'failed');
    const run = await analysisRun(id);
    assert.equal(run.failure_code, 'internal_error');
    assert.match(run.failure_detail, /stopped the analysis/);
  });
});
