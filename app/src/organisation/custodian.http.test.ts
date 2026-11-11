import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';

const BLANK = "Give the custodian's name and how to reach them.";

/** The recovery custodian recorded on the Organisation page (O07). */
describe('recovery custodian', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const audits = async () =>
    (await t.pool.query(`SELECT actor_user_id, detail FROM audit_events WHERE action = 'organisation.recovery_custodian_changed' ORDER BY occurred_at, id`)).rows;

  test('starts empty, and an Administrator records and changes it, each change audited with old and new values', async () => {
    assert.deepEqual((await admin.request('GET', '/organisation/recovery-custodian')).body, { name: null, contact: null });
    const put = await admin.request('PUT', '/organisation/recovery-custodian', { name: '  Casey Custodian ', contact: ' custodian@example.org ' });
    assert.deepEqual([put.status, put.body], [200, { name: 'Casey Custodian', contact: 'custodian@example.org' }]);
    assert.deepEqual((await admin.request('GET', '/organisation/recovery-custodian')).body, { name: 'Casey Custodian', contact: 'custodian@example.org' });
    t.clock.advanceSeconds(60);
    await admin.request('PUT', '/organisation/recovery-custodian', { name: 'Casey Custodian', contact: '+60 3 0000 0000' });
    const rows = await audits();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].actor_user_id, admin.userId);
    assert.deepEqual(rows[0].detail, { from: { name: null, contact: null }, to: { name: 'Casey Custodian', contact: 'custodian@example.org' } });
    assert.deepEqual(rows[1].detail, {
      from: { name: 'Casey Custodian', contact: 'custodian@example.org' },
      to: { name: 'Casey Custodian', contact: '+60 3 0000 0000' },
    });
    const org = (await t.pool.query(`SELECT updated_by FROM organisation WHERE id = 1`)).rows[0];
    assert.equal(org.updated_by, admin.userId);
  });

  test('both fields are required and trimmed non-empty, and each is at most 200 characters; nothing changes on refusal', async () => {
    for (const body of [{}, { name: 'Casey' }, { contact: 'c@example.org' }, { name: '   ', contact: 'c@example.org' }, { name: 'Casey', contact: '  ' }, { name: 5, contact: 'x' }]) {
      const r = await admin.request('PUT', '/organisation/recovery-custodian', body);
      assert.deepEqual([r.status, r.body.message], [400, BLANK], JSON.stringify(body));
    }
    assert.equal((await admin.request('PUT', '/organisation/recovery-custodian', { name: 'x'.repeat(201), contact: 'c' })).status, 400);
    assert.equal((await admin.request('PUT', '/organisation/recovery-custodian', { name: 'c', contact: 'x'.repeat(201) })).status, 400);
    assert.equal((await admin.request('PUT', '/organisation/recovery-custodian', { name: 'x'.repeat(200), contact: 'y'.repeat(200) })).status, 200);
    assert.equal((await audits()).length, 1);
  });

  test('saving the same values again records nothing new', async () => {
    await admin.request('PUT', '/organisation/recovery-custodian', { name: 'Casey', contact: 'c@example.org' });
    await admin.request('PUT', '/organisation/recovery-custodian', { name: 'Casey', contact: 'c@example.org' });
    assert.equal((await audits()).length, 1);
  });

  test('only Enterprise Administrators: a member is refused, someone signed out must sign in', async () => {
    await seedUser(t.pool, 'member@example.org');
    const member = await t.signIn('member@example.org');
    assert.equal((await member.request('GET', '/organisation/recovery-custodian')).status, 403);
    assert.equal((await member.request('PUT', '/organisation/recovery-custodian', { name: 'Me', contact: 'me@example.org' })).status, 403);
    assert.equal((await t.anonymous('GET', '/organisation/recovery-custodian')).status, 401);
    assert.equal((await audits()).length, 0);
    const org = (await t.pool.query(`SELECT recovery_custodian_name, recovery_custodian_contact FROM organisation WHERE id = 1`)).rows[0];
    assert.deepEqual(org, { recovery_custodian_name: null, recovery_custodian_contact: null });
  });

  test('before the organisation row exists, saving is refused with 409 and nothing is recorded', async () => {
    await t.pool.query(`DELETE FROM organisation`);
    const r = await admin.request('PUT', '/organisation/recovery-custodian', { name: 'Casey', contact: 'c@example.org' });
    assert.equal(r.status, 409);
    assert.equal((r.body as { message: string }).message, 'Set up the organisation first.');
    assert.deepEqual(await audits(), []);
  });

  test('a disabled Administrator can no longer use it', async () => {
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE email = 'admin@example.org'`);
    assert.equal((await admin.request('GET', '/organisation/recovery-custodian')).status, 401);
  });
});
