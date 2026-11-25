import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { POSSIBLE_COPY_TEXT } from '../quarantine/labels';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

type Run = { runId: string; sourceId: string; sourceTitle: string; sourceKind: string; threadId: string | null; versionNo: number; finishedAt: string; waiting: number; total: number };

/** `GET /projects/:projectId/proposal-runs`: the Proposals tab's list of extraction runs (spec 6.3). */
describe('project proposal runs', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let projectId: string;
  const ids: Record<string, string> = {};
  const people: Record<string, Client> = {};

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'mem', 'outsider', 'stranger']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.mem, role: 'member' },
        { userId: ids.outsider, role: 'member' },
      ],
    });
    for (const p of ['pm', 'mem', 'outsider', 'stranger']) people[p] = await t.signIn(`${p}@example.org`);
    people.admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  async function note(title: string): Promise<{ sourceId: string; versionId: string; audienceId: string }> {
    const r = await people.pm.request('POST', `/projects/${projectId}/notes`, { title, text: `Notes for ${title}.` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sourceId = r.body.source.id as string;
    const audienceId = (await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [sourceId])).rows[0].audience_id as string;
    return { sourceId, versionId: r.body.version.id as string, audienceId };
  }
  /** A discussion is Project-wide today (only a meeting may be Restricted); the filter must hold if that ever changes. */
  async function restrict(audienceId: string, named: string[]): Promise<void> {
    await t.pool.query(`UPDATE audiences SET mode = 'restricted' WHERE id = $1`, [audienceId]);
    for (const userId of named) await t.pool.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, now())`, [audienceId, userId, ids.pm]);
  }
  /** A discussion with one message and the transcript an analysis of it stored, as analysis-runner.ts writes it. */
  async function discussion(title: string, only?: string[]): Promise<{ threadId: string; sourceId: string; versionId: string; audienceId: string }> {
    const made = await people.pm.request('POST', `/projects/${projectId}/threads`, { kind: 'discussion', title });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const threadId = (made.body.thread?.id ?? made.body.id) as string;
    assert.equal((await people.pm.request('POST', `/threads/${threadId}/messages`, { body: 'Notes about the pay review.' })).status, 201);
    const audienceId = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [threadId])).rows[0].audience_id as string;
    if (only) await restrict(audienceId, only);
    const sourceId = uuidv7();
    const versionId = uuidv7();
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id) VALUES ($1, $2, $3, now(), $4, 'discussion', $5, $6)`,
      [sourceId, `Discussion: ${title}`, ids.pm, projectId, audienceId, threadId],
    );
    const text = 'Notes about the pay review.';
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at) VALUES ($1, $2, 1, 'discussion', $3, 'h', $4, $5, now())`,
      [versionId, sourceId, text, text.length, ids.pm],
    );
    return { threadId, sourceId, versionId, audienceId };
  }
  const waiting = async (who: string): Promise<number> => {
    const r = await people[who].request('GET', `/projects/${projectId}/dashboard`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.proposals.waiting as number;
  };
  async function run(versionId: string, o: { finishedAt: string; items: Array<'pending' | 'approved' | 'rejected'>; status?: string }): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, failure_code, item_count, unlocated_count, created_at, finished_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'failed' THEN 'provider_error' END, $5, 0, $6, $6)`,
      [id, versionId, ids.pm, o.status ?? 'succeeded', o.items.length, o.finishedAt],
    );
    for (const [i, s] of o.items.entries()) {
      await t.pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, review_status, reviewed_by, reviewed_at, created_at)
         VALUES ($1, $2, $3, $4, 'decision', 'Proposed', 'Notes', 0, 5, 1, $5, $6, $7, now())`,
        [uuidv7(), id, versionId, i, s, s === 'pending' ? null : ids.pm, s === 'pending' ? null : new Date()],
      );
    }
    return id;
  }
  const list = async (who: string): Promise<Run[]> => {
    const r = await people[who].request('GET', `/projects/${projectId}/proposal-runs`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.runs as Run[];
  };

  test('succeeded runs with items, newest first, with waiting and total', async () => {
    const a = await note('Kick-off');
    const b = await note('Site visit');
    const older = await run(a.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending', 'approved', 'rejected'] });
    const newer = await run(b.versionId, { finishedAt: '2026-11-05T02:00:00Z', items: ['approved'] });
    await run(b.versionId, { finishedAt: '2026-11-06T02:00:00Z', items: [] });
    await run(a.versionId, { finishedAt: '2026-11-07T02:00:00Z', items: [], status: 'failed' });
    assert.deepEqual(await list('mem'), [
      { runId: newer, sourceId: b.sourceId, sourceTitle: 'Site visit', sourceKind: 'notes', threadId: null, versionNo: 1, finishedAt: '2026-11-05T02:00:00.000Z', waiting: 0, total: 1 },
      { runId: older, sourceId: a.sourceId, sourceTitle: 'Kick-off', sourceKind: 'notes', threadId: null, versionNo: 1, finishedAt: '2026-11-03T02:00:00.000Z', waiting: 1, total: 3 },
    ]);
  });

  test("a Restricted note's runs are listed for its audience only", async () => {
    const open = await note('Weekly');
    const closed = await note('Personnel');
    await run(open.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending'] });
    const hidden = await run(closed.versionId, { finishedAt: '2026-11-04T02:00:00Z', items: ['pending'] });
    const narrowed = await people.pm.request('PUT', `/audiences/${closed.audienceId}`, { mode: 'restricted', namedUserIds: [ids.mem], reason: 'Personnel matters' });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    assert.deepEqual((await list('pm')).map((r) => r.sourceTitle), ['Personnel', 'Weekly'], 'the PM is always in the audience');
    assert.deepEqual((await list('mem')).map((r) => r.sourceTitle), ['Personnel', 'Weekly'], 'a named member');
    const outside = await list('outsider');
    assert.deepEqual(outside.map((r) => r.sourceTitle), ['Weekly']);
    assert.ok(!JSON.stringify(outside).includes(hidden) && !JSON.stringify(outside).includes(closed.sourceId));
    assert.deepEqual(outside.map((r) => [r.sourceKind, r.threadId]), [['notes', null]]);
  });

  test("a discussion's runs are listed, counted and can be opened", async () => {
    const d = await discussion('Site plan');
    const runId = await run(d.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending', 'pending', 'approved'] });
    assert.deepEqual(await list('mem'), [
      { runId, sourceId: d.sourceId, sourceTitle: 'Discussion: Site plan', sourceKind: 'discussion', threadId: d.threadId, versionNo: 1, finishedAt: '2026-11-03T02:00:00.000Z', waiting: 2, total: 3 },
    ]);
    assert.equal(await waiting('mem'), 2);
    const page = await people.mem.request('GET', `/extractions/${runId}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual([page.body.source.sourceKind, page.body.source.title, page.body.items.length], ['discussion', 'Discussion: Site plan', 3]);
  });

  test("a Restricted discussion's runs are neither listed, counted nor opened outside its audience", async () => {
    const open = await discussion('Weekly');
    const closed = await discussion('Pay review', [ids.mem]);
    const openRun = await run(open.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending'] });
    const closedRun = await run(closed.versionId, { finishedAt: '2026-11-04T02:00:00Z', items: ['pending', 'pending'] });
    for (const who of ['pm', 'mem']) {
      assert.deepEqual((await list(who)).map((r) => r.runId), [closedRun, openRun], who);
      assert.equal(await waiting(who), 3, who);
      assert.equal((await people[who].request('GET', `/extractions/${closedRun}`)).status, 200, who);
    }
    const outside = await list('outsider');
    assert.deepEqual(outside.map((r) => r.runId), [openRun]);
    const raw = JSON.stringify(outside);
    for (const leak of [closedRun, closed.sourceId, closed.threadId, 'Pay review']) assert.ok(!raw.includes(leak), leak);
    assert.equal(await waiting('outsider'), 1, 'the count leaves the restricted proposals out');
    assert.equal((await people.outsider.request('GET', `/extractions/${closedRun}`)).status, 404);
    // The notes list still holds notes only.
    const notes = await people.pm.request('GET', `/projects/${projectId}/notes`);
    assert.ok(!JSON.stringify(notes.body).includes(open.sourceId));
    // Narrowing a thread's audience takes its run away at once.
    await restrict(open.audienceId, [ids.mem]);
    assert.deepEqual(await list('outsider'), []);
    assert.equal(await waiting('outsider'), 0);
  });

  test('runs of a held or Deleted discussion are left out', async () => {
    const d = await discussion('Keys');
    await run(d.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending'] });
    const caseId = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at) VALUES ($1, $2, 'thread', $3, 'test', 8, 'held', true, now())`,
      [caseId, projectId, d.threadId],
    );
    await t.pool.query(`UPDATE discussion_threads SET held_case_id = $2 WHERE id = $1`, [d.threadId, caseId]);
    assert.deepEqual(await list('mem'), [], 'a held thread');
    assert.equal(await waiting('mem'), 0);
    await t.pool.query(`UPDATE discussion_threads SET held_case_id = NULL WHERE id = $1`, [d.threadId]);
    assert.equal(await waiting('mem'), 1);
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [d.sourceId]);
    assert.deepEqual(await list('mem'), [], 'a Deleted source');
  });

  test('a possible-copy note shows its label as title; a Deleted note is left out', async () => {
    const masked = await note('Login details');
    const gone = await note('Old notes');
    await run(masked.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending'] });
    await run(gone.versionId, { finishedAt: '2026-11-04T02:00:00Z', items: ['pending'] });
    const caseId = uuidv7();
    const other = await note('Reported');
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at) VALUES ($1, $2, 'source', $3, 'test', 8, 'held', true, now())`,
      [caseId, projectId, other.sourceId],
    );
    await t.pool.query(`INSERT INTO quarantine_possible_copies (case_id, item_kind, item_id, found_at, masked) VALUES ($1, 'source', $2, now(), true)`, [caseId, masked.sourceId]);
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [gone.sourceId]);
    const runs = await list('mem');
    assert.deepEqual(runs.map((r) => [r.sourceId, r.sourceTitle]), [[masked.sourceId, POSSIBLE_COPY_TEXT]]);
  });

  test("minutes give the note's address, never their meeting's thread; every address listed opens", async () => {
    const d = await discussion('Site plan');
    await run(d.versionId, { finishedAt: '2026-11-02T02:00:00Z', items: ['pending'] });
    const meeting = await people.pm.request('POST', `/projects/${projectId}/threads`, { kind: 'discussion', title: 'Weekly meeting' });
    const meetingId = (meeting.body.thread?.id ?? meeting.body.id) as string;
    const m = await note('Weekly meeting');
    await t.pool.query(`UPDATE sources SET kind = 'minutes', thread_id = $2 WHERE id = $1`, [m.sourceId, meetingId]);
    await run(m.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending'] });
    const listed = await list('mem');
    assert.deepEqual(listed.map((r) => [r.sourceKind, r.sourceId, r.threadId]), [['minutes', m.sourceId, null], ['discussion', d.sourceId, d.threadId]]);
    assert.equal((await people.mem.request('GET', `/notes/${m.sourceId}/versions/1`)).status, 200);
    assert.equal((await people.mem.request('GET', `/threads/${d.threadId}`)).status, 200);
  });

  test("a run's page gives its source's address, and says when the source cannot be opened", async () => {
    const d = await discussion('Keys');
    const n = await note('Site visit');
    const dRun = await run(d.versionId, { finishedAt: '2026-11-03T02:00:00Z', items: ['pending'] });
    const nRun = await run(n.versionId, { finishedAt: '2026-11-04T02:00:00Z', items: ['pending'] });
    const source = async (id: string) => (await people.mem.request('GET', `/extractions/${id}`)).body.source;
    assert.deepEqual(await source(nRun), { sourceId: n.sourceId, title: 'Site visit', sourceKind: 'notes', threadId: null, versionNo: 1, opens: true });
    assert.deepEqual(await source(dRun), { sourceId: d.sourceId, title: 'Discussion: Keys', sourceKind: 'discussion', threadId: d.threadId, versionNo: 1, opens: true });
    const caseId = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at) VALUES ($1, $2, 'thread', $3, 'test', 8, 'held', true, now())`,
      [caseId, projectId, d.threadId],
    );
    await t.pool.query(`UPDATE discussion_threads SET held_case_id = $2 WHERE id = $1`, [d.threadId, caseId]);
    assert.equal((await source(dRun)).opens, false, 'a held discussion');
    await t.pool.query(`UPDATE sources SET held_case_id = $2 WHERE id = $1`, [n.sourceId, caseId]);
    assert.equal((await source(nRun)).opens, false, 'a held note');
    assert.equal((await people.mem.request('GET', `/notes/${n.sourceId}`)).status, 404, 'as the note itself answers');
    await t.pool.query(`UPDATE sources SET held_case_id = NULL, status = 'deleted' WHERE id = $1`, [n.sourceId]);
    assert.equal((await source(nRun)).opens, false, 'a Deleted note');
    assert.equal((await people.mem.request('GET', `/notes/${n.sourceId}`)).status, 404);
  });

  test("a proposal's record opens while it is live, whatever its kind; a Deleted or held one does not", async () => {
    const n = await note('Site visit');
    const runId = await run(n.versionId, { finishedAt: '2026-11-04T02:00:00Z', items: ['approved', 'approved', 'approved', 'approved', 'pending'] });
    const items = (await t.pool.query(`SELECT id FROM extraction_items WHERE run_id = $1 ORDER BY position`, [runId])).rows.map((r) => r.id as string);
    const made = { task: uuidv7(), decision: uuidv7(), question: uuidv7(), risk: uuidv7() };
    const common = `project_id, origin_item_id, authorised_by, authorised_at`;
    await t.pool.query(`INSERT INTO tasks (id, title, assignee_id, due_on, depth, status, ${common}) VALUES ($1, 'T', $4, '2026-11-30', 0, 'not_started', $2, $3, $4, now())`, [made.task, projectId, items[0], ids.pm]);
    await t.pool.query(`INSERT INTO decisions (id, statement, ${common}) VALUES ($1, 'D', $2, $3, $4, now())`, [made.decision, projectId, items[1], ids.pm]);
    await t.pool.query(`INSERT INTO questions (id, text, requester_id, ${common}) VALUES ($1, 'Q', $4, $2, $3, $4, now())`, [made.question, projectId, items[2], ids.pm]);
    await t.pool.query(`INSERT INTO risks (id, description, severity, ${common}) VALUES ($1, 'R', 'high', $2, $3, $4, now())`, [made.risk, projectId, items[3], ids.pm]);
    const read = async () => ((await people.mem.request('GET', `/extractions/${runId}`)).body.items as Array<{ record: unknown; recordOpens: boolean }>).map((i) => [i.record, i.recordOpens]);
    const rec = (kind: keyof typeof made) => ({ kind, id: made[kind] });
    assert.deepEqual(await read(), [[rec('task'), true], [rec('decision'), true], [rec('question'), true], [rec('risk'), true], [null, false]]);
    await t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Duplicate' WHERE id = $1`, [made.task, ids.pm]);
    const caseId = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at) VALUES ($1, $2, 'decision', $3, 'test', 8, 'held', true, now())`,
      [caseId, projectId, made.decision],
    );
    await t.pool.query(`UPDATE decisions SET held_case_id = $2 WHERE id = $1`, [made.decision, caseId]);
    assert.deepEqual((await read()).map((r) => r[1]), [false, false, true, true, false]);
  });

  test('404 for anyone who may not read the notes list', async () => {
    for (const who of ['stranger', 'admin']) {
      const r = await people[who].request('GET', `/projects/${projectId}/proposal-runs`);
      assert.equal(r.status, 404, who);
      assert.equal((await people[who].request('GET', `/projects/${projectId}/notes`)).status, 404, `${who}: the same answer as the notes list`);
    }
    await t.pool.query(`UPDATE memberships SET held_at = now(), held_by = $2, hold_reason = 'Checking' WHERE project_id = $1 AND user_id = $3`, [projectId, ids.pm, ids.mem]);
    assert.equal((await people.mem.request('GET', `/projects/${projectId}/proposal-runs`)).status, 404, 'an On Hold member');
  });
});
