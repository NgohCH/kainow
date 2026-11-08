import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('account disable and membership holds', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pma', 'pmb', 'pmc', 'owner', 'sponsor', 'mem', 'other']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const state = async (projectId: string, userId: string) =>
    (await t.pool.query(`SELECT hold_reason, held_at IS NOT NULL AS held FROM memberships WHERE project_id = $1 AND user_id = $2`, [projectId, userId])).rows[0];

  test('disabling holds current memberships and alerts each project', async () => {
    const a = await seedProject(t.pool, { status: 'active', name: 'A', members: [{ userId: ids.pma, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.mem, role: 'member' }] });
    const b = await seedProject(t.pool, { name: 'B', members: [{ userId: ids.pmb, role: 'pm' }, { userId: ids.mem, role: 'member', startsOn: '2026-12-01' }] });
    const c = await seedProject(t.pool, { name: 'C', members: [{ userId: ids.pmc, role: 'pm' }, { userId: ids.mem, role: 'member', expiresOn: '2026-11-05' }] });
    const d = await seedProject(t.pool, { name: 'D', members: [{ userId: ids.pmc, role: 'pm' }, { userId: ids.mem, role: 'member', revoked: true }] });
    const mem = await t.signIn('mem@example.org');
    assert.equal((await admin.request('POST', `/users/${ids.mem}/disable`)).status, 204);
    assert.deepEqual(await state(a, ids.mem), { hold_reason: 'Account disabled', held: true });
    assert.deepEqual(await state(b, ids.mem), { hold_reason: 'Account disabled', held: true });
    assert.equal((await state(c, ids.mem)).held, false, 'an expired membership is untouched');
    assert.equal((await state(d, ids.mem)).held, false, 'a revoked membership is untouched');
    assert.deepEqual(t.sender.holdAlerts.map((x) => [x.email, x.projectName]).sort(), [['pma@example.org', 'A'], ['pmb@example.org', 'B']]);
    assert.match(t.sender.holdAlerts[0].link, /#\/projects\/[0-9a-f-]{36}\/people$/);
    const pm = await t.signIn('pma@example.org');
    const p = (await pm.request('GET', `/projects/${a}`)).body.project;
    assert.equal(p.onHold, true);
    assert.equal(p.memberships.find((m: { email: string }) => m.email === 'mem@example.org').state, 'on_hold');
    assert.equal((await mem.request('GET', '/projects')).status, 401);
    const events = (await t.pool.query(`SELECT count(*)::int AS n FROM membership_events WHERE kind = 'held'`)).rows[0].n;
    assert.equal(events, 2);
  });

  test('if the Project Manager is the one disabled, the Owner and Sponsors are told', async () => {
    await seedProject(t.pool, {
      status: 'active',
      name: 'E',
      members: [{ userId: ids.pma, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.sponsor, role: 'sponsor' }, { userId: ids.mem, role: 'member' }],
    });
    await admin.request('POST', `/users/${ids.pma}/disable`);
    assert.deepEqual(t.sender.holdAlerts.map((x) => x.email).sort(), ['owner@example.org', 'sponsor@example.org']);
  });

  test('re-enabling leaves holds in place', async () => {
    const a = await seedProject(t.pool, { members: [{ userId: ids.pma, role: 'pm' }, { userId: ids.mem, role: 'member' }] });
    await admin.request('POST', `/users/${ids.mem}/disable`);
    assert.equal((await admin.request('POST', `/users/${ids.mem}/enable`)).status, 204);
    assert.equal((await state(a, ids.mem)).held, true);
    const mem = await t.signIn('mem@example.org');
    assert.equal((await mem.request('GET', `/projects/${a}`)).status, 404, 'a held membership gives no access');
  });

  test('disable, restore and disable again', async () => {
    const a = await seedProject(t.pool, { members: [{ userId: ids.pma, role: 'pm' }, { userId: ids.mem, role: 'member' }] });
    await admin.request('POST', `/users/${ids.mem}/disable`);
    await admin.request('POST', `/users/${ids.mem}/enable`);
    t.clock.advanceSeconds(60);
    await t.pool.query(`UPDATE memberships SET restored_at = $3, restore_reason = 'Cleared' WHERE project_id = $1 AND user_id = $2`, [a, ids.mem, new Date(t.clock.now())]);
    t.clock.advanceSeconds(60);
    await admin.request('POST', `/users/${ids.mem}/disable`);
    const pm = await t.signIn('pma@example.org');
    const row = (await pm.request('GET', `/projects/${a}`)).body.project.memberships.find((m: { email: string }) => m.email === 'mem@example.org');
    assert.equal(row.state, 'on_hold');
    const events = (await t.pool.query(`SELECT count(*)::int AS n FROM membership_events WHERE kind = 'held'`)).rows[0].n;
    assert.equal(events, 2);
  });
});

