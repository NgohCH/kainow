import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('moderation, deletion and restoration', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let ada: Client;
  let ben: Client;
  let thread: string;
  let adaMsg: string;

  const count = async (table: string) => Number((await t.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const act = (c: Client, action: string, messageId: string, reason: unknown = 'Off topic') => c.request('POST', `/messages/${messageId}/${action}`, { reason });
  const view = async (c: Client) => (await c.request('GET', `/threads/${thread}`)).body.messages as Array<Record<string, any>>;

  beforeEach(async () => {
    t = await startTestApp();
    for (const k of ['pm', 'ada', 'ben']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
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
    [pm, ada, ben] = [await t.signIn('pm@example.org'), await t.signIn('ada@example.org'), await t.signIn('ben@example.org')];
    thread = (await ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Site access' })).body.id;
    adaMsg = (await ada.request('POST', `/threads/${thread}/messages`, { body: 'We should ship on Friday.' })).body.id;
  });
  afterEach(async () => {
    await t.close();
  });

  test('PM hides with a reason; others see the notice; author sees text and notice', async () => {
    const pmName = (await t.pool.query('SELECT display_name FROM users WHERE id = $1', [ids.pm])).rows[0].display_name;
    const r = await act(pm, 'hide', adaMsg, 'Not for this thread');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'hidden');
    assert.equal(r.body.text, null);
    assert.equal(r.body.notice, `Hidden by ${pmName}: Not for this thread`);
    const [seenByBen] = await view(ben);
    assert.equal(seenByBen.text, null);
    assert.equal(seenByBen.notice, `Hidden by ${pmName}: Not for this thread`);
    const [seenByAda] = await view(ada);
    assert.equal(seenByAda.text, 'We should ship on Friday.');
    assert.equal(seenByAda.notice, `Hidden by ${pmName}: Not for this thread`);
    assert.equal((await t.pool.query(`SELECT author_id FROM discussion_messages WHERE id = $1`, [adaMsg])).rows[0].author_id, ids.ada);
    const unhidden = await act(pm, 'unhide', adaMsg, 'Fine after all');
    assert.equal(unhidden.body.state, 'visible');
    assert.equal(unhidden.body.notice, null);
    assert.equal(unhidden.body.text, 'We should ship on Friday.');
    const events = await t.pool.query(`SELECT action, reason, detail FROM discussion_events WHERE message_id = $1 AND action IN ('hidden','unhidden') `, [adaMsg]);
    assert.deepEqual(events.rows.map((e) => [e.action, e.reason]).sort(), [['hidden', 'Not for this thread'], ['unhidden', 'Fine after all']]);
    assert.ok(events.rows.every((e) => e.detail === null));
  });

  test('Member cannot hide (403)', async () => {
    const r = await act(ben, 'hide', adaMsg);
    assert.equal(r.status, 403);
    assert.equal((await t.pool.query(`SELECT state FROM discussion_messages WHERE id = $1`, [adaMsg])).rows[0].state, 'visible');
    assert.equal((await act(ada, 'hide', adaMsg)).status, 403, 'not even the author hides');
  });

  test('author deletes own message', async () => {
    const r = await act(ada, 'delete', adaMsg, 'Posted by mistake');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'deleted');
    assert.equal(r.body.text, null);
    assert.match(r.body.notice, /^Deleted by .+: Posted by mistake$/);
    assert.equal((await view(ada))[0].text, null, 'the author does not see deleted text either');
    assert.equal((await act(ada, 'delete', adaMsg, 'again')).status, 409);
  });

  test('PM can delete another person message, even a hidden one', async () => {
    await act(pm, 'hide', adaMsg);
    assert.equal((await act(pm, 'delete', adaMsg, 'Removing')).body.state, 'deleted');
  });

  test('Member cannot delete another\'s message', async () => {
    const r = await act(ben, 'delete', adaMsg);
    assert.equal(r.status, 403);
    assert.equal((await t.pool.query(`SELECT state FROM discussion_messages WHERE id = $1`, [adaMsg])).rows[0].state, 'visible');
  });

  test('reason is required', async () => {
    for (const reason of [null, '', '   ', 'x'.repeat(501), 7]) {
      const r = await act(pm, 'hide', adaMsg, reason);
      assert.equal(r.status, 400, String(reason));
      assert.equal(r.body.message, 'A reason is required (up to 500 characters).');
    }
    assert.equal((await act(ada, 'delete', adaMsg, '')).status, 400);
    assert.equal((await act(pm, 'hide', adaMsg, 'x'.repeat(500))).status, 200);
    assert.equal(await count(`discussion_events WHERE action = 'hidden'`), 1);
  });

  test('restore needs the right state, a restorer and a reason; unhide and restore do not mix', async () => {
    assert.equal((await act(pm, 'restore', adaMsg)).status, 409);
    assert.equal((await act(pm, 'unhide', adaMsg)).status, 409);
    await act(ada, 'delete', adaMsg, 'Oops');
    assert.equal((await act(pm, 'unhide', adaMsg)).status, 409);
    assert.equal((await act(ada, 'restore', adaMsg)).status, 403);
    assert.equal((await act(pm, 'restore', adaMsg, '')).status, 400);
    const r = await act(pm, 'restore', adaMsg, 'It was needed');
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'visible');
    assert.equal(r.body.text, 'We should ship on Friday.');
    const row = (await t.pool.query(`SELECT state_reason, state_by, state_at FROM discussion_messages WHERE id = $1`, [adaMsg])).rows[0];
    assert.deepEqual(row, { state_reason: null, state_by: null, state_at: null });
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM discussion_events WHERE message_id = $1 AND action = 'restored' AND reason = 'It was needed'`, [adaMsg])).rows[0].n, 1);
  });

  test('outside the audience a message is not found; unknown id is 404', async () => {
    await seedUser(t.pool, 'out@example.org');
    const out = await t.signIn('out@example.org');
    assert.equal((await act(out, 'hide', adaMsg)).status, 404);
    assert.equal((await act(pm, 'hide', uuidv7())).status, 404);
    assert.equal((await act(pm, 'hide', 'nope')).status, 404);
  });

  test('restore works while Deferred and starts nothing', async () => {
    await act(pm, 'delete', adaMsg, 'Removing');
    const other = (await ada.request('POST', `/threads/${thread}/messages`, { body: 'Second' })).body.id;
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    assert.equal((await act(pm, 'hide', other)).status, 403);
    assert.equal((await act(pm, 'delete', other)).status, 403);
    assert.equal((await act(ada, 'delete', other)).status, 403);
    const tables = ['analysis_runs', 'extraction_runs', 'notifications', 'email_outbox'];
    const snapshot = async () => Promise.all(tables.map(count));
    const before = await snapshot();
    const r = await act(pm, 'restore', adaMsg, 'Reinstated');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'visible');
    assert.deepEqual(await snapshot(), before);
    // Closed projects: restoration is still the one thing allowed.
    await act(pm, 'delete', adaMsg, 'Removing').then((x) => assert.equal(x.status, 403));
    await t.pool.query(`UPDATE discussion_messages SET state = 'deleted', state_reason = 'r', state_by = $2, state_at = now() WHERE id = $1`, [adaMsg, ids.pm]);
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [project]);
    assert.equal((await act(pm, 'restore', adaMsg, 'Reinstated again')).status, 200);
  });

  test('Deleted message is masked in an earlier transcript and its proposal is flagged', async () => {
    const benMsg = (await ben.request('POST', `/threads/${thread}/messages`, { body: 'Budget is approved.' })).body.id;
    const audienceId = (await t.pool.query(`SELECT audience_id FROM discussion_threads WHERE id = $1`, [thread])).rows[0].audience_id;
    const transcript = '#1 Ada\nWe should ship on Friday.\n#2 Ben\nBudget is approved.\n';
    const sourceId = uuidv7();
    const versionId = uuidv7();
    const runId = uuidv7();
    const itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id) VALUES ($1, 'Site access', NULL, now(), $2, 'discussion', $3, $4)`,
      [sourceId, project, audienceId, thread],
    );
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'discussion', $3, 'x', $4, NULL, now())`,
      [versionId, sourceId, transcript, transcript.length],
    );
    const versionOf = async (id: string) =>
      (await t.pool.query(`SELECT v.id, m.author_id FROM message_versions v JOIN discussion_messages m ON m.id = v.message_id WHERE m.id = $1`, [id])).rows[0];
    const [v1, v2] = [await versionOf(adaMsg), await versionOf(benMsg)];
    const bodyStart2 = transcript.indexOf('Budget');
    await t.pool.query(
      `INSERT INTO transcript_spans (source_version_id, message_no, message_version_id, author_id, header_start, body_start, body_end) VALUES
       ($1, 1, $2, $3, 0, 7, 32), ($1, 2, $4, $5, 33, $6, $7)`,
      [versionId, v1.id, v1.author_id, v2.id, v2.author_id, bodyStart2, transcript.length - 1],
    );
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, trigger, status, item_count, unlocated_count, created_at, finished_at)
       VALUES ($1, $2, NULL, 'discussion', 'succeeded', 2, 0, now(), now())`,
      [runId, versionId],
    );
    const quotes: Array<[string, number]> = [['We should ship on Friday.', 7], ['Budget is approved.', bodyStart2]];
    for (const [i, [q, s]] of quotes.entries()) {
      await t.pool.query(
        `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, due, quote, quote_start, quote_end, quote_matches, created_at)
         VALUES ($1, $2, $3, $4, 'action', 'Confirm the figure', 'by 20 November 2026', $5, $6, $7, 1, now())`,
        [i === 1 ? itemId : uuidv7(), runId, versionId, i, q, s, s + q.length],
      );
    }
    const items = async () => (await pm.request('GET', `/extractions/${runId}`)).body.items as Array<Record<string, any>>;
    const text = async () => (await pm.request('GET', `/notes/${sourceId}/versions/1`)).body.version.text as string;
    assert.deepEqual((await items()).map((i) => i.sourceFlag), [null, null]);
    assert.equal(await text(), transcript);

    const auth = await pm.request('POST', `/extractions/${runId}/items/${itemId}/authorise`, { sourceVersionId: versionId, assigneeId: ids.ada, dueOn: '2026-11-20' });
    assert.equal(auth.status, 201, JSON.stringify(auth.body));
    const taskSource = async () => (await pm.request('GET', `/projects/${project}/records`)).body.tasks[0].source;
    assert.equal((await taskSource()).quote, 'Budget is approved.');

    await act(ben, 'delete', benMsg, 'Wrong figure');
    assert.deepEqual((await items()).map((i) => i.sourceFlag), [null, 'deleted']);
    // The quote of a deleted message reaches no one (R30): the text is gone, the marker stays.
    const masked = await items();
    assert.deepEqual([masked[1].quote, masked[1].quoteMasked, masked[0].quote, masked[0].quoteMasked], [null, 'deleted', 'We should ship on Friday.', undefined]);
    assert.ok(!JSON.stringify(masked).includes('Budget is approved.'));
    const ts = await taskSource();
    assert.deepEqual([ts.quote, ts.quoteMasked, ts.sourceFlag], [null, 'deleted', 'deleted']);
    assert.ok(!JSON.stringify(ts).includes('Budget is approved.'));
    assert.equal(await text(), '#1 Ada\nWe should ship on Friday.\n[Message deleted]\n');
    assert.equal((await t.pool.query(`SELECT text_content FROM source_versions WHERE id = $1`, [versionId])).rows[0].text_content, transcript, 'stored text is untouched');

    await act(pm, 'restore', benMsg, 'Figure was right');
    assert.deepEqual((await items()).map((i) => i.sourceFlag), [null, null]);
    await act(pm, 'hide', adaMsg, 'Premature');
    assert.deepEqual((await items()).map((i) => i.sourceFlag), ['hidden', null]);
    assert.deepEqual([(await items())[0].quote, (await items())[0].quoteMasked], [null, 'hidden']);
    assert.equal(await text(), '[Message hidden]\n#2 Ben\nBudget is approved.\n');
  });
});
