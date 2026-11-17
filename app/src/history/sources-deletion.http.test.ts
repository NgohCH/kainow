import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AnalysisRunner } from '../analysis/analysis-runner';
import { MinutesRunner } from '../analysis/minutes-runner';
import { insertRun } from '../analysis/runs';
import { AssistRunner } from '../assist/assist-runner';
import { findMaterial } from '../assist/material';
import { uuidv7 } from '../common/uuid7';
import { SOURCE_FLAG_TEXT } from '../discussion/masking';
import type { JsonSchemaModel, MinutesModel, ModelClient, ModelRequest, ModelResult } from '../extraction/model';
import { ExtractionRunner } from '../extraction/runner';
import { ProjectAccess } from '../projects/access.service';
import type { Usage } from '../spend/cost';
import { MVP_SPEND_SETTINGS } from '../spend/mvp-settings';
import { SpendService } from '../spend/spend.service';
import { SpendSettingsService } from '../spend/spend.settings';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const USAGE: Usage = { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 };
const KEY = `sk-${'a1B2c3D4e5'.repeat(3)}`;
const REASON_REFUSAL = 'Give a reason (up to 1,000 characters).';
const PLANT = 'The kestrel pump service is booked for Thursday morning.';

/** Answers a question citing one marker. */
class AnswerModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  constructor(private readonly marker: string) {}
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ answer_markdown: `The pump service is on Thursday [${this.marker}].`, not_found: false, cited: [this.marker] }), usage: USAGE };
  }
}

/** Drafts a summary with the given body. */
class SummaryModel implements JsonSchemaModel {
  calls: ModelRequest[] = [];
  constructor(private readonly body: string) {}
  async callJson(req: ModelRequest): Promise<{ content: unknown; usage: Usage }> {
    this.calls.push(req);
    return { content: JSON.stringify({ summary_markdown: this.body, omitted_categories: [] }), usage: USAGE };
  }
}

/** Proposes one action quoting the notes. */
class ExtractModel implements ModelClient {
  calls: ModelRequest[] = [];
  async extract(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req);
    return {
      meetingDate: null,
      items: [{ kind: 'action', text: 'Order kestrel valves', owner: null, due: null, due_event: null, alternatives: [], source_quote: 'The kestrel pump service is booked' }],
      usage: USAGE,
    };
  }
}

/** Counts every call; a blocked run must never reach it. */
class CountingModel implements ModelClient, MinutesModel, JsonSchemaModel {
  calls = 0;
  async extract(): Promise<ModelResult> {
    this.calls++;
    throw new Error('the AI must not be called');
  }
  async draftMinutes(): Promise<never> {
    this.calls++;
    throw new Error('the AI must not be called');
  }
  async callJson(): Promise<never> {
    this.calls++;
    throw new Error('the AI must not be called');
  }
}

interface Source {
  marker: string;
  location: string | null;
}

