import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { insertAiDraft } from './meetings.service';

const KEY = `sk-${'a1B2c3D4e5'.repeat(3)}`;
const CORRECTION = 'The draft says the pump was replaced but nobody said that.';
const DRAFT_BODY = '# Draft\nPump agreed on Friday.';

describe('feedback on AI output', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let deputy: Client;
  let ada: Client;
  let ben: Client;
  let admin: Client;
  let outsider: Client;
  let meeting: string;
  let draftId: string;
  let runId: string;
  let itemId: string;
  let extractionRunId: string;

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const flag = (c: Client, extra: Record<string, unknown> = {}, projectId = project) =>
    c.request('POST', `/projects/${projectId}/feedback`, { targetKind: 'minutes_draft', targetId: draftId, category: 'incorrect', note: CORRECTION, ...extra });
  const seedMeeting = async (c: Client, body: Record<string, unknown>) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const seedRun = async (threadId: string, extractionRun: string | null = null) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, extraction_run_id, created_at) VALUES ($1, $2, 'minutes', 'button', $3, 'succeeded', $4, now())`,
      [id, threadId, ids.ada, extractionRun],
    );
    return id;
  };
  const seedDraft = async (threadId: string, body: string, run: string) => {
    await insertAiDraft(t.pool, threadId, { body, coversThroughNo: 1, analysisRunId: run });
    return (await t.pool.query(`SELECT id FROM minutes_drafts WHERE analysis_run_id = $1`, [run])).rows[0].id as string;
  };
  const seedSpend = (requestId: string, model: string) =>
    t.pool.query(
      `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, model_id,
         input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro, myr_per_usd_micro, estimate_micro_myr, amount_micro_myr, project_id)
       VALUES ($1, $2, 1, now(), now(), 'confirmed', 'minutes_draft', $3, 1, 1, 1, 1, 5, 5, $4)`,
      [uuidv7(), requestId, model, project],
    );

  beforeEach(async () => {
    t = await startTestApp(undefined, { automaticAnalysis: { isOn: async () => false } });
    for (const k of ['pm', 'deputy', 'ada', 'ben', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    ids.admin2 = await seedUser(t.pool, 'admin2@example.org', 'enterprise_administrator');
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    [pm, deputy, ada, ben, admin, outsider] = [
      await t.signIn('pm@example.org'),
      await t.signIn('deputy@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
      await t.signIn('admin@example.org'),
      await t.signIn('outsider@example.org'),
    ];
    meeting = await seedMeeting(ada, { kind: 'meeting', title: 'Weekly check-in' });
    // An extraction run (with a recorded model) and one proposal, from published minutes.
    assert.equal((await pm.request('POST', `/threads/${meeting}/minutes`, { body: 'Ali will email Sam.', basedOnVersion: 0 })).status, 201);
    const published = await pm.request('POST', `/threads/${meeting}/minutes/1/publish`);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const version = (await t.pool.query(`SELECT id FROM source_versions WHERE source_id = $1`, [published.body.sourceId])).rows[0].id;
    extractionRunId = uuidv7();
    await t.pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, model_id, created_at) VALUES ($1, $2, $3, 'succeeded', 'model-extract', now())`, [extractionRunId, version, ids.pm]);
    itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Ali emails Sam', 'Ali will email Sam.', 0, 19, 1, now())`,
      [itemId, extractionRunId, version],
    );
    runId = await seedRun(meeting);
    await seedSpend(runId, 'model-minutes');
    draftId = await seedDraft(meeting, DRAFT_BODY, runId);
  });
  afterEach(async () => {
    await t.close();
  });

  test('participant flags a draft', async () => {
    const r = await flag(ada);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'open');
    assert.equal(r.body.category, 'incorrect');
    assert.equal(r.body.note, CORRECTION);
    const events = (await t.pool.query(`SELECT action, from_status, to_status, note, actor_id FROM feedback_events WHERE feedback_id = $1`, [r.body.id])).rows;
    assert.deepEqual(events, [{ action: 'created', from_status: null, to_status: 'open', note: null, actor_id: ids.ada }]);
    // The audit event carries lengths and a hash, never the note.
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'feedback.created'`)).rows;
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes('pump'));
    assert.equal(audit[0].detail.noteLength, CORRECTION.length);
    // Runs and proposals can be flagged too; a note with a credential and a bad shape are refused.
    assert.equal((await flag(ben, { targetKind: 'analysis_run', targetId: runId, category: 'missed_item' })).status, 201);
    assert.equal((await flag(ben, { targetKind: 'proposal', targetId: itemId, category: 'misleading' })).status, 201);
    const secret = await flag(ada, { note: `see ${KEY}` });
    assert.equal(secret.status, 400);
    assert.ok(!JSON.stringify(secret.body).includes(KEY));
    assert.equal((await flag(ada, { note: '   ' })).status, 400);
    assert.equal((await flag(ada, { note: 'x'.repeat(2001) })).status, 400);
    assert.equal((await flag(ada, { category: 'bad' })).status, 400);
    assert.equal((await flag(ada, { targetKind: 'bad' })).status, 400);
    assert.equal(await count(`SELECT count(*) AS n FROM ai_feedback`), 3);
  });

  test('cannot flag what they cannot read (404)', async () => {
    const closed = await seedMeeting(pm, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    const closedRun = await seedRun(closed);
    const closedDraft = await seedDraft(closed, 'Secret plan.', closedRun);
    assert.equal((await flag(ben, { targetId: closedDraft })).status, 404);
    assert.equal((await flag(ben, { targetKind: 'analysis_run', targetId: closedRun })).status, 404);
    assert.equal((await flag(ada, { targetId: closedDraft })).status, 201);
    // A restricted published source hides its proposals.
    assert.equal((await pm.request('POST', `/threads/${closed}/minutes`, { body: 'Secret: Ali will sign.', basedOnVersion: 1 })).status, 201);
    const pub = await pm.request('POST', `/threads/${closed}/minutes/2/publish`);
    const ver = (await t.pool.query(`SELECT id FROM source_versions WHERE source_id = $1`, [pub.body.sourceId])).rows[0].id;
    const xr = uuidv7();
    await t.pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, created_at) VALUES ($1, $2, $3, 'succeeded', now())`, [xr, ver, ids.pm]);
    const hiddenItem = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at) VALUES ($1, $2, $3, 0, 'action', 'Ali signs', 'Ali will sign.', 8, 22, 1, now())`,
      [hiddenItem, xr, ver],
    );
    assert.equal((await flag(ben, { targetKind: 'proposal', targetId: hiddenItem })).status, 404);
    assert.equal((await flag(ada, { targetKind: 'proposal', targetId: hiddenItem })).status, 201);
    // Not a project member, an unknown target, a target in another project, a person's draft.
    assert.equal((await flag(outsider)).status, 404);
    assert.equal((await flag(ada, { targetId: uuidv7() })).status, 404);
    assert.equal((await flag(ada, { targetId: 'nope' })).status, 404);
    const other = await seedProject(t.pool, { status: 'active', members: [{ userId: ids.ada, role: 'member' }, { userId: ids.pm, role: 'pm' }, { userId: ids.pm, role: 'owner' }, { userId: ids.ben, role: 'member' }] });
    assert.equal((await flag(ada, {}, other)).status, 404, 'the draft belongs to another project');
    await pm.request('POST', `/threads/${meeting}/minutes`, { body: 'Human text.', basedOnVersion: 1 });
    const human = (await t.pool.query(`SELECT id FROM minutes_drafts WHERE origin = 'human'`)).rows[0].id;
    assert.equal((await flag(ada, { targetId: human })).status, 400);
  });

  test('Member sees only own feedback', async () => {
    await flag(ada);
    await flag(ben, { category: 'other' });
    const own = (await ada.request('GET', `/projects/${project}/feedback`)).body;
    assert.equal(own.feedback.length, 1);
    assert.equal(own.feedback[0].reporterId, ids.ada);
    assert.equal(own.canReview, false);
    for (const c of [pm, deputy]) {
      const all = (await c.request('GET', `/projects/${project}/feedback`)).body;
      assert.equal(all.feedback.length, 2);
      assert.equal(all.canReview, true);
    }
    assert.equal((await outsider.request('GET', `/projects/${project}/feedback`)).status, 404);
  });

  test('PM moves Open → Reviewed → Closed with notes; reopen returns Open', async () => {
    const id = (await flag(ada)).body.id;
    const set = (c: Client, status: string, note: string | null = 'Checked with the team.') => c.request('POST', `/feedback/${id}/status`, { status, note });
    assert.equal((await set(pm, 'closed')).status, 409, 'Open cannot skip to Closed');
    assert.equal((await set(pm, 'reviewed')).body.status, 'reviewed');
    assert.equal((await set(deputy, 'closed', 'Fixed in the next draft.')).body.status, 'closed');
    assert.equal((await set(pm, 'open', 'Reopened.')).body.status, 'open');
    assert.equal((await set(pm, 'open')).status, 409, 'no change');
    assert.equal((await set(pm, 'reviewed', null)).status, 400, 'a note is required');
    assert.equal((await set(pm, 'reviewed', `see ${KEY}`)).status, 400);
    const events = (await t.pool.query(`SELECT action, from_status, to_status, note FROM feedback_events WHERE feedback_id = $1 ORDER BY at, id`, [id])).rows;
    // The test clock does not move, so events share one time; order them by the note they carry.
    const order = [null, 'Checked with the team.', 'Fixed in the next draft.', 'Reopened.'];
    events.sort((x, y) => order.indexOf(x.note) - order.indexOf(y.note));
    assert.deepEqual(
      events.map((e) => [e.action, e.from_status, e.to_status, e.note]),
      [['created', null, 'open', null], ['status', 'open', 'reviewed', 'Checked with the team.'], ['status', 'reviewed', 'closed', 'Fixed in the next draft.'], ['status', 'closed', 'open', 'Reopened.']],
    );
    // The reporter sees the new status.
    assert.equal((await ada.request('GET', `/projects/${project}/feedback`)).body.feedback[0].status, 'open');
  });

  test('Member cannot review (403)', async () => {
    const id = (await flag(ada)).body.id;
    assert.equal((await ada.request('POST', `/feedback/${id}/status`, { status: 'reviewed', note: 'ok' })).status, 403);
    assert.equal((await ada.request('POST', `/feedback/${id}/escalate`, { note: 'ok' })).status, 403);
    assert.equal((await outsider.request('POST', `/feedback/${id}/status`, { status: 'reviewed', note: 'ok' })).status, 404);
    assert.equal((await pm.request('POST', `/feedback/${uuidv7()}/status`, { status: 'reviewed', note: 'ok' })).status, 404);
    assert.equal((await pm.request('GET', '/admin/feedback')).status, 403);
    assert.equal(await count(`SELECT count(*) AS n FROM feedback_events WHERE feedback_id = $1`, [id]), 1);
  });

  test('escalation shows the Administrator no correction note, draft or message text', async () => {
    await ada.request('POST', `/threads/${meeting}/messages`, { body: 'Private chatter about the pump invoice.' });
    const id = (await flag(ada)).body.id;
    const proposal = (await flag(ben, { targetKind: 'proposal', targetId: itemId, category: 'missed_item', note: 'Nobody owns the invoice.' })).body.id;
    const missing = (await flag(ben, { targetKind: 'analysis_run', targetId: await seedRun(await seedMeeting(ben, { kind: 'meeting', title: 'Other' })), note: 'Skipped a topic.' })).body.id;
    const note = 'Wrong model output; please look at the prompt.';
    assert.equal((await pm.request('POST', `/feedback/${id}/escalate`, { note })).status, 200);
    assert.equal((await pm.request('POST', `/feedback/${id}/escalate`, { note })).status, 409, 'once');
    assert.equal((await pm.request('POST', `/feedback/${proposal}/escalate`, { note: 'Proposal issue.' })).status, 200);
    assert.equal((await pm.request('POST', `/feedback/${missing}/escalate`, { note: 'Run issue.' })).status, 200);
    const r = await admin.request('GET', '/admin/feedback');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const text = JSON.stringify(r.body);
    for (const leak of [CORRECTION, DRAFT_BODY, 'Pump agreed', 'Private chatter', 'invoice', 'Ali will email', 'Weekly check-in']) assert.ok(!text.includes(leak), `leaked ${leak}`);
    for (const row of r.body.feedback) assert.deepEqual(Object.keys(row).sort(), ['at', 'category', 'escalationNote', 'id', 'model', 'projectName', 'runRef']);
    const by = (n: string) => r.body.feedback.find((x: any) => x.escalationNote === n);
    assert.deepEqual([by(note).projectName, by(note).category, by(note).model, by(note).runRef], ['Alpha Project', 'incorrect', 'model-minutes', runId]);
    assert.deepEqual([by('Proposal issue.').model, by('Proposal issue.').runRef], ['model-extract', extractionRunId]);
    assert.deepEqual([by('Run issue.').model, by('Run issue.').runRef !== null], [null, true], 'unknown model is null, not guessed');
    // Both Administrators were told, with a title only; nobody else was.
    const notes = (await t.pool.query(`SELECT user_id, summary, kind, link FROM notifications WHERE kind = 'feedback_escalated' ORDER BY user_id`)).rows;
    assert.equal(notes.length, 6);
    assert.deepEqual([...new Set(notes.map((n) => n.user_id))].sort(), [ids.admin, ids.admin2].sort());
    assert.ok(notes.every((n) => n.summary === 'AI feedback escalated from Alpha Project'));
    assert.ok(notes.every((n) => n.link === '#/escalated-feedback'));
    // An Administrator with no role in the project still sees the notice and its link.
    const shown = (await admin.request('GET', '/notifications')).body.items.filter((i: any) => i.kind === 'feedback_escalated');
    assert.equal(shown.length, 3);
    assert.ok(shown.every((i: any) => !i.noAccess && i.summary === 'AI feedback escalated from Alpha Project' && i.link === '#/escalated-feedback'));
    // No event or audit row holds the reporter's note.
    const kept = JSON.stringify([(await t.pool.query(`SELECT * FROM feedback_events`)).rows, (await t.pool.query(`SELECT detail FROM audit_events WHERE action LIKE 'feedback.%'`)).rows]);
    assert.ok(!kept.includes(CORRECTION) && !kept.includes('Nobody owns'));
    assert.equal((await ada.request('GET', '/admin/feedback')).status, 403);
  });

  test('feedback changes no draft, setting or record', async () => {
    const tables = ['minutes_drafts', 'analysis_runs', 'extraction_items', 'extraction_runs', 'sources', 'source_versions', 'human_proposals', 'analysis_settings_changes', 'ai_spend_entries', 'discussion_messages'];
    const snapshot = async () => Promise.all(tables.map((n) => count(`SELECT count(*) AS n FROM ${n}`)));
    const itemBefore = (await t.pool.query(`SELECT * FROM extraction_items WHERE id = $1`, [itemId])).rows[0];
    const before = await snapshot();
    const id = (await flag(ada)).body.id;
    await flag(ben, { targetKind: 'proposal', targetId: itemId });
    await pm.request('POST', `/feedback/${id}/status`, { status: 'reviewed', note: 'Looked.' });
    await pm.request('POST', `/feedback/${id}/escalate`, { note: 'Escalated.' });
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await t.pool.query(`SELECT * FROM extraction_items WHERE id = $1`, [itemId])).rows[0], itemBefore);
    assert.equal((await t.pool.query(`SELECT body FROM minutes_drafts WHERE id = $1`, [draftId])).rows[0].body, DRAFT_BODY);
  });

  test('feedback can be raised and reviewed in a Deferred project', async () => {
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    const id = (await flag(ada)).body.id;
    assert.ok(id);
    assert.equal((await pm.request('POST', `/feedback/${id}/status`, { status: 'reviewed', note: 'Looked.' })).status, 200);
  });
});
