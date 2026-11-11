import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { insertAiDraft } from './meetings.service';

const KEY = `sk-${'a1B2c3D4e5'.repeat(3)}`;
const AI_LABEL = 'AI draft — not official minutes';

describe('typed meetings and draft minutes', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let ended: string[];
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let ada: Client;
  let ben: Client;
  let cleo: Client;
  let meeting: string;

  const startMeeting = async (c: Client, body: Record<string, unknown> = { kind: 'meeting', title: 'Weekly check-in' }) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const count = async (table: string) => Number((await t.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const save = (c: Client, body: unknown, basedOnVersion: unknown, id = meeting) => c.request('POST', `/threads/${id}/minutes`, { body, basedOnVersion });
  const seedRun = async (trigger = 'button', threadId = meeting) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO analysis_runs (id, thread_id, kind, trigger, requested_by, status, created_at) VALUES ($1, $2, 'minutes', $3, $4, 'succeeded', now())`,
      [id, threadId, trigger, ids.ada],
    );
    return id;
  };

  beforeEach(async () => {
    ended = [];
    t = await startTestApp(undefined, { meetingEndHook: { onMeetingEnded: async (id) => void ended.push(id) } });
    for (const k of ['pm', 'ada', 'ben', 'cleo', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
        { userId: ids.cleo, role: 'member' },
      ],
    });
    [pm, ada, ben, cleo] = [await t.signIn('pm@example.org'), await t.signIn('ada@example.org'), await t.signIn('ben@example.org'), await t.signIn('cleo@example.org')];
    meeting = await startMeeting(ada);
  });
  afterEach(async () => {
    await t.close();
  });

  test('Present list accepts participants in the audience only', async () => {
    const ok = await ben.request('PUT', `/threads/${meeting}/present`, { userIds: [ids.ada, ids.ben] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.map((p: any) => p.id).sort(), [ids.ada, ids.ben].sort());
    assert.deepEqual((await ada.request('GET', `/threads/${meeting}`)).body.present.map((p: any) => p.id).sort(), [ids.ada, ids.ben].sort());
    const outside = await ada.request('PUT', `/threads/${meeting}/present`, { userIds: [ids.ada, ids.outsider] });
    assert.equal(outside.status, 400);
    assert.equal((await ada.request('GET', `/threads/${meeting}`)).body.present.length, 2, 'a refused change leaves the list alone');
    assert.equal((await ada.request('PUT', `/threads/${meeting}/present`, { userIds: 'ada' })).status, 400);
    // Restricted to Ada only: Ben is a participant but outside the audience.
    const closed = await startMeeting(pm, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    assert.equal((await pm.request('PUT', `/threads/${closed}/present`, { userIds: [ids.ben] })).status, 400);
    assert.equal((await pm.request('PUT', `/threads/${closed}/present`, { userIds: [ids.ada, ids.pm] })).status, 200);
    assert.equal((await ben.request('PUT', `/threads/${closed}/present`, { userIds: [] })).status, 404);
    // Unticking is recorded, with ids only.
    assert.deepEqual((await ada.request('PUT', `/threads/${meeting}/present`, { userIds: [ids.ben] })).body.map((p: any) => p.id), [ids.ben]);
    const events = await t.pool.query(`SELECT detail FROM discussion_events WHERE thread_id = $1 AND action = 'present_changed' ORDER BY at, id`, [meeting]);
    assert.equal(events.rowCount, 2);
    // The fake clock gives both events the same instant, so find the unticking by its content.
    assert.deepEqual(events.rows.find((e) => e.detail.removed.length > 0)?.detail, { added: [], removed: [ids.ada] });
    // A discussion has no Present list.
    const thread = (await ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plain' })).body.id;
    assert.equal((await ada.request('PUT', `/threads/${thread}/present`, { userIds: [] })).status, 404);
  });

  test('ending refuses later posts, edits and Present changes but allows hide and delete', async () => {
    const msg = (await ada.request('POST', `/threads/${meeting}/messages`, { body: 'Agreed to ship.' })).body.id;
    const other = (await ben.request('POST', `/threads/${meeting}/messages`, { body: 'Fine by me.' })).body.id;
    const r = await ada.request('POST', `/threads/${meeting}/end`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'ended');
    assert.equal(r.body.canPost, false);
    const row = (await t.pool.query(`SELECT ended_by, ended_at FROM discussion_threads WHERE id = $1`, [meeting])).rows[0];
    assert.equal(row.ended_by, ids.ada);
    assert.ok(row.ended_at);
    for (const refused of [
      await ben.request('POST', `/threads/${meeting}/messages`, { body: 'late' }),
      await ada.request('PUT', `/messages/${msg}`, { body: 'Agreed to ship Monday.', basedOnVersion: 1 }),
      await ben.request('PUT', `/threads/${meeting}/present`, { userIds: [ids.ben] }),
      await ada.request('POST', `/threads/${meeting}/end`),
    ]) {
      assert.equal(refused.status, 409);
      assert.equal(refused.body.message, 'This meeting has ended.');
    }
    assert.equal((await pm.request('POST', `/messages/${msg}/hide`, { reason: 'Off topic' })).status, 200);
    assert.equal((await ben.request('POST', `/messages/${other}/delete`, { reason: 'Mine' })).status, 200);
    assert.equal((await pm.request('POST', `/messages/${other}/restore`, { reason: 'Mistake' })).status, 200);
    const event = (await t.pool.query(`SELECT detail FROM discussion_events WHERE thread_id = $1 AND action = 'meeting_ended'`, [meeting])).rows;
    assert.equal(event.length, 1);
  });

  test('ending calls the meeting-end hook once', async () => {
    assert.equal((await ada.request('POST', `/threads/${meeting}/end`)).status, 200);
    assert.deepEqual(ended, [meeting]);
    assert.equal((await ada.request('POST', `/threads/${meeting}/end`)).status, 409);
    assert.deepEqual(ended, [meeting], 'a refused second end does not call the hook again');
  });

  test('a failing hook does not undo the end', async () => {
    await t.close();
    t = await startTestApp(undefined, { meetingEndHook: { onMeetingEnded: async () => Promise.reject(new Error('queue down')) } });
    for (const k of ['pm', 'ada']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, { name: 'Beta Project', status: 'active', members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.ada, role: 'member' }] });
    ada = await t.signIn('ada@example.org');
    meeting = await startMeeting(ada);
    const r = await ada.request('POST', `/threads/${meeting}/end`);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'ended');
  });

  test('Member who did not start the meeting cannot end it', async () => {
    const r = await ben.request('POST', `/threads/${meeting}/end`);
    assert.equal(r.status, 403);
    assert.equal((await ada.request('GET', `/threads/${meeting}`)).body.state, 'open');
    assert.deepEqual(ended, []);
    assert.equal((await pm.request('POST', `/threads/${meeting}/end`)).status, 200, 'PM may end any meeting');
    const discussion = (await ada.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Plain' })).body.id;
    assert.equal((await ada.request('POST', `/threads/${discussion}/end`)).status, 404);
  });

  test('human minutes save creates version with origin human and label', async () => {
    const first = await save(pm, '# Minutes\n\nWe agreed to ship.', 0);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.versionNo, 1);
    assert.equal(first.body.origin, 'human');
    const pmName = (await t.pool.query('SELECT display_name FROM users WHERE id = $1', [ids.pm])).rows[0].display_name;
    assert.equal(first.body.label, `${AI_LABEL} · Edited by ${pmName}`);
    assert.equal(first.body.author.id, ids.pm);
    assert.equal(first.body.editedFromVersion, null);
    // Over an AI draft: the human version points back at it.
    const run = await seedRun('quiet_period');
    const ai = await insertAiDraft(t.pool, meeting, { body: 'AI text', coversThroughNo: 0, analysisRunId: run });
    assert.equal(ai.versionNo, 2);
    assert.equal(ai.origin, 'ai');
    assert.equal(ai.label, AI_LABEL);
    assert.equal(ai.author, null);
    const second = await save(ada, 'AI text, corrected', 2);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.versionNo, 3);
    assert.equal(second.body.editedFromVersion, 2);
    const view = (await ben.request('GET', `/threads/${meeting}/minutes`)).body;
    assert.equal(view.current.versionNo, 3);
    assert.equal(view.hasHumanVersion, true);
    assert.equal(view.canEdit, false);
    assert.equal(view.canPublish, false);
    assert.deepEqual(view.versions.map((v: any) => [v.versionNo, v.origin, v.trigger]), [[3, 'human', null], [2, 'ai', 'quiet_period'], [1, 'human', null]]);
    assert.equal(view.versions[2].author.id, ids.pm);
    const pmView = (await pm.request('GET', `/threads/${meeting}/minutes`)).body;
    assert.equal(pmView.canEdit, true);
    assert.equal(pmView.canPublish, true);
    assert.equal((await ada.request('GET', `/threads/${meeting}/minutes`)).body.canEdit, true, 'the starter edits');
    const old = await ben.request('GET', `/threads/${meeting}/minutes/1`);
    assert.equal(old.body.body, '# Minutes\n\nWe agreed to ship.');
    assert.equal((await ben.request('GET', `/threads/${meeting}/minutes/9`)).status, 404);
    // Editing continues after the meeting ends; a Member who is not the starter is refused.
    await ada.request('POST', `/threads/${meeting}/end`);
    assert.equal((await save(pm, 'After the meeting', 3)).status, 201);
    assert.equal((await save(ben, 'Not mine', 4)).status, 403);
    const events = await t.pool.query(`SELECT detail, draft_id FROM discussion_events WHERE thread_id = $1 AND action = 'minutes_edited' ORDER BY at, id`, [meeting]);
    assert.equal(events.rowCount, 3);
    assert.ok(events.rows.every((e) => e.draft_id && typeof e.detail.sha256 === 'string' && typeof e.detail.length === 'number' && !JSON.stringify(e.detail).includes('Minutes')));
  });

  test('minutes save based on an old version is refused (409)', async () => {
    assert.equal((await save(pm, 'Version one', 0)).status, 201);
    const stale = await save(ada, 'Ada was looking at nothing', 0);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.message, 'Someone changed this since you opened it');
    assert.equal(stale.body.current.versionNo, 1);
    assert.equal(stale.body.current.body, 'Version one');
    assert.equal((await save(pm, 'Version two', 1)).status, 201);
    assert.equal((await save(ada, 'Based on one', 1)).status, 409);
    assert.equal(await count('minutes_drafts'), 2, 'nothing was overwritten or added');
    // Two saves based on the same version: exactly one wins.
    const [a, b] = await Promise.all([save(pm, 'From PM', 2), save(ada, 'From Ada', 2)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(await count('minutes_drafts'), 3);
    assert.equal((await save(pm, 'x', undefined)).status, 400);
    assert.equal((await save(pm, '   ', 3)).status, 400);
    assert.equal((await save(pm, 'y'.repeat(100_001), 3)).status, 400);
  });

  test('secret in minutes is refused', async () => {
    const r = await save(pm, `Deploy with ${KEY} tonight`, 0);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /^Not posted: this looks like it contains .+\. Remove it and post again\.$/);
    assert.equal(await count('minutes_drafts'), 0);
    assert.equal((await t.pool.query(`SELECT count(*) AS n FROM discussion_events WHERE action = 'minutes_edited'`)).rows[0].n, '0');
  });

  test('Restricted meeting minutes are 404 to a Member outside the audience', async () => {
    const closed = await startMeeting(pm, { kind: 'meeting', title: 'Closed door', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    assert.equal((await save(pm, 'Private minutes', 0, closed)).status, 201);
    assert.equal((await ada.request('GET', `/threads/${closed}/minutes`)).status, 200);
    assert.equal((await cleo.request('GET', `/threads/${closed}/minutes`)).status, 404);
    assert.equal((await cleo.request('GET', `/threads/${closed}/minutes/1`)).status, 404);
    assert.equal((await cleo.request('POST', `/threads/${closed}/minutes`, { body: 'x', basedOnVersion: 1 })).status, 404);
    assert.equal((await cleo.request('POST', `/threads/${closed}/end`)).status, 404);
    assert.equal((await cleo.request('PUT', `/threads/${closed}/present`, { userIds: [] })).status, 404);
  });
});
