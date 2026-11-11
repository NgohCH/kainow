import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('changing an audience and restricted evidence', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let deputy: Client;
  let sponsor: Client;
  let ada: Client;
  let ben: Client;

  const startMeeting = async (c: Client, body: Record<string, unknown> = { kind: 'meeting', title: 'Weekly check-in' }) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const audienceOf = async (threadId: string) => (await t.pool.query(`SELECT audience_id AS id FROM discussion_threads WHERE id = $1`, [threadId])).rows[0].id as string;
  const publishMinutes = async (threadId: string) => {
    assert.equal((await pm.request('POST', `/threads/${threadId}/minutes`, { body: '## Minutes\nShip on Friday.', basedOnVersion: 0 })).status, 201);
    const r = await pm.request('POST', `/threads/${threadId}/minutes/1/publish`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.sourceId as string;
  };
  const versionOf = async (sourceId: string) => (await t.pool.query(`SELECT id FROM source_versions WHERE source_id = $1 ORDER BY version_no DESC LIMIT 1`, [sourceId])).rows[0].id as string;
  /** A finished run on a source's latest version with one action item quoting `quote`. */
  const seedItem = async (sourceId: string, quote: string) => {
    const v = await versionOf(sourceId);
    const run = uuidv7();
    const item = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at) VALUES ($1,$2,$3,'succeeded',1,0,now(),now())`,
      [run, v, ids.pm],
    );
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, due, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1,$2,$3,0,'action','Ship on Friday.','by 20 November 2026',$4,0,10,1,now())`,
      [item, run, v, quote],
    );
    return { run, item };
  };

  beforeEach(async () => {
    t = await startTestApp();
    for (const k of ['pm', 'deputy', 'sponsor', 'owner', 'ada', 'ben']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.ben, role: 'member' },
      ],
    });
    [pm, deputy, sponsor, ada, ben] = [
      await t.signIn('pm@example.org'),
      await t.signIn('deputy@example.org'),
      await t.signIn('sponsor@example.org'),
      await t.signIn('ada@example.org'),
      await t.signIn('ben@example.org'),
    ];
  });
  afterEach(async () => {
    await t.close();
  });

  test('PM changes a meeting to Restricted and its published minutes follow', async () => {
    const meeting = await startMeeting(ada);
    const source = await publishMinutes(meeting);
    const audience = await audienceOf(meeting);
    assert.equal((await ben.request('GET', `/notes/${source}`)).status, 200);
    assert.equal((await ben.request('GET', `/threads/${meeting}`)).body.audience.changedAt, null);

    const r = await pm.request('PUT', `/audiences/${audience}`, { mode: 'restricted', namedUserIds: [ids.ada], reason: 'Personnel matter' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, 'restricted');
    assert.deepEqual(r.body.namedUsers.map((p: any) => p.id), [ids.ada]);
    assert.equal((await t.pool.query(`SELECT audience_id FROM sources WHERE id = $1`, [source])).rows[0].audience_id, audience, 'one shared row');

    for (const path of [`/threads/${meeting}`, `/notes/${source}`, `/notes/${source}/versions/1`]) {
      assert.equal((await ben.request('GET', path)).status, 404, `ben ${path}`);
      assert.equal((await ada.request('GET', path)).status, 200, `ada ${path}`);
    }
    const view = (await ada.request('GET', `/threads/${meeting}`)).body.audience;
    assert.ok(view.changedAt && !Number.isNaN(Date.parse(view.changedAt)));
    const note = (await ada.request('GET', `/notes/${source}`)).body.source.audience;
    assert.equal(note.mode, 'restricted');
    assert.equal(note.changedAt, view.changedAt);
    assert.equal(note.id, audience, 'the note gives the audience id');
    assert.deepEqual(note.namedUsers.map((p: any) => p.id), [ids.ada]);
  });

  test('Deputy cannot change (403)', async () => {
    const audience = await audienceOf(await startMeeting(ada));
    const r = await deputy.request('PUT', `/audiences/${audience}`, { mode: 'restricted', namedUserIds: [], reason: 'x' });
    assert.equal(r.status, 403);
    assert.equal((await deputy.request('POST', `/audiences/${audience}/preview`, { mode: 'restricted', namedUserIds: [] })).status, 403);
    assert.equal((await ada.request('PUT', `/audiences/${audience}`, { mode: 'restricted', namedUserIds: [], reason: 'x' })).status, 403, 'a Member in the audience');
    assert.equal((await t.pool.query(`SELECT mode FROM audiences WHERE id = $1`, [audience])).rows[0].mode, 'project');
  });

  test('a Member outside a restricted audience gets 404, not 403 or 400', async () => {
    const audience = await audienceOf(await startMeeting(pm, { kind: 'meeting', title: 'Closed', audience: { mode: 'restricted', namedUserIds: [ids.ada] } }));
    assert.equal((await ben.request('PUT', `/audiences/${audience}`, { mode: 'nonsense' })).status, 404);
    assert.equal((await ben.request('POST', `/audiences/${audience}/preview`, {})).status, 404);
    assert.equal((await ben.request('PUT', `/audiences/${uuidv7()}`, { mode: 'project' })).status, 404);
    assert.equal((await ada.request('PUT', `/audiences/${audience}`, { mode: 'project', namedUserIds: [], reason: 'x' })).status, 403);
  });

  test('preview lists gain and lose', async () => {
    const audience = await audienceOf(await startMeeting(pm, { kind: 'meeting', title: 'Closed', audience: { mode: 'restricted', namedUserIds: [ids.ada] } }));
    const r = await pm.request('POST', `/audiences/${audience}/preview`, { mode: 'restricted', namedUserIds: [ids.ben] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.gain.map((p: any) => p.id), [ids.ben]);
    assert.deepEqual(r.body.lose.map((p: any) => p.id), [ids.ada]);
    const open = await pm.request('POST', `/audiences/${audience}/preview`, { mode: 'project', namedUserIds: [] });
    assert.deepEqual(open.body.gain.map((p: any) => p.id), [ids.ben]);
    assert.deepEqual(open.body.lose, []);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audience_events`)).rows[0].n, 0, 'a preview changes nothing');
  });

  test('history row has old and new settings and reason', async () => {
    const audience = await audienceOf(await startMeeting(ada));
    assert.equal((await sponsor.request('PUT', `/audiences/${audience}`, { mode: 'restricted', namedUserIds: [ids.ada] })).status, 400, 'a reason is required');
    assert.equal((await sponsor.request('PUT', `/audiences/${audience}`, { mode: 'restricted', namedUserIds: [ids.ada], reason: 'Sensitive' })).status, 200);
    assert.equal((await pm.request('PUT', `/audiences/${audience}`, { mode: 'project', namedUserIds: [], reason: 'No longer sensitive' })).status, 200);
    const rows = (await t.pool.query(`SELECT * FROM audience_events WHERE audience_id = $1 ORDER BY to_mode DESC`, [audience])).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0].from_mode, rows[0].to_mode, rows[0].from_named, rows[0].to_named, rows[0].reason, rows[0].actor_id], ['project', 'restricted', [], [ids.ada], 'Sensitive', ids.sponsor]);
    assert.deepEqual([rows[1].from_mode, rows[1].to_mode, rows[1].to_named, rows[1].reason], ['restricted', 'project', [], 'No longer sensitive']);
  });

  test('Member outside the audience: extraction run 404, record visible with restricted evidence', async () => {
    const meeting = await startMeeting(ada);
    const source = await publishMinutes(meeting);
    const { run, item } = await seedItem(source, 'Friday shipping was agreed');
    const sourceVersionId = await versionOf(source);
    const auth = await pm.request('POST', `/extractions/${run}/items/${item}/authorise`, { sourceVersionId, assigneeId: ids.ada, dueOn: '2026-11-20' });
    assert.equal(auth.status, 201, JSON.stringify(auth.body));
    const taskId = auth.body.record.id as string;

    const open = (await ben.request('GET', `/projects/${project}/records`)).body.tasks[0];
    assert.equal(open.source.quote, 'Friday shipping was agreed', 'project-wide: unchanged shape');
    assert.ok('sourceFlag' in open.source);

    await pm.request('PUT', `/audiences/${await audienceOf(meeting)}`, { mode: 'restricted', namedUserIds: [ids.ada], reason: 'Personnel matter' });
    assert.equal((await ben.request('GET', `/extractions/${run}`)).status, 404);
    assert.equal((await ben.request('GET', `/notes/${source}/versions/1/extractions`)).status, 404);
    const list = (await ben.request('GET', `/projects/${project}/records`)).body.tasks[0];
    const one = (await ben.request('GET', `/records/tasks/${taskId}`)).body.task;
    for (const task of [list, one]) {
      assert.deepEqual(task.source, { restricted: true });
      assert.ok(!JSON.stringify(task).includes('Friday shipping was agreed'), 'neither quote nor flag leaks');
    }
    const inside = (await ada.request('GET', `/projects/${project}/records`)).body.tasks[0];
    assert.equal(inside.source.quote, 'Friday shipping was agreed');
    assert.ok('sourceFlag' in inside.source);
  });

  test("Owner not in a custom audience still reviews a pending item's excerpt", async () => {
    const ownerClient = await t.signIn('owner@example.org');
    const meeting = await startMeeting(pm, { kind: 'meeting', title: 'Closed', audience: { mode: 'restricted', namedUserIds: [ids.ada] } });
    const source = await publishMinutes(meeting);
    const { run } = await seedItem(source, 'Friday shipping was agreed');
    assert.equal((await ben.request('GET', `/extractions/${run}`)).status, 404, 'a Member not named finds nothing');
    const r = await ownerClient.request('GET', `/extractions/${run}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items[0].quote, 'Friday shipping was agreed');
    assert.equal(r.body.permissions.reject, true, 'and may review it');
  });
});
