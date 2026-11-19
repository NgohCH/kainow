import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { leadershipProjectIds } from './grants';
import { todayUtc8 } from '../projects/membership';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

const URL = '/admin/leadership-grants';

describe('leadership grants (D89)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let adminId: string;
  let member: Client;
  let leader: string;
  let deptA: string;
  let deptB: string;
  let pa: string;
  let pb: string;

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    leader = await seedUser(t.pool, 'leader@example.org');
    await seedUser(t.pool, 'plain@example.org');
    deptA = await seedDepartment(t.pool, 'Alpha Unit');
    deptB = await seedDepartment(t.pool, 'Beta Unit');
    pa = await seedProject(t.pool, { status: 'active', members: [], departmentId: deptA });
    pb = await seedProject(t.pool, { status: 'active', members: [], departmentId: deptB });
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('plain@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const today = () => todayUtc8(t.clock.now());
  const ids = () => leadershipProjectIds(t.pool, leader, today());
  const post = (b: Record<string, unknown>) => admin.request('POST', URL, { userId: leader, scope: { kind: 'organisation' }, startsOn: '2026-11-09', reason: 'Quarterly review', ...b });

  test('non-EA 403', async () => {
    assert.equal((await member.request('GET', URL)).status, 403);
    assert.equal((await member.request('POST', URL, { userId: leader, scope: { kind: 'organisation' }, startsOn: '2026-11-09', reason: 'x' })).status, 403);
    assert.equal((await member.request('POST', `${URL}/${leader}/end`, { expiresOn: null, reason: 'x' })).status, 403);
    assert.equal((await member.request('POST', `${URL}/${leader}/revoke`, { reason: 'x' })).status, 403);
    assert.equal((await t.anonymous('GET', URL)).status, 401);
    assert.equal((await t.pool.query(`SELECT 1 FROM leadership_grants`)).rowCount, 0);
  });

  test('grant records the event and audit, and shows in the list with its state', async () => {
    const r = await post({ scope: { kind: 'departments', departmentIds: [deptA] }, expiresOn: '2026-11-12', reason: '  Oversight of Alpha  ' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.grant.state, 'active');
    assert.equal(r.body.grant.reason, 'Oversight of Alpha');
    const events = (await t.pool.query(`SELECT kind, actor_id, reason FROM leadership_grant_events`)).rows;
    assert.deepEqual(events, [{ kind: 'granted', actor_id: adminId, reason: 'Oversight of Alpha' }]);
    assert.equal((await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'leadership.granted'`)).rowCount, 1);
    const list = await admin.request('GET', URL);
    assert.equal(list.body.grants.length, 1);
    assert.equal(list.body.grants[0].departments[0].name, 'Alpha Unit');
    // A leadership grant adds no project access.
    assert.equal((await t.pool.query(`SELECT 1 FROM memberships WHERE user_id = $1`, [leader])).rowCount, 0);
  });

  test('grant works on its last day and ends at 00:00 UTC+8 after', async () => {
    // Start of the test clock: 2026-11-09 10:00 UTC+8.
    assert.equal((await post({ scope: { kind: 'projects', projectIds: [pa] }, expiresOn: '2026-11-09' })).status, 201);
    assert.deepEqual(await ids(), [pa]);
    t.clock.ms = Date.UTC(2026, 10, 9, 15, 59, 0); // 23:59 UTC+8
    assert.equal(today(), '2026-11-09');
    assert.deepEqual(await ids(), [pa]);
    t.clock.ms = Date.UTC(2026, 10, 9, 16, 0, 0); // 00:00 UTC+8 next day
    assert.equal(today(), '2026-11-10');
    assert.equal(await ids(), null);
  });

  test('scheduled before start', async () => {
    const r = await post({ startsOn: '2026-11-10' });
    assert.equal(r.body.grant.state, 'scheduled');
    assert.equal(await ids(), null);
    t.clock.ms = Date.UTC(2026, 10, 9, 16, 0, 0);
    assert.notEqual(await ids(), null);
  });

  test('revoked ends at once, and cannot be changed again', async () => {
    const id = (await post({})).body.grant.id;
    assert.notEqual(await ids(), null);
    assert.equal((await admin.request('POST', `${URL}/${id}/revoke`, { reason: '' })).status, 400);
    const r = await admin.request('POST', `${URL}/${id}/revoke`, { reason: 'Role changed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.grant.state, 'revoked');
    assert.equal(await ids(), null);
    assert.equal((await admin.request('POST', `${URL}/${id}/revoke`, { reason: 'Again' })).status, 409);
    assert.equal((await admin.request('POST', `${URL}/${id}/end`, { expiresOn: null, reason: 'Again' })).status, 409);
    assert.deepEqual((await t.pool.query(`SELECT kind FROM leadership_grant_events `)).rows.map((x) => x.kind).sort(), ['granted', 'revoked']);
    assert.equal((await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'leadership.revoked'`)).rowCount, 1);
  });

  test('change the end date: shorten, extend and remove, each with a reason and an event', async () => {
    const id = (await post({ expiresOn: '2026-11-20' })).body.grant.id;
    assert.equal((await admin.request('POST', `${URL}/${id}/end`, { expiresOn: '2026-11-08', reason: 'Too early' })).status, 400);
    assert.equal((await admin.request('POST', `${URL}/${id}/end`, { expiresOn: '2026-11-30' })).status, 400);
    assert.equal((await admin.request('POST', `${URL}/${id}/end`, { expiresOn: 'soon', reason: 'Bad' })).status, 400);
    const r = await admin.request('POST', `${URL}/${id}/end`, { expiresOn: '2026-11-30', reason: 'Extended' });
    t.clock.advanceSeconds(1);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.grant.expiresOn, '2026-11-30');
    const none = await admin.request('POST', `${URL}/${id}/end`, { expiresOn: null, reason: 'No end' });
    assert.equal(none.body.grant.expiresOn, null);
    const ev = (await t.pool.query(`SELECT kind, detail FROM leadership_grant_events WHERE kind = 'end_changed' ORDER BY at, id`)).rows;
    assert.equal(ev.length, 2);
    assert.deepEqual(ev[0].detail, { previousExpiresOn: '2026-11-20', expiresOn: '2026-11-30' });
    assert.equal((await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'leadership.end_changed'`)).rowCount, 2);
    assert.equal((await admin.request('POST', `${URL}/${'00000000-0000-7000-8000-000000000000'}/end`, { expiresOn: null, reason: 'x' })).status, 404);
  });

  test('self-grant refused', async () => {
    const r = await post({ userId: adminId });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Nobody can grant leadership access to themselves.');
    assert.equal((await t.pool.query(`SELECT 1 FROM leadership_grants`)).rowCount, 0);
  });

  test('other refusals: not Active, empty lists, end before start, reason, dates, scope', async () => {
    const off = await seedUser(t.pool, 'off@example.org');
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [off]);
    assert.equal((await post({ userId: off })).status, 400);
    assert.equal((await post({ userId: '00000000-0000-7000-8000-000000000000' })).status, 400);
    assert.equal((await post({ scope: { kind: 'departments', departmentIds: [] } })).status, 400);
    assert.equal((await post({ scope: { kind: 'departments' } })).status, 400);
    assert.equal((await post({ scope: { kind: 'projects', projectIds: [] } })).status, 400);
    assert.equal((await post({ scope: { kind: 'projects', projectIds: ['00000000-0000-7000-8000-000000000000'] } })).status, 400);
    assert.equal((await post({ scope: { kind: 'departments', departmentIds: ['00000000-0000-7000-8000-000000000000'] } })).status, 400);
    assert.equal((await post({ scope: { kind: 'everything' } })).status, 400);
    assert.equal((await post({ startsOn: '2026-11-10', expiresOn: '2026-11-09' })).status, 400);
    assert.equal((await post({ startsOn: '10 Nov' })).status, 400);
    for (const reason of [undefined, '', '   ', 'x'.repeat(1001), `key is sk-${'a1B2c3D4e5'.repeat(3)}`]) {
      assert.equal((await post({ reason })).status, 400, `reason ${String(reason).length}`);
    }
    assert.equal((await post({ reason: 'x'.repeat(1000) })).status, 201);
    assert.equal((await t.pool.query(`SELECT 1 FROM leadership_grants`)).rowCount, 1);
  });

  test('a grant is not limited by the Audit and Oversight grant length setting', async () => {
    // The spec ties D90 grant length to Audit/Oversight grants only.
    assert.equal((await post({ startsOn: '2026-11-09', expiresOn: '2028-11-09' })).status, 201);
  });

  test('department scope follows an ownership transfer', async () => {
    assert.equal((await post({ scope: { kind: 'departments', departmentIds: [deptA] } })).status, 201);
    assert.deepEqual(await ids(), [pa]);
    const moved = await admin.request('POST', `/projects/${pb}/department`, { departmentId: deptA, reason: 'Reorganised' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual((await ids())?.sort(), [pa, pb].sort());
    const back = await admin.request('POST', `/projects/${pa}/department`, { departmentId: deptB, reason: 'Reorganised again' });
    assert.ok(back.status < 300, JSON.stringify(back.body));
    assert.deepEqual(await ids(), [pb]);
  });

  test('union of two grants', async () => {
    await post({ scope: { kind: 'departments', departmentIds: [deptA] } });
    await post({ scope: { kind: 'projects', projectIds: [pb] } });
    assert.deepEqual((await ids())?.sort(), [pa, pb].sort());
    const list = await admin.request('GET', URL);
    assert.equal(list.body.grants.length, 2);
  });

  test('disabled account has no scope', async () => {
    await post({});
    assert.notEqual(await ids(), null);
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [leader]);
    assert.equal(await ids(), null);
  });
});
