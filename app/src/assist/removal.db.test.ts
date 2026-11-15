import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { ProjectAccess } from '../projects/access.service';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { type MaterialItem, findMaterial } from './material';
import { type RemovalReason, type RemovedMaterial, onMaterialRemoved } from './removal';
import { buildTerms } from './terms';

describe('removal hook', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let thread: string;

  const remove = async (what: RemovedMaterial, reason: RemovalReason) => {
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await onMaterialRemoved(client, what, reason, t.clock.now());
      await client.query('COMMIT');
      return out;
    } finally {
      client.release();
    }
  };
  const material = async (question: string): Promise<MaterialItem[]> => {
    const ctx = await t.app.get(ProjectAccess).load(project, { id: ids.ada, email: 'ada@example.org', displayName: 'ada', role: 'member' });
    assert.ok(ctx);
    return findMaterial(t.pool, { kind: 'personal', ctx }, buildTerms(question));
  };
  /** A request with its material, as the services store one; `answer` adds its answer row. */
  const request = async (items: MaterialItem[], opts: { kind?: 'question' | 'report'; status?: string; answer?: 'private' | 'shared'; dropped?: boolean } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at) VALUES ($1, $2, $3, $4, $5, 'personal', now())`,
      [id, project, opts.kind ?? 'question', ids.ada, opts.status ?? 'succeeded'],
    );
    for (const [n, i] of items.entries()) {
      await t.pool.query(
        `INSERT INTO ai_request_material (request_id, ordinal, marker, passage_id, record_kind, record_id, record_audience_id, snapshot, location, dropped_at_start)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, n, `P${n + 1}`, i.passageId, i.recordKind, i.recordId, i.recordAudienceId, i.snapshot, i.location, opts.dropped ?? false],
      );
    }
    if (opts.answer) {
      await t.pool.query(`INSERT INTO ai_answers (request_id, project_id, question, answer_markdown) VALUES ($1, $2, 'When is the pump service?', 'Thursday [P1].')`, [id, project]);
      if (opts.answer === 'shared') {
        await t.pool.query(`UPDATE ai_answers SET visibility = 'shared', shared_thread_id = $2, shared_by = $3, shared_at = now() WHERE request_id = $1`, [id, thread, ids.ada]);
      }
    }
    return id;
  };
  /** A report draft whose AI versions came from the given requests. */
  const draft = async (shared: boolean, requestIds: string[]) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO report_drafts (id, project_id, kind, title, created_by, created_at, shared, shared_at) VALUES ($1, $2, 'status', 'Weekly status', $3, now(), $4, $5)`,
      [id, project, ids.ada, shared, shared ? new Date() : null],
    );
    for (const [n, r] of requestIds.entries()) {
      await t.pool.query(
        `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, request_id, created_at) VALUES ($1, $2, $3, 'ai', 'Draft body [P1].', $4, now())`,
        [uuidv7(), id, n + 1, r],
      );
    }
    await t.pool.query(
      `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, created_by, created_at) VALUES ($1, $2, $3, 'human', 'Edited body.', $4, now())`,
      [uuidv7(), id, requestIds.length + 1, ids.ada],
    );
    return id;
  };
  const answerState = async (id: string) => (await t.pool.query(`SELECT review_state FROM ai_answers WHERE request_id = $1`, [id])).rows[0].review_state;
  const draftState = async (id: string) => (await t.pool.query(`SELECT review_state, review_reason FROM report_drafts WHERE id = $1`, [id])).rows[0];
  const post = async (body: string) => {
    const r = await pm.request('POST', `/threads/${thread}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const note = async (title: string, text: string) => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title, text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.source.id as string;
  };

  beforeEach(async () => {
    t = await startTestApp();
    for (const k of ['pm', 'ada']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    const r = await pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Plant meeting' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    thread = r.body.id;
  });
  afterEach(async () => {
    await t.close();
  });

  test('unshared drafts are withdrawn and shared drafts go to review', async () => {
    const msg = await post('The pump service is booked for Thursday morning.');
    const used = await request(await material('pump service'), { kind: 'report' });
    const other = await request([], { kind: 'report' });
    const privateDraft = await draft(false, [other, used]);
    const sharedDraft = await draft(true, [used]);
    const untouched = await draft(true, [other]);

    assert.deepEqual(await remove({ messageIds: [msg] }, 'hidden'), { withdrawn: 1, review: 1 });
    assert.deepEqual(await draftState(privateDraft), { review_state: 'withdrawn', review_reason: 'material_removed' });
    assert.deepEqual(await draftState(sharedDraft), { review_state: 'review_required', review_reason: 'material_removed' });
    assert.deepEqual(await draftState(untouched), { review_state: 'none', review_reason: null });
    const ev = (await t.pool.query(`SELECT action, actor_id, target_kind, target_id, reason, detail FROM ai_assist_events ORDER BY action`)).rows;
    assert.deepEqual(ev, [
      { action: 'review_required', actor_id: null, target_kind: 'report_draft', target_id: sharedDraft, reason: 'material_removed', detail: { cause: 'hidden' } },
      { action: 'withdrawn', actor_id: null, target_kind: 'report_draft', target_id: privateDraft, reason: 'material_removed', detail: { cause: 'hidden' } },
    ]);
    assert.ok(!JSON.stringify(ev).includes('body'), 'no draft text');
    // A shared draft listed for review, an unshared one never.
    const list = await pm.request('GET', `/projects/${project}/assist-review`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.items.map((i: { kind: string; id: string; title: string; href: string }) => [i.kind, i.id, i.title, i.href]), [
      ['draft', sharedDraft, 'Weekly status', `#/reports/${sharedDraft}`],
    ]);
    // Clear and withdraw take kind 'draft'.
    const cleared = await pm.request('POST', `/assist-review/draft/${sharedDraft}/clear`, { reason: 'Checked' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal((await draftState(sharedDraft)).review_state, 'cleared');
    assert.equal((await pm.request('POST', `/assist-review/draft/${privateDraft}/withdraw`, { reason: 'x' })).status, 404, 'unshared drafts are not reviewed');
  });

  test('passages of earlier versions count, material dropped at start does not', async () => {
    const msg = await post('The pump service is booked for Thursday morning.');
    const items = await material('pump service');
    const oldVersion = await request(items, { answer: 'private' });
    const edited = await pm.request('PUT', `/messages/${msg}`, { body: 'The pump service moved to Friday morning.', basedOnVersion: 1 });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const dropped = await request(items, { answer: 'private', dropped: true });
    const queued = await request(items, { answer: 'private', status: 'queued' });
    assert.deepEqual(await remove({ messageIds: [msg] }, 'deleted'), { withdrawn: 2, review: 0 });
    assert.equal(await answerState(oldVersion), 'withdrawn');
    assert.equal(await answerState(dropped), 'none', 'never sent, so not built on it');
    assert.equal(await answerState(queued), 'withdrawn', 'still waiting: withdrawn at once, never shown');
  });

  test('only none and cleared move; withdrawn and review stay as they are', async () => {
    const src = await note('Plant room', 'The pump service is booked for Thursday morning.');
    const items = await material('pump service');
    const cleared = await request(items, { answer: 'shared' });
    const inReview = await request(items, { answer: 'shared' });
    const gone = await request(items, { answer: 'private' });
    await t.pool.query(`UPDATE ai_answers SET review_state = 'cleared' WHERE request_id = $1`, [cleared]);
    await t.pool.query(`UPDATE ai_answers SET review_state = 'review_required' WHERE request_id = $1`, [inReview]);
    await t.pool.query(`UPDATE ai_answers SET review_state = 'withdrawn' WHERE request_id = $1`, [gone]);
    assert.deepEqual(await remove({ sourceIds: [src] }, 'summary_withdrawn'), { withdrawn: 0, review: 1 });
    assert.equal(await answerState(cleared), 'review_required');
    assert.equal(await answerState(inReview), 'review_required');
    assert.equal(await answerState(gone), 'withdrawn');
    assert.equal(Number((await t.pool.query(`SELECT count(*) AS n FROM ai_assist_events`)).rows[0].n), 1, 'one event, for the cleared answer');
    assert.deepEqual(await remove({}, 'hidden'), { withdrawn: 0, review: 0 });
  });

  test('an audience touches passages of its sources and threads, and proposals sent with it', async () => {
    const meetingAudience = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [thread])).rows[0].audience_id;
    await post('The pump service is booked for Thursday morning.');
    const fromMessage = await request(await material('pump service'), { answer: 'private' });
    await note('Chiller notes', 'The chiller is serviced in December.');
    const fromNote = await request(await material('chiller'), { answer: 'private' });
    const proposal: MaterialItem = {
      ...(await material('chiller'))[0],
      passageId: null,
      recordKind: 'human_proposal',
      recordId: uuidv7(),
      recordAudienceId: meetingAudience,
      snapshot: 'Proposed — not authorised: risk: the pump may slip',
    };
    const fromProposal = await request([proposal], { answer: 'private' });
    assert.deepEqual(await remove({ audienceId: meetingAudience }, 'audience_tightened'), { withdrawn: 2, review: 0 });
    assert.equal(await answerState(fromMessage), 'withdrawn');
    assert.equal(await answerState(fromProposal), 'withdrawn');
    assert.equal(await answerState(fromNote), 'none', 'the note has its own audience');
  });
});
