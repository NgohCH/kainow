import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const KEY = `sk-${'a1B2c3D4e5'.repeat(3)}`;

describe('threads and messages', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let ada: Client;
  let ben: Client;
  let admin: Client;
  let auditor: Client;

  const count = async (table: string) => Number((await t.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const start = async (c: Client, body: Record<string, unknown> = { kind: 'discussion', title: 'Site access' }, projectId = project) => {
    const r = await c.request('POST', `/projects/${projectId}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const post = (c: Client, threadId: string, body: unknown, replyToId?: string) => c.request('POST', `/threads/${threadId}/messages`, { body, replyToId });

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'ada', 'ben', 'auditor']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
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
    [pm, ada, ben, admin, auditor] = [await t.signIn('pm@example.org'), await t.signIn('ada@example.org'), await t.signIn('ben@example.org'), await t.signIn('admin@example.org'), await t.signIn('auditor@example.org')];
  });
  afterEach(async () => {
    await t.close();
  });

  test('participant starts a thread and posts', async () => {
    const thread = await start(ada);
    assert.equal(thread.kind, 'discussion');
    assert.equal(thread.title, 'Site access');
    assert.deepEqual(thread.audience, { mode: 'project', namedUsers: [], changedAt: null });
    assert.equal(thread.meetingDate, null);
    assert.equal(thread.state, null);
    assert.equal(thread.canPost, true);
    assert.equal(thread.canModerate, false);
    const r = await post(ben, thread.id, 'Gate code changes on Monday.');
    assert.equal(r.status, 201);
    assert.equal(r.body.no, 1);
    assert.equal(r.body.text, 'Gate code changes on Monday.');
    assert.equal(r.body.author.displayName, 'ben');
    assert.equal(r.body.edited, false);
    const got = await pm.request('GET', `/threads/${thread.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.canModerate, true);
    assert.equal(got.body.messages.length, 1);
  });

  test('a meeting defaults to today and a Project-wide audience', async () => {
    const m = await start(ada, { kind: 'meeting', title: 'Weekly check-in' });
    assert.equal(m.kind, 'meeting');
    assert.equal(m.state, 'open');
    assert.equal(m.meetingDate, '2026-11-09');
    assert.equal(m.audience.mode, 'project');
    const dated = await start(ada, { kind: 'meeting', title: 'Kick-off', meetingDate: '2026-11-03' });
    assert.equal(dated.meetingDate, '2026-11-03');
    const bad = await ada.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'x', meetingDate: '2026-02-31' });
    assert.equal(bad.status, 400);
    const noKind = await ada.request('POST', `/projects/${project}/threads`, { kind: 'poll', title: 'x' });
    assert.equal(noKind.status, 400);
    const noTitle = await ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: '   ' });
    assert.equal(noTitle.status, 400);
    const audienceOnThread = await ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'x', audience: { mode: 'restricted' } });
    assert.equal(audienceOnThread.status, 400);
  });

  test('numbers are 1, 2, 3 in order', async () => {
    const thread = await start(ada);
    const nos: number[] = [];
    for (const who of [ada, ben, ada]) nos.push((await post(who, thread.id, 'ok')).body.no);
    assert.deepEqual(nos, [1, 2, 3]);
    const second = await start(ada, { kind: 'discussion', title: 'Other' });
    assert.equal((await post(ada, second.id, 'first here')).body.no, 1);
  });

  test('simultaneous posts get distinct consecutive numbers', async () => {
    const thread = await start(ada);
    const replies = await Promise.all([1, 2, 3, 4, 5].map((i) => post(i % 2 ? ada : ben, thread.id, `message ${i}`)));
    assert.deepEqual(replies.map((r) => r.status), [201, 201, 201, 201, 201]);
    assert.deepEqual(replies.map((r) => r.body.no).sort(), [1, 2, 3, 4, 5]);
  });

  test('reply links to an earlier message in the same thread only', async () => {
    const a = await start(ada);
    const b = await start(ada, { kind: 'discussion', title: 'Another' });
    const first = (await post(ada, a.id, 'We should move the delivery to Thursday so the crane crew can be on site early.')).body;
    const reply = await post(ben, a.id, 'Agreed.', first.id);
    assert.equal(reply.status, 201);
    assert.deepEqual(reply.body.replyTo, { id: first.id, no: 1, quote: first.text, notice: null });
    const cross = await post(ben, b.id, 'Agreed.', first.id);
    assert.equal(cross.status, 400);
    assert.equal((await post(ben, a.id, 'Agreed.', 'not-an-id')).status, 400);
    // A reply to a message since hidden shows a notice, not its text.
    await t.pool.query(`UPDATE discussion_messages SET state = 'hidden', state_reason = 'off topic', state_by = $2, state_at = now() WHERE id = $1`, [first.id, ids.pm]);
    const got = (await ada.request('GET', `/threads/${a.id}`)).body;
    assert.deepEqual(got.messages[1].replyTo, { id: first.id, no: 1, quote: null, notice: 'Reply to a hidden message' });
  });

  test('a hidden message shows its notice to others and its text only to the author', async () => {
    const thread = await start(ada);
    const msg = (await post(ada, thread.id, 'Private worry.')).body;
    await t.pool.query(`UPDATE discussion_messages SET state = 'hidden', state_reason = 'off topic', state_by = $2, state_at = now() WHERE id = $1`, [msg.id, ids.pm]);
    const seenByBen = (await ben.request('GET', `/threads/${thread.id}`)).body.messages[0];
    assert.deepEqual([seenByBen.text, seenByBen.notice], [null, 'Hidden by pm: off topic']);
    const seenByAda = (await ada.request('GET', `/threads/${thread.id}`)).body.messages[0];
    assert.deepEqual([seenByAda.text, seenByAda.notice], ['Private worry.', 'Hidden by pm: off topic']);
    assert.deepEqual((await ben.request('GET', `/messages/${msg.id}/versions`)).body.versions, []);
    assert.equal((await ada.request('GET', `/messages/${msg.id}/versions`)).body.versions.length, 1);
    assert.equal((await ben.request('PUT', `/messages/${msg.id}`, { body: 'x', basedOnVersion: 1 })).status, 403);
    assert.equal((await ada.request('PUT', `/messages/${msg.id}`, { body: 'x', basedOnVersion: 1 })).status, 409);
  });

  test('edit adds a version and shows edited', async () => {
    const thread = await start(ada);
    const msg = (await post(ada, thread.id, 'First wording.')).body;
    const r = await ada.request('PUT', `/messages/${msg.id}`, { body: 'Better wording.', basedOnVersion: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 2);
    assert.equal(r.body.edited, true);
    assert.equal(r.body.text, 'Better wording.');
    const versions = (await ben.request('GET', `/messages/${msg.id}/versions`)).body.versions;
    assert.deepEqual(versions.map((v: { versionNo: number; text: string }) => [v.versionNo, v.text]), [[1, 'First wording.'], [2, 'Better wording.']]);
    assert.equal((await ada.request('PUT', `/messages/${msg.id}`, { body: 'Better wording.', basedOnVersion: 2 })).status, 400);
    assert.equal((await ada.request('PUT', `/messages/${msg.id}`, { body: 'Again', basedOnVersion: 'two' })).status, 400);
  });

  test('edit by someone else is refused (403)', async () => {
    const thread = await start(ada);
    const msg = (await post(ada, thread.id, 'Mine.')).body;
    const r = await ben.request('PUT', `/messages/${msg.id}`, { body: 'Not mine.', basedOnVersion: 1 });
    assert.equal(r.status, 403);
    assert.equal((await pm.request('PUT', `/messages/${msg.id}`, { body: 'Not mine.', basedOnVersion: 1 })).status, 403);
    assert.equal((await t.pool.query(`SELECT count(*) AS n FROM message_versions WHERE message_id = $1`, [msg.id])).rows[0].n, '1');
  });

  test('edit based on an old version is refused (409)', async () => {
    const thread = await start(ada);
    const msg = (await post(ada, thread.id, 'v1 text')).body;
    assert.equal((await ada.request('PUT', `/messages/${msg.id}`, { body: 'v2 text', basedOnVersion: 1 })).status, 200);
    const stale = await ada.request('PUT', `/messages/${msg.id}`, { body: 'overwrite attempt', basedOnVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.message, 'Someone changed this since you opened it');
    assert.equal(stale.body.current.version, 2);
    assert.equal(stale.body.current.text, 'v2 text');
    const latest = await t.pool.query(`SELECT version_no, body FROM message_versions WHERE message_id = $1 ORDER BY version_no`, [msg.id]);
    assert.deepEqual(latest.rows.map((r) => r.body), ['v1 text', 'v2 text']);
  });

  test('secret is refused and nothing is stored', async () => {
    const thread = await start(ada);
    const before = [await count('discussion_messages'), await count('message_versions'), await count('discussion_events')];
    const r = await post(ada, thread.id, `use ${KEY} to log in`);
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Not posted: this looks like it contains API secret key (sk-). Remove it and post again.');
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.deepEqual([await count('discussion_messages'), await count('message_versions'), await count('discussion_events')], before);
    const msg = (await post(ada, thread.id, 'clean')).body;
    const edit = await ada.request('PUT', `/messages/${msg.id}`, { body: `now ${KEY}`, basedOnVersion: 1 });
    assert.equal(edit.status, 400);
    assert.equal((await t.pool.query(`SELECT count(*) AS n FROM message_versions WHERE message_id = $1`, [msg.id])).rows[0].n, '1');
    const title = await ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: KEY });
    assert.equal(title.status, 400);
  });

  test('a reply and an edit of the message it answers can run at the same time', async () => {
    const thread = await start(ada);
    for (let i = 0; i < 4; i++) {
      const msg = (await post(ada, thread.id, `target ${i}`)).body;
      const [reply, edit, again] = await Promise.all([
        post(ben, thread.id, 'a reply', msg.id),
        ada.request('PUT', `/messages/${msg.id}`, { body: `target ${i} edited`, basedOnVersion: 1 }),
        post(pm, thread.id, 'another reply', msg.id),
      ]);
      assert.deepEqual([reply.status, edit.status, again.status], [201, 200, 201], JSON.stringify([reply.body, edit.body, again.body]));
    }
  });

  test('empty and over-long messages are refused', async () => {
    const thread = await start(ada);
    assert.equal((await post(ada, thread.id, '   ')).status, 400);
    assert.equal((await post(ada, thread.id, 'a'.repeat(10_001))).status, 400);
    assert.equal((await post(ada, thread.id, 'a'.repeat(10_000))).status, 201);
  });

  test('history records length and hash, never text', async () => {
    const thread = await start(ada);
    t.clock.advanceSeconds(1);
    const msg = (await post(ada, thread.id, 'Budget is 4,200.')).body;
    t.clock.advanceSeconds(1);
    await ada.request('PUT', `/messages/${msg.id}`, { body: 'Budget is 4,500.', basedOnVersion: 1 });
    const { rows } = await t.pool.query(`SELECT action, detail FROM discussion_events WHERE thread_id = $1 ORDER BY at, id`, [thread.id]);
    assert.deepEqual(rows.map((r) => r.action), ['thread_started', 'posted', 'edited']);
    for (const r of rows) {
      assert.ok(typeof r.detail.length === 'number' && /^[0-9a-f]{64}$/.test(r.detail.sha256));
      assert.ok(!JSON.stringify(r.detail).includes('Budget'));
    }
    const last = (await t.pool.query(`SELECT last_message_at FROM discussion_threads WHERE id = $1`, [thread.id])).rows[0].last_message_at;
    assert.ok(last);
  });

  test('posting in a Deferred project is refused', async () => {
    const thread = await start(ada);
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    const r = await post(ada, thread.id, 'Still here?');
    assert.equal(r.status, 403);
    assert.match(r.body.message, /Deferred or Closed/);
    assert.equal((await ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'New' })).status, 403);
    assert.equal((await ada.request('GET', `/threads/${thread.id}`)).body.canPost, false);
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [project]);
    assert.equal((await post(ada, thread.id, 'Closed now')).status, 403);
    assert.equal((await ada.request('GET', `/threads/${thread.id}`)).status, 200);
  });

  test('a message cannot be edited in a Deferred project', async () => {
    const thread = await start(ada);
    const msg = (await post(ada, thread.id, 'Before.')).body;
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    assert.equal((await ada.request('PUT', `/messages/${msg.id}`, { body: 'After.', basedOnVersion: 1 })).status, 403);
  });

  test('nothing more is accepted in an ended meeting', async () => {
    const m = await start(ada, { kind: 'meeting', title: 'Done' });
    const msg = (await post(ada, m.id, 'Before the end.')).body;
    await t.pool.query(`UPDATE discussion_threads SET state = 'ended', ended_by = $2, ended_at = now() WHERE id = $1`, [m.id, ids.ada]);
    const r = await post(ada, m.id, 'Too late');
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'This meeting has ended.');
    assert.equal((await ada.request('PUT', `/messages/${msg.id}`, { body: 'Changed', basedOnVersion: 1 })).status, 409);
    const view = (await ada.request('GET', `/threads/${m.id}`)).body;
    assert.equal(view.canPost, false);
    assert.equal(view.state, 'ended');
  });

  test('Audit grant holder reads but cannot post', async () => {
    const thread = await start(ada);
    await post(ada, thread.id, 'For the record.');
    const read = await auditor.request('GET', `/threads/${thread.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.canPost, false);
    assert.equal(read.body.messages.length, 1);
    assert.equal((await auditor.request('GET', `/projects/${project}/discussion`)).status, 200);
    const refused = await post(auditor, thread.id, 'Hello');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, 'Audit and Oversight access is read-only.');
    assert.equal((await auditor.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'x' })).status, 403);
  });

  test('Administrator with no role gets 404', async () => {
    const thread = await start(ada);
    const msg = (await post(ada, thread.id, 'Internal.')).body;
    assert.equal((await admin.request('GET', `/threads/${thread.id}`)).status, 404);
    assert.equal((await admin.request('GET', `/projects/${project}/discussion`)).status, 404);
    assert.equal((await post(admin, thread.id, 'Hi')).status, 404);
    assert.equal((await admin.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'x' })).status, 404);
    assert.equal((await admin.request('GET', `/messages/${msg.id}/versions`)).status, 404);
    assert.equal((await admin.request('GET', `/threads/not-a-uuid`)).status, 404);
  });

  test('Member cannot start a Restricted meeting (403)', async () => {
    const r = await ada.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [] } });
    assert.equal(r.status, 403);
    assert.equal(await count('discussion_threads'), 0);
    assert.equal((await t.pool.query(`SELECT count(*) AS n FROM audiences WHERE mode = 'restricted'`)).rows[0].n, '0');
  });

  test('a Restricted meeting is hidden from people outside its audience', async () => {
    const m = await pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.equal(m.body.audience.mode, 'restricted');
    assert.deepEqual(m.body.audience.namedUsers.map((p: { displayName: string }) => p.displayName), ['ada']);
    assert.equal((await post(ada, m.body.id, 'Named member speaks')).status, 201);
    assert.equal((await ben.request('GET', `/threads/${m.body.id}`)).status, 404);
    assert.equal((await post(ben, m.body.id, 'Let me in')).status, 404);
    assert.equal((await auditor.request('GET', `/threads/${m.body.id}`)).status, 404);
    const listed = async (c: Client) => (await c.request('GET', `/projects/${project}/discussion`)).body.items.map((i: { title: string }) => i.title);
    assert.deepEqual(await listed(ben), []);
    assert.deepEqual(await listed(ada), ['Closed door']);
    assert.deepEqual(await listed(pm), ['Closed door']);
    const outsider = await pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title: 'x', audience: { mode: 'restricted', namedUserIds: [ids.admin] } });
    assert.equal(outsider.status, 400);
  });

  test('afterNo returns only newer messages', async () => {
    const thread = await start(ada);
    for (const text of ['one', 'two', 'three']) await post(ada, thread.id, text);
    const newer = await ben.request('GET', `/threads/${thread.id}?afterNo=1`);
    assert.deepEqual(newer.body.messages.map((m: { no: number }) => m.no), [2, 3]);
    assert.deepEqual((await ben.request('GET', `/threads/${thread.id}?afterNo=3`)).body.messages, []);
    assert.equal((await ben.request('GET', `/threads/${thread.id}?afterNo=abc`)).status, 400);
  });

  test('the discussion list shows threads, meetings and published notes, newest activity first', async () => {
    const older = await start(ada, { kind: 'discussion', title: 'Older thread' });
    t.clock.advanceSeconds(60);
    const meeting = await start(ada, { kind: 'meeting', title: 'Standup' });
    t.clock.advanceSeconds(60);
    assert.equal((await pm.request('POST', `/projects/${project}/notes`, { title: 'Site visit notes', text: 'Walked the site.' })).status, 201);
    t.clock.advanceSeconds(60);
    await post(ben, older.id, 'Bump');
    const items = (await ada.request('GET', `/projects/${project}/discussion`)).body.items;
    assert.deepEqual(items.map((i: { kind: string; title: string }) => [i.kind, i.title]), [['discussion', 'Older thread'], ['notes', 'Site visit notes'], ['meeting', 'Standup']]);
    assert.equal(items[0].messageCount, 1);
    assert.equal(items[1].messageCount, null);
    assert.equal(items[2].id, meeting.id);
    assert.equal(items[2].state, 'open');
    // A submitted (unpublished) note is listed as a submission for its submitter only; others do not see it at all.
    await t.pool.query(`UPDATE sources SET publication = 'submitted', submitted_by = $1 WHERE title = 'Site visit notes'`, [ids.ada]);
    assert.equal((await ben.request('GET', `/projects/${project}/discussion`)).body.items.length, 2);
    assert.deepEqual((await ada.request('GET', `/projects/${project}/discussion`)).body.items.filter((i: { kind: string }) => i.kind === 'submission').length, 1);
  });
});
