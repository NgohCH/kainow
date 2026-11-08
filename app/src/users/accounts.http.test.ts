import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

describe('accounts', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await startTestApp();
  });
  afterEach(async () => {
    await t?.close();
  });

  test('disabling a member does not need a second administrator', async () => {
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    const member = await seedUser(t.pool, 'member@example.org');
    const admin = await t.signIn('admin@example.org');
    assert.equal((await admin.request('POST', `/users/${member}/disable`)).status, 204);
    assert.equal((await admin.request('POST', `/users/${(await admin.request('GET', '/auth/me')).body.user.id}/disable`)).status, 409, 'the last administrator stays protected');
  });

  test('sign out everywhere ends every session', async () => {
    await seedUser(t.pool, 'sam@example.org');
    const first = await t.signIn('sam@example.org');
    const second = await t.signIn('sam@example.org');
    assert.equal((await second.request('GET', '/auth/me')).body.user.email, 'sam@example.org');
    assert.equal((await first.request('POST', '/auth/logout-all')).status, 204);
    assert.equal((await first.request('GET', '/projects')).status, 401);
    assert.equal((await second.request('GET', '/projects')).status, 401);
  });

  test("an invitee's account is Invited until the first sign-in", async () => {
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    const admin = await t.signIn('admin@example.org');
    await seedDepartment(t.pool);
    await admin.request('POST', '/domains', { domain: 'help.edu.my' });
    const pm = await seedUser(t.pool, 'pm@help.edu.my');
    const id = await seedProject(t.pool, { members: [{ userId: pm, role: 'pm' }] });
    const pmClient = await t.signIn('pm@help.edu.my');
    assert.equal((await pmClient.request('POST', `/projects/${id}/invitations`, { email: 'new@help.edu.my', role: 'member', startsOn: '2026-11-09' })).status, 201);
    await t.anonymous('POST', '/auth/request-code', { email: 'new@help.edu.my' });
    const status = async () => (await t.pool.query(`SELECT status FROM users WHERE email = 'new@help.edu.my'`)).rows[0].status;
    assert.equal(await status(), 'invited');
    t.clock.advanceSeconds(61);
    await t.signIn('new@help.edu.my');
    assert.equal(await status(), 'active');
  });
});
