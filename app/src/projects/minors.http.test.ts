import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const BAD = '------------------------------------';

describe('review minors from sub-project 1', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'mem']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    admin = await t.signIn('admin@example.org');
    await admin.request('POST', '/domains', { domain: 'example.org' });
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.mem, role: 'member' }],
    });
    pm = await t.signIn('pm@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const invite = (over: object = {}) => pm.request('POST', `/projects/${projectId}/invitations`, { email: 'new@example.org', role: 'member', startsOn: '2026-11-09', ...over });

  test('a malformed id is not found, never a server error', async () => {
    assert.equal(BAD.length, 36);
    assert.equal((await pm.request('POST', `/memberships/${BAD}/extend`, { expiresOn: '2027-01-01' })).status, 404);
    assert.equal((await pm.request('POST', `/invitations/${BAD}/resend`)).status, 404);
    assert.equal((await pm.request('POST', `/projects/${BAD}/edit`, { name: 'x' })).status, 404);
    assert.equal((await pm.request('POST', `/projects/${projectId}/members`, { userId: BAD, role: 'member', startsOn: '2026-11-09' })).status, 400);
    assert.equal((await pm.request('POST', `/projects/${projectId}/edit`, { owningDepartmentId: BAD })).status, 400);
  });

  test('an invitation for a membership that has already ended is refused', async () => {
    const past = await invite({ startsOn: '2026-11-02', expiresOn: '2026-11-08' });
    assert.equal(past.status, 400);
    assert.equal(past.body.message, 'That membership would already have ended.');
    assert.equal((await invite({ expiresOn: '2026-11-10' })).status, 201);
    t.clock.advanceSeconds(2 * 86400);
    const late = await t.signIn('new@example.org');
    const token = (await t.lastInvitationLink('new@example.org')).split('#/invitations/')[1];
    const r = await late.request('POST', `/invitations/by-token/${token}/accept`);
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'That membership would already have ended.');
  });

  test('an invitation is queued in the outbox, and the invitation stands whatever happens to delivery', async () => {
    const r = await invite();
    assert.equal(r.status, 201);
    assert.equal(r.body.delivered, true);
    const rows = await t.outbox('new@example.org');
    assert.deepEqual(rows.map((x) => [x.kind, x.status]), [['invitation', 'queued']]);
    assert.equal((await invite({ email: 'other@example.org' })).body.delivered, true);
  });

  test('unanswered invitations can be withdrawn while Deferred; a second open invitation is refused', async () => {
    const id = (await invite()).body.invitation.id;
    const twice = await invite();
    assert.equal(twice.status, 409);
    assert.equal(twice.body.message, 'An invitation is already waiting; send it again instead.');
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await pm.request('POST', `/invitations/${id}/revoke`)).status, 200);
  });

  test("the administrator's list shows every project with its role holders", async () => {
    for (const n of ['B', 'C']) await seedProject(t.pool, { name: n, members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.mem, role: 'member' }] });
    const all = (await admin.request('GET', '/projects')).body.all;
    assert.equal(all.length, 3);
    for (const p of all) assert.ok(p.roleHolders.some((h: { role: string }) => h.role === 'pm'), p.name);
  });

  test("creating a project rechecks the creator's domain", async () => {
    await seedUser(t.pool, 'x@outside.example.net');
    const dept = (await t.pool.query(`SELECT owning_department_id AS d FROM projects WHERE id = $1`, [projectId])).rows[0].d;
    const x = await t.signIn('x@outside.example.net');
    const r = await x.request('POST', '/projects', { name: 'New', purpose: 'p', owningDepartmentId: dept });
    assert.equal(r.status, 403);
    assert.equal(r.body.message, 'Your email domain is no longer eligible; ask an Administrator.');
    assert.equal((await pm.request('POST', '/projects', { name: 'New', purpose: 'p', owningDepartmentId: dept })).status, 201);
  });
});
