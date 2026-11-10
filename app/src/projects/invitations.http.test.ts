import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('project invitations', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    const admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.com', $2, now())`, [uuidv7(), admin]);
    await seedUser(t.pool, 'pm@example.com');
    pm = await t.signIn('pm@example.com');
    projectId = await seedProject(t.pool, { members: [{ userId: pm.userId, role: 'pm' }] });
  });
  afterEach(async () => {
    await t?.close();
  });

  const invite = (b: object) => pm.request('POST', `/projects/${projectId}/invitations`, { role: 'member', startsOn: '2026-11-09', ...b });
  const tokenFor = async (email: string) => {
    const link = await t.lastInvitationLink(email);
    return link.slice(link.lastIndexOf('/') + 1);
  };

  test('an invitation goes only to an eligible domain, and its link reaches the invitee', async () => {
    const bad = await invite({ email: 'someone@gmail.com' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, 'That address is not in an eligible organisation domain.');
    const made = await invite({ email: 'Lee@EXAMPLE.com' });
    assert.equal(made.status, 201);
    assert.equal(made.body.invitation.email, 'lee@example.com');
    assert.equal(Date.parse(made.body.invitation.expiresAt) - Date.parse(made.body.invitation.issuedAt), 7 * 24 * 3600 * 1000, 'exactly seven days');
    assert.equal(made.body.invitation.token, undefined, 'the token is never returned');
    assert.match(await t.lastInvitationLink('lee@example.com'), /^http:\/\/localhost:3000\/#\/invitations\/[A-Za-z0-9_-]{43}$/);
    const queued = (await t.outbox('lee@example.com'))[0];
    assert.deepEqual([queued.kind, queued.status, queued.project_id, queued.subject], ['invitation', 'queued', projectId, 'You are invited to Project in Kainow']);
    assert.match(queued.text_body, /invited to the project "Project" in Kainow as Member\.[\s\S]*The invitation expires on 2026-11-16 \d\d:\d\d UTC\./);
    const shown = await t.anonymous('GET', `/invitations/by-token/${await tokenFor('lee@example.com')}`);
    assert.equal(shown.status, 200);
    assert.deepEqual(Object.keys(shown.body.invitation).sort(), ['email', 'expiresAt', 'expiresOn', 'kind', 'projectName', 'role', 'startsOn', 'status']);
  });

  test('a new person requests a code, signs in and accepts; the membership follows the invitation dates', async () => {
    await invite({ email: 'lee@example.com', displayName: 'Lee Wong', startsOn: '2026-12-01' });
    const lee = await t.signIn('lee@example.com');
    assert.equal((await t.pool.query(`SELECT role, display_name FROM users WHERE id = $1`, [lee.userId])).rows[0].display_name, 'Lee Wong');
    const ok = await lee.request('POST', `/invitations/by-token/${await tokenFor('lee@example.com')}/accept`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.membership.state, 'scheduled');
    assert.equal((await lee.request('GET', `/projects/${projectId}`)).status, 404, 'no access before the start date');
    const again = await lee.request('POST', `/invitations/by-token/${await tokenFor('lee@example.com')}/accept`);
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'This invitation link is no longer valid.');
  });

  test('an existing account accepts and is Active today', async () => {
    await seedUser(t.pool, 'sam@example.com');
    await invite({ email: 'sam@example.com' });
    const sam = await t.signIn('sam@example.com');
    const r = await sam.request('POST', `/invitations/by-token/${await tokenFor('sam@example.com')}/accept`);
    assert.equal(r.body.membership.state, 'active');
    assert.equal((await sam.request('GET', `/projects/${projectId}`)).status, 200);
  });

  test('an address without an invitation or account still gets no code', async () => {
    await t.anonymous('POST', '/auth/request-code', { email: 'nobody@example.com' });
    assert.throws(() => t.sender.lastCode('nobody@example.com'));
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'nobody@example.com'`)).rows[0].n, 0);
  });

  test('decline, revoke and resend', async () => {
    await invite({ email: 'lee@example.com' });
    const first = await tokenFor('lee@example.com');
    t.clock.advanceSeconds(60); // so the resend is issued later; ids are not ordered within one millisecond
    const resent = await pm.request('POST', `/invitations/${(await t.pool.query(`SELECT id FROM invitations`)).rows[0].id}/resend`);
    assert.equal(resent.status, 201);
    const second = await tokenFor('lee@example.com');
    assert.notEqual(first, second);
    const lee = await t.signIn('lee@example.com');
    const old = await lee.request('POST', `/invitations/by-token/${first}/accept`);
    assert.equal(old.status, 409);
    assert.equal(old.body.message, 'This invitation link is no longer valid.');
    assert.equal((await lee.request('POST', `/invitations/by-token/${second}/decline`)).status, 200);
    assert.equal((await t.pool.query(`SELECT status FROM invitations ORDER BY issued_at, id`)).rows.map((r) => r.status).join(','), 'replaced,declined');

    await invite({ email: 'kim@example.com' });
    const kimInvitation = (await t.pool.query(`SELECT id FROM invitations WHERE email = 'kim@example.com'`)).rows[0].id;
    assert.equal((await pm.request('POST', `/invitations/${kimInvitation}/revoke`)).status, 200);
    const kim = await t.signIn('kim@example.com').catch(() => null);
    assert.equal(kim, null, 'a revoked invitation no longer opens sign-in for a new address');
  });

  test('an invitation expires exactly seven days after it was sent', async () => {
    const SIGN_IN_STEP = 61_000; // signIn moves the clock forward by this much
    const expiryOf = async (email: string) =>
      ((await t.pool.query(`SELECT expires_at FROM invitations WHERE email = $1`, [email])).rows[0].expires_at as Date).getTime();

    await seedUser(t.pool, 'sam@example.com');
    await invite({ email: 'sam@example.com' });
    const samToken = await tokenFor('sam@example.com');
    t.clock.ms = (await expiryOf('sam@example.com')) - 1000 - SIGN_IN_STEP;
    const sam = await t.signIn('sam@example.com');
    assert.equal((await sam.request('POST', `/invitations/by-token/${samToken}/accept`)).status, 200, 'one second before expiry');

    t.clock.ms = Date.UTC(2026, 10, 9, 3, 0, 0);
    pm = await t.signIn('pm@example.com');
    await invite({ email: 'kim@example.com' });
    const kimToken = await tokenFor('kim@example.com');
    t.clock.ms = (await expiryOf('kim@example.com')) - SIGN_IN_STEP;
    const kim = await t.signIn('kim@example.com');
    const late = await kim.request('POST', `/invitations/by-token/${kimToken}/accept`);
    assert.equal(late.status, 409, 'exactly at expiry');
    assert.equal(late.body.message, 'This invitation has expired. Ask for a new one.');
  });

  test('acceptance is refused while Deferred or Closed, after the domain is removed, and for a different signed-in address', async () => {
    await seedUser(t.pool, 'sam@example.com');
    await seedUser(t.pool, 'other@example.com');
    await invite({ email: 'sam@example.com' });
    const token = await tokenFor('sam@example.com');
    const other = await t.signIn('other@example.com');
    const wrong = await other.request('POST', `/invitations/by-token/${token}/accept`);
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.message, 'This invitation was sent to a different email address.');

    const sam = await t.signIn('sam@example.com');
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    const deferred = await sam.request('POST', `/invitations/by-token/${token}/accept`);
    assert.equal(deferred.status, 409);
    assert.equal(deferred.body.message, 'Invitations cannot be accepted while the project is Deferred or Closed.');
    await t.pool.query(`UPDATE projects SET status = 'draft' WHERE id = $1`, [projectId]);
    await t.pool.query(`UPDATE eligible_domains SET removed_at = now(), removed_by = $1`, [pm.userId]);
    const removed = await sam.request('POST', `/invitations/by-token/${token}/accept`);
    assert.equal(removed.status, 409);
    assert.equal(removed.body.message, 'That address is not in an eligible organisation domain.');
  });

  test('a Member cannot invite, and nobody can invite while the project is Deferred', async () => {
    await seedUser(t.pool, 'mem@example.com');
    const mem = await t.signIn('mem@example.com');
    await t.pool.query(`INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'member', '2026-11-01')`, [uuidv7(), projectId, mem.userId]);
    assert.equal((await mem.request('POST', `/projects/${projectId}/invitations`, { email: 'x@example.com', role: 'member', startsOn: '2026-11-09' })).status, 403);
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await invite({ email: 'y@example.com' })).status, 403);
  });
});