describe('deleting and restoring sources', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let own: Client;
  let spo: Client;
  let dep: Client;
  let ada: Client;
  let ben: Client;
  let auditor: Client;
  let queued: string[];

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const spend = () => new SpendService(t.pool, t.clock.now);
  const note = async (title: string, text: string, c: Client = pm) => {
    const r = await c.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };
  const del = (c: Client, id: string, reason: unknown = 'Imported into the wrong project') => c.request('POST', `/sources/${id}/delete`, { reason });
  const restore = (c: Client, id: string, reason: unknown = 'It belongs here after all') => c.request('POST', `/sources/${id}/restore`, { reason });
  const deleted = async (c: Client, id: string) => {
    const r = await del(c, id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const restrict = async (sourceId: string, namedUserIds: string[]) => {
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id;
    const r = await pm.request('PUT', `/audiences/${audienceId}`, { mode: 'restricted', namedUserIds, reason: 'Leaders only' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const startThread = async (c: Client, body: Record<string, unknown>) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const post = async (c: Client, thread: string, body: string) => {
    const r = await c.request('POST', `/threads/${thread}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  /** `c` asks about the pump; the AI answers citing the Plant room passage. */
  const answered = async (c: Client) => {
    const r = await c.request('POST', `/projects/${project}/questions`, { question: 'When is the kestrel pump service?' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const plant = (r.body.sources as Source[]).find((s) => s.location?.startsWith('Plant room')) as Source;
    assert.ok(plant, JSON.stringify(r.body.sources));
    const runner = new AssistRunner({ pool: t.pool, spend: spend(), model: new AnswerModel(plant.marker), clock: t.clock.now });
    assert.equal(await runner.process(r.body.id, 1, false), 'succeeded');
    t.clock.advanceSeconds(1);
    return r.body.id as string;
  };
  /** An extraction of version 1 of a note, run by the AI: the run id. */
  const extracted = async (sourceId: string) => {
    const r = await pm.request('POST', `/notes/${sourceId}/versions/1/extractions`);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const runner = new ExtractionRunner({ pool: t.pool, spend: spend(), model: new ExtractModel(), clock: t.clock.now });
    assert.equal(await runner.process(r.body.run.id, 1, false), 'succeeded');
    return r.body.run.id as string;
  };
  const personal = async (userId: string) => ({
    kind: 'personal' as const,
    ctx: (await t.app.get(ProjectAccess).load(project, { id: userId, email: 'x@example.org', displayName: 'x', role: 'member' }))!,
  });

  beforeEach(async () => {
    queued = [];
    t = await startTestApp(undefined, { assistQueue: { enqueue: async (id: string) => void queued.push(id) } });
    for (const k of ['pm', 'own', 'spo', 'dep', 'ada', 'ben', 'auditor']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.own, role: 'owner' },
        { userId: ids.spo, role: 'sponsor' },
        { userId: ids.dep, role: 'deputy_pm' },
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
    [pm, own, spo, dep, ada, ben, auditor] = [
      await t.signIn('pm@example.org'),
      await t.signIn('own@example.org'),
      await t.signIn('spo@example.org'),
      await t.signIn('dep@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('auditor@example.org'),
    ];
  });
  afterEach(async () => {
    await t.close();
  });

  test('PM deletes notes with a reason; Member refused', async () => {
    const id = await note('Plant room', PLANT);
    // A Member, a Deputy and a grant holder may not delete.
    for (const c of [ada, dep, auditor]) assert.equal((await del(c, id)).status, 403);
    // A reason is required, up to 1,000 characters, without a credential.
    for (const reason of [null, '', '   ', 'x'.repeat(1001), 42]) {
      const r = await del(pm, id, reason);
      assert.equal(r.status, 400);
      assert.equal(r.body.message, REASON_REFUSAL);
    }
    const secret = await del(pm, id, `the key was ${KEY}`);
    assert.equal(secret.status, 400);
    assert.match(secret.body.message, /API secret key \(sk-\)/);
    assert.ok(!JSON.stringify(secret.body).includes(KEY), 'the key is not repeated');
    assert.equal(await count(`SELECT count(*) AS n FROM source_events`), 0);
    assert.equal((await t.pool.query(`SELECT status FROM sources WHERE id = $1`, [id])).rows[0].status, 'active');

    t.clock.advanceSeconds(5);
    const r = await del(pm, id, '  Imported into the wrong project  ');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { id, status: 'deleted' });
    const row = (await t.pool.query(`SELECT status, deleted_by, deleted_at, delete_reason FROM sources WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { status: 'deleted', deleted_by: ids.pm, deleted_at: t.clock.now(), delete_reason: 'Imported into the wrong project' });
    const events = (await t.pool.query(`SELECT source_id, project_id, kind, actor_id, reason, at FROM source_events`)).rows;
    assert.deepEqual(events, [{ source_id: id, project_id: project, kind: 'deleted', actor_id: ids.pm, reason: 'Imported into the wrong project', at: t.clock.now() }]);
    const audit = (await t.pool.query(`SELECT action, actor_user_id, subject_type, subject_id, detail FROM audit_events WHERE action = 'source.deleted'`)).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].actor_user_id, audit[0].subject_type, audit[0].subject_id], [ids.pm, 'source', id]);
    assert.ok(!JSON.stringify(audit[0].detail).includes('wrong project') && !JSON.stringify(audit[0].detail).includes('kestrel'), 'no reason or text in the audit');

    // Gone for everyone; deleting again is refused.
    assert.equal((await pm.request('GET', `/notes/${id}`)).status, 404);
    assert.equal((await pm.request('GET', `/notes/${id}/versions/1`)).status, 404);
    assert.equal((await del(pm, id)).status, 409);
    // The Owner and a Sponsor may delete too; outside the project the source does not exist.
    await deleted(own, await note('Owner note', 'Owner text'));
    await deleted(spo, await note('Sponsor note', 'Sponsor text'));
    const outsider = await seedUser(t.pool, 'outsider@example.org');
    assert.ok(outsider);
    const stranger = await t.signIn('outsider@example.org');
    assert.equal((await del(stranger, await note('Another', 'More text'))).status, 404);
    assert.equal((await del(pm, '0197c3a0-0000-7000-8000-000000000000')).status, 404);
    assert.equal((await del(pm, 'not-a-uuid')).status, 404);
  });

  test('deleting a discussion transcript source is refused', async () => {
    const thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
    await post(ada, thread, 'Shall we move the filter order?');
    const run = await insertRun(t.pool, { threadId: thread, kind: 'proposals', trigger: 'button', requestedBy: ids.ada, coversFromNo: 1, coversThroughNo: null, at: t.clock.now() });
    await new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction: { process: async () => 'skipped' } }).process(run, 1, false);
    const transcript = (await t.pool.query(`SELECT id FROM sources WHERE thread_id = $1 AND kind = 'discussion'`, [thread])).rows[0].id as string;
    const r = await del(pm, transcript);
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'A discussion transcript is not deleted directly; delete its messages instead.');
    assert.equal((await t.pool.query(`SELECT status FROM sources WHERE id = $1`, [transcript])).rows[0].status, 'active');
    assert.equal(await count(`SELECT count(*) AS n FROM source_events`), 0);
  });

  test('deleting a source is refused while Deferred, restoring works', async () => {
    const gone = await note('Plant room', PLANT);
    const kept = await note('Kept', 'Kept text');
    await deleted(pm, gone);
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    const refused = await del(pm, kept);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, 'Only the Project Manager, the Owner or a Sponsor can delete a source, and not while the project is Deferred or Closed.');
    assert.equal((await restore(ada, gone)).status, 403);
    const r = await restore(pm, gone);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { id: gone, status: 'active' });
    const row = (await t.pool.query(`SELECT status, deleted_by, deleted_at, delete_reason FROM sources WHERE id = $1`, [gone])).rows[0];
    assert.deepEqual(row, { status: 'active', deleted_by: null, deleted_at: null, delete_reason: null });
    // Only a deleted source can be restored.
    assert.equal((await restore(pm, kept)).status, 409);
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [project]);
    assert.equal((await pm.request('GET', `/notes/${gone}`)).status, 200);
  });

  test('deleted notes vanish from the notes list, global search and Ask material', async () => {
    const id = await note('Kestrel plan', PLANT);
    const other = await note('Other', 'Nothing to see.');
    const runId = await extracted(id);
    // An edit of the proposal, so every search branch over it has a row.
    const item = (await t.pool.query(`SELECT id, source_version_id AS "versionId" FROM extraction_items WHERE run_id = $1`, [runId])).rows[0];
    const edit = await pm.request('POST', `/extractions/${runId}/items/${item.id}/edit`, { sourceVersionId: item.versionId, text: 'Order the kestrel valves twice' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));

    const listed = async (c: Client) => ((await c.request('GET', `/projects/${project}/notes`)).body.sources as Array<{ id: string }>).map((s) => s.id).sort();
    const found = async (c: Client, word: string) => {
      const r = await c.request('GET', `/search?q=${encodeURIComponent(word)}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return (r.body.projects as Array<{ results: Array<{ kind: string; id: string }> }>).flatMap((p) => p.results.map((x) => `${x.kind}:${x.id}`)).sort();
    };
    const material = async (userId: string) => {
      const items = await findMaterial(t.pool, await personal(userId), ['kestrel']);
      return items.map((i) => i.passageId ?? `${i.recordKind}:${i.recordId}`).length;
    };
    // Before: the title, the text, the model's wording and its edit are each found.
    assert.deepEqual(await listed(ada), [id, other].sort());
    assert.deepEqual(await found(ada, 'Kestrel plan'), [`note:${id}`]);
    assert.deepEqual(await found(ada, 'booked for Thursday'), [`note:${id}`]);
    assert.deepEqual(await found(ada, 'Order kestrel valves'), [`ai_proposal:${item.id}`]);
    assert.deepEqual(await found(ada, 'kestrel valves twice'), [`ai_proposal:${item.id}`]);
    assert.ok((await material(ids.ada)) >= 2, 'the passage and the pending proposal are material');

    await deleted(pm, id);
    for (const c of [ada, pm, auditor]) {
      assert.deepEqual(await listed(c), [other]);
      for (const word of ['Kestrel plan', 'booked for Thursday', 'Order kestrel valves', 'kestrel valves twice']) assert.deepEqual(await found(c, word), [], word);
    }
    for (const u of [ids.ada, ids.pm]) assert.equal(await material(u), 0);

    await t.clock.advanceSeconds(1);
    assert.equal((await restore(pm, id)).status, 200);
    assert.deepEqual(await listed(ada), [id, other].sort());
    assert.deepEqual(await found(ada, 'Kestrel plan'), [`note:${id}`]);
  });

  test('a shared answer built on deleted notes goes to review; a private one is withdrawn', async () => {
    const id = await note('Plant room', PLANT);
    const thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
    const shared = await answered(ada);
    assert.equal((await ada.request('POST', `/questions/${shared}/share`, { threadId: thread })).status, 200);
    const mine = await answered(ben);
    await deleted(pm, id);
    const states = (await t.pool.query(`SELECT request_id AS id, review_state AS state, review_reason AS reason FROM ai_answers ORDER BY request_id`)).rows;
    assert.deepEqual(
      Object.fromEntries(states.map((s) => [s.id, [s.state, s.reason]])),
      { [shared]: ['review_required', 'material_removed'], [mine]: ['withdrawn', 'material_removed'] },
    );
    const causes = (await t.pool.query(`SELECT target_id, action, detail->>'cause' AS cause FROM ai_assist_events WHERE actor_id IS NULL ORDER BY target_id`)).rows;
    assert.deepEqual(causes.map((c) => [c.target_id, c.action, c.cause]).sort(), [[shared, 'review_required', 'deleted'], [mine, 'withdrawn', 'deleted']].sort());
    assert.equal((await ben.request('GET', `/questions/${mine}`)).status, 404);
  });

  test('deleting an approved summary source withdraws the summary', async () => {
    const original = await note('Board note', 'The turbine replacement goes ahead next month.');
    await restrict(original, [ids.ada]);
    const asked = await dep.request('POST', `/sources/${original}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const runner = new AssistRunner({ pool: t.pool, spend: spend(), model: new SummaryModel('The turbine is replaced next month.'), clock: t.clock.now });
    assert.equal(await runner.process(queued[queued.length - 1], 1, false), 'succeeded');
    t.clock.advanceSeconds(1);
    const approved = await pm.request('POST', `/summaries/${asked.body.id}/approve`, { versionNo: 1, reason: 'Fine to share' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const summarySource = approved.body.approved.sourceId as string;
    const listed = async () => ((await ben.request('GET', `/projects/${project}/notes`)).body.sources as Array<{ id: string }>).map((s) => s.id);
    assert.ok((await listed()).includes(summarySource));

    t.clock.advanceSeconds(1);
    await deleted(pm, summarySource);
    assert.equal((await t.pool.query(`SELECT state FROM summaries WHERE id = $1`, [asked.body.id])).rows[0].state, 'withdrawn');
    const event = (await t.pool.query(`SELECT actor_id, reason, detail FROM ai_assist_events WHERE action = 'summary_withdrawn' AND target_id = $1`, [asked.body.id])).rows;
    assert.equal(event.length, 1);
    assert.equal(event[0].actor_id, ids.pm);
    assert.equal(event[0].detail.cause, 'source_deleted');
    assert.ok(!(await listed()).includes(summarySource));

    // Restoring the source brings the summary back as it was (PO, 18 Nov 2026); the preview names its readers.
    t.clock.advanceSeconds(1);
    const preview = await pm.request('GET', `/sources/${summarySource}/restore-preview`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok((preview.body.names as string[]).length > 1, JSON.stringify(preview.body));
    assert.equal((await t.pool.query(`SELECT state FROM summaries WHERE id = $1`, [asked.body.id])).rows[0].state, 'withdrawn');
    assert.equal((await restore(pm, summarySource)).status, 200);
    assert.equal((await t.pool.query(`SELECT state FROM summaries WHERE id = $1`, [asked.body.id])).rows[0].state, 'approved');
    assert.ok((await listed()).includes(summarySource));
    const back = (await t.pool.query(`SELECT actor_id, detail FROM ai_assist_events WHERE action = 'summary_restored' AND target_id = $1`, [asked.body.id])).rows;
    assert.deepEqual(back, [{ actor_id: ids.pm, detail: { to: 'approved', cause: 'source_restored' } }]);
  });

  test('a summary changed after its source was deleted stays withdrawn when the source is restored', async () => {
    const original = await note('Board note', 'The turbine replacement goes ahead next month.');
    await restrict(original, [ids.ada]);
    const asked = await dep.request('POST', `/sources/${original}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' });
    const runner = new AssistRunner({ pool: t.pool, spend: spend(), model: new SummaryModel('The turbine is replaced next month.'), clock: t.clock.now });
    assert.equal(await runner.process(queued[queued.length - 1], 1, false), 'succeeded');
    t.clock.advanceSeconds(1);
    const approved = await pm.request('POST', `/summaries/${asked.body.id}/approve`, { versionNo: 1, reason: 'Fine to share' });
    const summarySource = approved.body.approved.sourceId as string;
    t.clock.advanceSeconds(1);
    await deleted(pm, summarySource);
    // Something else happened to the summary after the deletion withdrew it (here a later withdrawal for another cause).
    t.clock.advanceSeconds(1);
    await t.pool.query(
      `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, reason, detail, at) VALUES ($1, $2, $3, 'summary_withdrawn', 'summary', $4, 'Other cause', '{"from":"withdrawn"}', $5)`,
      [uuidv7(), project, ids.pm, asked.body.id, t.clock.now()],
    );
    t.clock.advanceSeconds(1);
    assert.equal((await restore(pm, summarySource)).status, 200);
    assert.equal((await t.pool.query(`SELECT state FROM summaries WHERE id = $1`, [asked.body.id])).rows[0].state, 'withdrawn');
    assert.equal((await t.pool.query(`SELECT 1 FROM ai_assist_events WHERE action = 'summary_restored'`)).rowCount, 0);
  });

  test('approving a summary version containing an sk- key is refused', async () => {
    const original = await note('Board note', 'The turbine replacement goes ahead next month.');
    await restrict(original, [ids.ada]);
    const asked = await dep.request('POST', `/sources/${original}/summaries`, { intendedAudience: { mode: 'project' }, leaveOut: '' });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const runner = new AssistRunner({ pool: t.pool, spend: spend(), model: new SummaryModel(`The turbine portal key is ${KEY}.`), clock: t.clock.now });
    assert.equal(await runner.process(queued[queued.length - 1], 1, false), 'succeeded');
    t.clock.advanceSeconds(1);
    const r = await pm.request('POST', `/summaries/${asked.body.id}/approve`, { versionNo: 1, reason: 'Fine to share' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.message, /API secret key \(sk-\)/);
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.equal((await t.pool.query(`SELECT state, summary_source_id FROM summaries WHERE id = $1`, [asked.body.id])).rows[0].summary_source_id, null);
    assert.equal(await count(`SELECT count(*) AS n FROM sources WHERE kind = 'summary'`), 0);
  });

  test('proposal from deleted notes shows Source deleted — review and restoring clears it', async () => {
    assert.equal(SOURCE_FLAG_TEXT.source_deleted, 'Source deleted — review');
    const id = await note('Plant room', PLANT);
    const runId = await extracted(id);
    const items = async () => (await pm.request('GET', `/extractions/${runId}`)).body.items as Array<{ sourceFlag: string | null; quote: string | null; quoteMasked?: string | null }>;
    assert.deepEqual((await items()).map((i) => [i.sourceFlag, i.quote]), [[null, 'The kestrel pump service is booked']]);
    await deleted(pm, id);
    assert.deepEqual((await items()).map((i) => [i.sourceFlag, i.quote, i.quoteMasked]), [['source_deleted', null, 'source_deleted']]);
    // Nothing changes automatically: the proposal is still pending.
    assert.equal((await t.pool.query(`SELECT review_status FROM extraction_items WHERE run_id = $1`, [runId])).rows[0].review_status, 'pending');
    t.clock.advanceSeconds(1);
    assert.equal((await restore(pm, id)).status, 200);
    assert.deepEqual((await items()).map((i) => [i.sourceFlag, i.quote]), [[null, 'The kestrel pump service is booked']]);
  });

  test('extraction queued before deletion ends blocked with no spend entry', async () => {
    const id = await note('Plant room', PLANT);
    const r = await pm.request('POST', `/notes/${id}/versions/1/extractions`);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await deleted(pm, id);
    const model = new CountingModel();
    assert.equal(await new ExtractionRunner({ pool: t.pool, spend: spend(), model, clock: t.clock.now }).process(r.body.run.id, 1, false), 'blocked');
    const run = (await t.pool.query(`SELECT status, failure_code, failure_detail FROM extraction_runs WHERE id = $1`, [r.body.run.id])).rows[0];
    assert.deepEqual(run, { status: 'blocked', failure_code: 'source_deleted', failure_detail: 'The source was deleted, so the extraction did not run.' });
    assert.equal(model.calls, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries`), 0);
  });

  test('analysis queued before its transcript source was deleted ends blocked with no spend entry', async () => {
    const thread = await startThread(pm, { kind: 'discussion', title: 'Plant' });
    await post(ada, thread, 'Shall we move the filter order?');
    const run = await insertRun(t.pool, { threadId: thread, kind: 'proposals', trigger: 'button', requestedBy: ids.ada, coversFromNo: 1, coversThroughNo: null, at: t.clock.now() });
    // The first attempt stores the transcript and stops before the extraction runs; the next attempt is a retry.
    await new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction: { process: async () => 'retry' } }).process(run, 1, false);
    // A transcript is never deleted through the endpoint; the start check still covers a deleted one.
    await t.pool.query(
      `UPDATE sources SET status = 'deleted', deleted_by = $2, deleted_at = now(), delete_reason = 'test' WHERE thread_id = $1 AND kind = 'discussion'`,
      [thread, ids.pm],
    );
    const model = new CountingModel();
    const extraction = new ExtractionRunner({ pool: t.pool, spend: spend(), model, clock: t.clock.now });
    assert.equal(await new AnalysisRunner({ pool: t.pool, clock: t.clock.now, extraction }).process(run, 2, false), 'blocked');
    const row = (await t.pool.query(`SELECT status, failure_code FROM analysis_runs WHERE id = $1`, [run])).rows[0];
    assert.deepEqual(row, { status: 'blocked', failure_code: 'source_deleted' });
    assert.equal(model.calls, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries`), 0);
  });

  test('minutes queued before the meeting minutes were deleted end blocked with no spend entry', async () => {
    const meeting = await startThread(ada, { kind: 'meeting', title: 'Weekly check-in' });
    await post(ada, meeting, 'We agreed to move the filter order.');
    const audienceId = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [meeting])).rows[0].audience_id;
    const minutes = uuidv7();
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id, publication)
       VALUES ($1, 'Weekly check-in', $2, now(), $3, 'minutes', $4, $5, 'published')`,
      [minutes, ids.pm, project, audienceId, meeting],
    );
    const run = await insertRun(t.pool, { threadId: meeting, kind: 'minutes', trigger: 'button', requestedBy: ids.ada, coversFromNo: 1, coversThroughNo: null, at: t.clock.now() });
    await deleted(pm, minutes);
    const model = new CountingModel();
    assert.equal(await new MinutesRunner({ pool: t.pool, spend: spend(), model, clock: t.clock.now }).process(run, 1, false), 'blocked');
    const row = (await t.pool.query(`SELECT status, failure_code FROM analysis_runs WHERE id = $1`, [run])).rows[0];
    assert.deepEqual(row, { status: 'blocked', failure_code: 'source_deleted' });
    assert.equal(model.calls, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries`), 0);
  });

  test('AI request queued before deletion ends blocked with no spend entry', async () => {
    const id = await note('Plant room', PLANT);
    const r = await ada.request('POST', `/projects/${project}/questions`, { question: 'When is the kestrel pump service?' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await deleted(pm, id);
    const model = new CountingModel();
    assert.equal(await new AssistRunner({ pool: t.pool, spend: spend(), model, clock: t.clock.now }).process(r.body.id, 1, false), 'blocked');
    const row = (await t.pool.query(`SELECT status, failure_code, failure_detail FROM ai_requests WHERE id = $1`, [r.body.id])).rows[0];
    assert.deepEqual(row, { status: 'blocked', failure_code: 'source_deleted', failure_detail: 'A source this request used was deleted, so the AI request did not run.' });
    assert.equal(model.calls, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_spend_entries`), 0);
  });

  test('restore preview lists the current audience by name', async () => {
    const id = await note('Plant room', PLANT);
    await restrict(id, [ids.ada]);
    // Only a deleted source has a restore preview.
    assert.equal((await pm.request('GET', `/sources/${id}/restore-preview`)).status, 409);
    await deleted(pm, id);
    const r = await pm.request('GET', `/sources/${id}/restore-preview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { names: ['ada', 'dep', 'own', 'pm', 'spo'] });
    // A role ended since counts: the current audience, not the one at deletion.
    await t.pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $2 WHERE project_id = $1 AND user_id = $3`, [project, ids.own, ids.dep]);
    assert.deepEqual((await pm.request('GET', `/sources/${id}/restore-preview`)).body, { names: ['ada', 'own', 'pm', 'spo'] });
    // Ada is in the audience but may not restore; Ben is outside it and finds nothing.
    assert.equal((await ada.request('GET', `/sources/${id}/restore-preview`)).status, 403);
    assert.equal((await ben.request('GET', `/sources/${id}/restore-preview`)).status, 404);
    assert.equal((await restore(ben, id)).status, 404);
  });

  test('restore starts no extraction and brings back no withdrawn answer', async () => {
    const id = await note('Plant room', PLANT);
    const mine = await answered(ada);
    await deleted(pm, id);
    assert.equal((await t.pool.query(`SELECT review_state FROM ai_answers WHERE request_id = $1`, [mine])).rows[0].review_state, 'withdrawn');
    const tables = ['extraction_runs', 'analysis_runs', 'ai_requests', 'notifications', 'email_outbox', 'ai_spend_entries'];
    const before = await Promise.all(tables.map((x) => count(`SELECT count(*) AS n FROM ${x}`)));
    const queuedBefore = queued.length;
    t.clock.advanceSeconds(60);
    const r = await restore(pm, id, '  Imported by mistake into the wrong place, it belongs here  ');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await Promise.all(tables.map((x) => count(`SELECT count(*) AS n FROM ${x}`))), before);
    assert.equal(queued.length, queuedBefore);
    assert.equal((await t.pool.query(`SELECT review_state FROM ai_answers WHERE request_id = $1`, [mine])).rows[0].review_state, 'withdrawn');
    const events = (await t.pool.query(`SELECT kind, actor_id, reason FROM source_events WHERE source_id = $1 ORDER BY at, id`, [id])).rows;
    assert.deepEqual(events, [
      { kind: 'deleted', actor_id: ids.pm, reason: 'Imported into the wrong project' },
      { kind: 'restored', actor_id: ids.pm, reason: 'Imported by mistake into the wrong place, it belongs here' },
    ]);
    const audit = (await t.pool.query(`SELECT subject_id, detail FROM audit_events WHERE action = 'source.restored'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].subject_id, id);
    assert.ok(!JSON.stringify(audit[0].detail).includes('mistake'));
  });
  test('a held source is refused delete and restore', async () => {
    const live = await note('Plant room', PLANT);
    const gone = await note('Old room', 'Old text.');
    await deleted(pm, gone);
    for (const id of [live, gone]) {
      const caseId = uuidv7();
      await t.pool.query(
        `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, marked_length, reported_at) VALUES ($1, $2, 'source', $3, $4, 12, now())`,
        [caseId, project, id, ids.pm],
      );
      await t.pool.query(`UPDATE sources SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
    }
    const held = 'Held — suspected credential, under review. It can be deleted or restored once the case is released.';
    for (const r of [await del(pm, live), await restore(pm, gone), await pm.request('GET', `/sources/${gone}/restore-preview`)]) {
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.message, held);
    }
    assert.deepEqual((await t.pool.query(`SELECT status FROM sources WHERE id = ANY($1::uuid[]) ORDER BY id`, [[live, gone].sort()])).rows.map((r) => r.status), [live, gone].sort().map((id) => (id === live ? 'active' : 'deleted')));
    assert.equal(await count(`SELECT count(*) AS n FROM source_events`), 1, 'only the earlier deletion');
  });
});
