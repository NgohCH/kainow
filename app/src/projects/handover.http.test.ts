import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('Project Manager handover', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let owner: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'mem', 'next']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    const admin = await t.signIn('admin@example.org');
    await admin.request('POST', '/domains', { domain: 'example.org' });
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.mem, role: 'member' }],
    });
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const handover = (by: Client, over: object = {}) => by.request('POST', `/projects/${projectId}/handover`, { email: 'lee@example.org', outgoingRole: 'member', ...over });
  const tokenFor = async (email: string) => (await t.lastInvitationLink(email)).split('#/invitations/')[1];
  const rows = async () =>
    (
      await t.pool.query(
        `SELECT u.email, m.role, m.revoked_at IS NOT NULL AS revoked, m.revoke_reason FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.project_id = $1 ORDER BY u.email, m.role`,
        [projectId],
      )
    ).rows;

  test('the replacement accepts and becomes Project Manager; the outgoing PM becomes a Member', async () => {
    const issued = await handover(pm);
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const listed = (await pm.request('GET', `/projects/${projectId}`)).body.project.invitations.find((i: { email: string }) => i.email === 'lee@example.org');
    assert.equal(listed.kind, 'handover', 'the People tab can show it as a handover');
    assert.equal((await t.anonymous('GET', `/invitations/by-token/${await tokenFor('lee@example.org')}`)).body.invitation.kind, 'handover');
    const lee = await t.signIn('lee@example.org');
    const accepted = await lee.request('POST', `/invitations/by-token/${await tokenFor('lee@example.org')}/accept`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(await rows(), [
      { email: 'lee@example.org', role: 'pm', revoked: false, revoke_reason: null },
      { email: 'mem@example.org', role: 'member', revoked: false, revoke_reason: null },
      { email: 'owner@example.org', role: 'owner', revoked: false, revoke_reason: null },
      { email: 'pm@example.org', role: 'member', revoked: false, revoke_reason: null },
      { email: 'pm@example.org', role: 'pm', revoked: true, revoke_reason: 'Handed over' },
    ]);
    const p = (await lee.request('GET', `/projects/${projectId}`)).body.project;
    assert.deepEqual(p.myRoles, ['pm']);
  });

  test('leaving the project', async () => {
    await handover(pm, { outgoingRole: 'leave' });
    const lee = await t.signIn('lee@example.org');
    assert.equal((await lee.request('POST', `/invitations/by-token/${await tokenFor('lee@example.org')}/accept`)).status, 200);
    assert.equal((await pm.request('GET', `/projects/${projectId}`)).status, 404);
  });

  test('only the current PM can hand over, once at a time', async () => {
    const byOwner = await handover(owner);
    assert.equal(byOwner.status, 403);
    assert.equal(byOwner.body.message, 'Only the current Project Manager can hand over the project.');
    const self = await handover(pm, { email: 'pm@example.org' });
    assert.equal(self.status, 400);
    assert.equal(self.body.message, 'Choose someone else to take over.');
    assert.equal((await handover(pm, { outgoingRole: 'owner' })).status, 400);
    assert.equal((await handover(pm)).status, 201);
    const second = await handover(pm, { email: 'next@example.org' });
    assert.equal(second.status, 409);
    assert.equal(second.body.message, 'A handover is already waiting; send it again or withdraw it.');
  });

  test('a handover is refused once the outgoing PM is no longer PM', async () => {
    await handover(pm);
    t.clock.advanceSeconds(60);
    assert.equal((await owner.request('POST', `/projects/${projectId}/members`, { userId: ids.next, role: 'pm', startsOn: '2026-11-09' })).status, 201);
    const lee = await t.signIn('lee@example.org');
    const late = await lee.request('POST', `/invitations/by-token/${await tokenFor('lee@example.org')}/accept`);
    assert.equal(late.status, 409);
    assert.equal(late.body.message, 'This handover is no longer valid.');
  });

  test('withdrawing a handover', async () => {
    const id = (await handover(pm)).body.invitation.id;
    assert.equal((await pm.request('POST', `/invitations/${id}/revoke`)).status, 200);
    const page = await t.anonymous('GET', `/invitations/by-token/${await tokenFor('lee@example.org')}`);
    assert.equal(page.body.invitation.status, 'revoked');
  });

  test('a handover that would leave no separate Member is refused at acceptance', async () => {
    t.clock.advanceSeconds(60);
    await handover(pm, { email: 'mem@example.org', outgoingRole: 'leave' });
    const mem = await t.signIn('mem@example.org');
    const r = await mem.request('POST', `/invitations/by-token/${await tokenFor('mem@example.org')}/accept`);
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'Arrange a replacement first. Without this appointment the project would be missing a Member who is not the Project Manager.');
  });
});
