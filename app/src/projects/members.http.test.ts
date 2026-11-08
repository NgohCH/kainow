import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('project memberships and role management', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let owner: Client;
  let member: Client;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'member']) await seedUser(t.pool, `${p}@example.org`);
    for (const p of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    member = await t.signIn('member@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const appoint = (c: Client, projectId: string, b: object) => c.request('POST', `/projects/${projectId}/members`, { startsOn: '2026-11-09', ...b });
  const memberships = async (projectId: string) =>
    (await t.pool.query(`SELECT user_id, role, revoked_at IS NOT NULL AS revoked FROM memberships WHERE project_id = $1 ORDER BY starts_on, id`, [projectId])).rows;

  test('each role is managed only by its managers', async () => {
    const id = await seedProject(t.pool, { members: [{ userId: pm.userId, role: 'pm' }, { userId: owner.userId, role: 'owner' }, { userId: member.userId, role: 'member' }] });
    const owner2 = await appoint(pm, id, { userId: ids.x1, role: 'owner' });
    assert.equal(owner2.status, 403);
    assert.equal(owner2.body.message, 'Only an Enterprise Administrator can manage the Owner role.');
    assert.equal((await appoint(member, id, { userId: ids.x1, role: 'member' })).status, 403);
    assert.equal((await appoint(pm, id, { userId: ids.x1, role: 'member' })).status, 201);
    assert.equal((await appoint(owner, id, { userId: ids.x2, role: 'sponsor' })).status, 201);
    assert.equal((await appoint(pm, id, { userId: ids.x3, role: 'sponsor' })).status, 403);
    assert.equal((await appoint(admin, id, { userId: ids.x3, role: 'deputy_pm' })).status, 403, 'the administrator does not manage Deputies');
  });

  test('a project has only one Owner, and a new Project Manager replaces the old one', async () => {
    const id = await seedProject(t.pool, { members: [{ userId: pm.userId, role: 'pm' }, { userId: owner.userId, role: 'owner' }] });
    const second = await appoint(admin, id, { userId: ids.x1, role: 'owner' });
    assert.equal(second.status, 409);
    assert.equal(second.body.message, 'A project can have only one Owner.');
    assert.equal((await appoint(owner, id, { userId: ids.x1, role: 'pm' })).status, 201);
    const rows = await memberships(id);
    assert.deepEqual(rows.filter((r: { role: string }) => r.role === 'pm').map((r: { user_id: string; revoked: boolean }) => [r.user_id, r.revoked]), [
      [pm.userId, true],
      [ids.x1, false],
    ]);
    const events = (await t.pool.query(`SELECT kind FROM membership_events ORDER BY at, id`)).rows.map((r) => r.kind);
    assert.deepEqual(events.sort(), ['appointed', 'revoked']);
  });

  test('dates cannot be before the project was created, or end before they start', async () => {
    const id = await seedProject(t.pool, { members: [{ userId: pm.userId, role: 'pm' }] });
    const early = await appoint(pm, id, { userId: ids.x1, role: 'member', startsOn: '2026-10-30' });
    assert.equal(early.status, 400);
    assert.equal(early.body.message, 'Membership dates cannot be before the project was created.');
    const backwards = await appoint(pm, id, { userId: ids.x1, role: 'member', startsOn: '2026-11-10', expiresOn: '2026-11-09' });
    assert.equal(backwards.status, 400);
    assert.equal(backwards.body.message, 'The expiry cannot be before the start.');
    assert.equal((await appoint(pm, id, { userId: ids.x1, role: 'member', startsOn: '10/11/2026' })).body.message, 'Dates must be in the form YYYY-MM-DD.');
  });

  test('extend, change dates and revoke are recorded with previous and new dates', async () => {
    const id = await seedProject(t.pool, { members: [{ userId: pm.userId, role: 'pm' }] });
    const made = await appoint(pm, id, { userId: ids.x1, role: 'member', expiresOn: '2026-11-30' });
    const mid = made.body.membership.id;
    assert.equal((await pm.request('POST', `/memberships/${mid}/extend`, { expiresOn: '2026-12-31' })).status, 200);
    assert.equal((await pm.request('POST', `/memberships/${mid}/dates`, { startsOn: '2026-11-10', expiresOn: '2026-12-31' })).status, 200);
    const noReason = await pm.request('POST', `/memberships/${mid}/revoke`, {});
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.message, 'A reason is required.');
    assert.equal((await pm.request('POST', `/memberships/${mid}/revoke`, { reason: 'Left the team' })).status, 200);
    assert.equal((await member.request('POST', `/memberships/${mid}/extend`, { expiresOn: '2027-01-31' })).status, 404, 'a non-participant cannot see it');
    const events = (
      await t.pool.query(
        `SELECT kind, to_char(previous_expires_on, 'YYYY-MM-DD') AS prev, to_char(new_expires_on, 'YYYY-MM-DD') AS next FROM membership_events WHERE membership_id = $1 ORDER BY at, id`,
        [mid],
      )
    ).rows;
    assert.deepEqual(events.map((e) => e.kind).sort(), ['appointed', 'dates_changed', 'extended', 'revoked']);
    assert.ok(events.some((e) => e.kind === 'extended' && e.prev === '2026-11-30' && e.next === '2026-12-31'));
  });

  test('the seventh person is refused while one person combines Project Manager and Owner', async () => {
    const id = await seedProject(t.pool, {
      members: [{ userId: pm.userId, role: 'pm' }, { userId: pm.userId, role: 'owner' }, ...['x1', 'x2', 'x3', 'x4', 'x5'].map((k) => ({ userId: ids[k], role: 'member' as const }))],
    });
    const seventh = await appoint(pm, id, { userId: ids.x6, role: 'member' });
    assert.equal(seventh.status, 409);
    assert.equal(seventh.body.message, 'With seven or more people, the Project Manager, Owner and Sponsors must be different people.');
  });

  test('two simultaneous Owner appointments: exactly one succeeds', async () => {
    const id = await seedProject(t.pool, { members: [{ userId: pm.userId, role: 'pm' }] });
    const [a, b] = await Promise.all([appoint(admin, id, { userId: ids.x1, role: 'owner' }), appoint(admin, id, { userId: ids.x2, role: 'owner' })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM memberships WHERE project_id = $1 AND role = 'owner'`, [id])).rows[0].n, 1);
  });

  test('a required role that expired while Deferred can be repaired, and the project then resumes', async () => {
    const id = await seedProject(t.pool, {
      status: 'deferred',
      members: [
        { userId: pm.userId, role: 'pm', expiresOn: '2026-11-05' },
        { userId: owner.userId, role: 'owner' },
        { userId: member.userId, role: 'member' },
      ],
    });
    const resume = () => owner.request('POST', `/projects/${id}/transition`, { to: 'active', reason: 'Budget approved', stage: 'Execution' });
    assert.equal((await resume()).status, 409, 'the Project Manager has expired');
    const pmRow = (await t.pool.query(`SELECT id FROM memberships WHERE project_id = $1 AND role = 'pm'`, [id])).rows[0];
    const extend = await owner.request('POST', `/memberships/${pmRow.id}/extend`, { expiresOn: '2026-12-31' });
    assert.equal(extend.status, 200, JSON.stringify(extend.body));
    assert.equal((await appoint(owner, id, { userId: ids.x1, role: 'member' })).status, 201, 'appointing is a repair too');
    assert.equal((await resume()).status, 200);
  });

  test('a required role cannot be removed until a replacement is arranged, except in a Draft', async () => {
    const id = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: pm.userId, role: 'pm' },
        { userId: owner.userId, role: 'owner' },
        { userId: member.userId, role: 'member' },
      ],
    });
    const memberRow = (await t.pool.query(`SELECT id FROM memberships WHERE project_id = $1 AND role = 'member'`, [id])).rows[0].id;
    const refused = await pm.request('POST', `/memberships/${memberRow}/revoke`, { reason: 'Left the team' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, 'Arrange a replacement first. Without this appointment the project would be missing a Member who is not the Project Manager.');
    assert.equal((await appoint(pm, id, { userId: ids.x1, role: 'member', startsOn: '2026-11-12' })).status, 201, 'a Scheduled replacement counts');
    assert.equal((await pm.request('POST', `/memberships/${memberRow}/revoke`, { reason: 'Left the team' })).status, 200);

    const draft = await seedProject(t.pool, { members: [{ userId: pm.userId, role: 'pm' }, { userId: member.userId, role: 'member' }] });
    const draftMember = (await t.pool.query(`SELECT id FROM memberships WHERE project_id = $1 AND role = 'member'`, [draft])).rows[0].id;
    assert.equal((await pm.request('POST', `/memberships/${draftMember}/revoke`, { reason: 'Changed plan' })).status, 200);
  });

  test('role managers stay as named while Deferred or Closed', async () => {
    const id = await seedProject(t.pool, { status: 'closed', members: [{ userId: pm.userId, role: 'pm' }, { userId: member.userId, role: 'member' }] });
    const refused = await appoint(member, id, { userId: ids.x1, role: 'member' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, 'Only the Project Manager, the Owner or a Sponsor can manage the Member role.');
    assert.equal((await appoint(pm, id, { userId: ids.x1, role: 'member' })).status, 201);
  });
});