describe('findings and restoring from hold', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'mem', 'mem2', 'owner2']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    admin = await t.signIn('admin@example.org');
    await admin.request('POST', '/domains', { domain: 'example.org' });
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.mem, role: 'member' },
        { userId: ids.mem2, role: 'member' },
      ],
    });
  });
  afterEach(async () => {
    await t?.close();
  });

  const membershipOf = async (userId: string, role = 'member') =>
    (await t.pool.query(`SELECT id FROM memberships WHERE project_id = $1 AND user_id = $2 AND role = $3`, [projectId, userId, role])).rows[0].id as string;

  test('the Project Manager records a finding; other members cannot read it', async () => {
    await admin.request('POST', `/users/${ids.mem}/disable`);
    const mid = await membershipOf(ids.mem);
    const pm = await t.signIn('pm@example.org');
    const rec = await pm.request('POST', `/memberships/${mid}/findings`, { finding: 'Left the unit on 1 November.', recommendation: 'revoke' });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    const mem2 = await t.signIn('mem2@example.org');
    const hidden = await mem2.request('GET', `/memberships/${mid}/findings`);
    assert.equal(hidden.status, 403);
    assert.equal(hidden.body.message, 'Only the investigators and the managers of this role can read the findings.');
    const owner = await t.signIn('owner@example.org');
    const seen = await owner.request('GET', `/memberships/${mid}/findings`);
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.body.findings.map((f: { finding: string; recommendation: string }) => [f.finding, f.recommendation]), [['Left the unit on 1 November.', 'revoke']]);
    const notHeld = await pm.request('POST', `/memberships/${await membershipOf(ids.mem2)}/findings`, { finding: 'x', recommendation: 'restore' });
    assert.equal(notHeld.status, 409);
    assert.equal(notHeld.body.message, 'This membership is not On Hold.');
  });

  test('restore needs an enabled account and keeps the role rules', async () => {
    await admin.request('POST', `/users/${ids.mem}/disable`);
    const mid = await membershipOf(ids.mem);
    const pm = await t.signIn('pm@example.org');
    const early = await pm.request('POST', `/memberships/${mid}/restore`, { reason: 'Cleared' });
    assert.equal(early.status, 409);
    assert.equal(early.body.message, 'The account is disabled; an Administrator must enable it first.');
    await admin.request('POST', `/users/${ids.mem}/enable`);
    assert.equal((await pm.request('POST', `/memberships/${mid}/restore`, { reason: 'Cleared after investigation' })).status, 200);
    const state = async (id: string) =>
      (await pm.request('GET', `/projects/${projectId}`)).body.project.memberships.find((m: { id: string }) => m.id === id).state;
    assert.equal(await state(mid), 'active');

    // A held Scheduled membership returns as Scheduled.
    const later = await seedUser(t.pool, 'later@example.org');
    assert.equal((await pm.request('POST', `/projects/${projectId}/members`, { userId: later, role: 'member', startsOn: '2026-12-01' })).status, 201);
    await admin.request('POST', `/users/${later}/disable`);
    await admin.request('POST', `/users/${later}/enable`);
    const laterId = await membershipOf(later);
    assert.equal((await pm.request('POST', `/memberships/${laterId}/restore`, { reason: 'Cleared' })).status, 200);
    assert.equal(await state(laterId), 'scheduled');

    // A held Owner cannot come back once another Owner holds the role.
    await admin.request('POST', `/users/${ids.owner}/disable`);
    await admin.request('POST', `/users/${ids.owner}/enable`);
    assert.equal((await admin.request('POST', `/projects/${projectId}/members`, { userId: ids.owner2, role: 'owner', startsOn: '2026-11-09' })).status, 201);
    const back = await admin.request('POST', `/memberships/${await membershipOf(ids.owner, 'owner')}/restore`, { reason: 'Cleared' });
    assert.equal(back.status, 409);
    assert.equal(back.body.message, 'Those dates would give the project two Owners at the same time.');
  });

  test("a restore needs a reason and the role's manager", async () => {
    await admin.request('POST', `/users/${ids.mem}/disable`);
    await admin.request('POST', `/users/${ids.mem}/enable`);
    const mid = await membershipOf(ids.mem);
    const pm = await t.signIn('pm@example.org');
    const noReason = await pm.request('POST', `/memberships/${mid}/restore`, {});
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.message, 'A reason is required.');
    const mem2 = await t.signIn('mem2@example.org');
    assert.equal((await mem2.request('POST', `/memberships/${mid}/restore`, { reason: 'x' })).status, 403);
  });

  test('revoking a held membership ends it', async () => {
    await admin.request('POST', `/users/${ids.mem}/disable`);
    const pm = await t.signIn('pm@example.org');
    assert.equal((await pm.request('POST', `/memberships/${await membershipOf(ids.mem)}/revoke`, { reason: 'Left the organisation' })).status, 200);
    const row = (await pm.request('GET', `/projects/${projectId}`)).body.project.memberships.find((m: { email: string }) => m.email === 'mem@example.org');
    assert.equal(row.state, 'revoked');
  });
});
