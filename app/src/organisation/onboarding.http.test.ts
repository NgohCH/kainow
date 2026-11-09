import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';

const GATED = 'Set up the organisation first.';

/** Onboarding: everything stays closed until an Enterprise Administrator finishes setting up the organisation. */
describe('onboarding', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;

  beforeEach(async () => {
    t = await startTestApp(undefined, { organisation: false });
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const finishSetup = async () => {
    await admin.request('POST', '/organisation/name', { name: 'Example Organisation' });
    await admin.request('POST', '/domains', { domain: 'example.org' });
    await admin.request('POST', '/departments', { name: 'Operations' });
    return admin.request('POST', '/organisation/finish', {});
  };

  test('before setup, only sign-in, setup and onboarding routes answer', async () => {
    for (const [method, path] of [['GET', '/projects'], ['POST', '/projects'], ['GET', '/users']] as const) {
      const r = await admin.request(method, path, method === 'POST' ? {} : undefined);
      assert.deepEqual([r.status, r.body?.message], [409, GATED], `${method} ${path}`);
    }
    assert.equal((await admin.request('GET', '/auth/me')).status, 200);
    assert.equal((await admin.request('GET', '/domains')).status, 200);
    assert.equal((await admin.request('POST', '/departments', { name: 'Operations' })).status, 201);
    assert.equal((await admin.request('GET', '/organisation')).status, 200);
    assert.equal((await t.anonymous('GET', '/health')).status, 200);
    assert.equal((await t.anonymous('POST', '/auth/request-code', { email: 'admin@example.org' })).status, 202);
    // Unusual requests are refused the same way, and an unknown route is still "not found".
    assert.equal((await fetch(`${t.base}/projects`, { method: 'HEAD' })).status, 409);
    assert.equal((await t.anonymous('GET', '/no-such-route')).status, 404);
  });

  test('Finish setup names what is missing, then opens everything', async () => {
    const finish = () => admin.request('POST', '/organisation/finish', {});
    assert.deepEqual([(await finish()).status, (await finish()).body.message], [400, 'Give the organisation a name.']);
    await admin.request('POST', '/organisation/name', { name: 'Example Organisation' });
    assert.equal((await finish()).body.message, 'Add at least one email domain.');
    await admin.request('POST', '/domains', { domain: 'example.org' });
    assert.equal((await finish()).body.message, 'Add at least one department.');
    await admin.request('POST', '/departments', { name: 'Operations' });
    const done = await finish();
    assert.deepEqual([done.status, done.body], [200, { registered: true }]);
    assert.equal((await admin.request('GET', '/projects')).status, 200);
    const org = (await admin.request('GET', '/organisation')).body;
    assert.deepEqual([org.registered, org.name], [true, 'Example Organisation']);
  });

  test('the name is cleaned and limited', async () => {
    const r = await admin.request('POST', '/organisation/name', { name: '  Example   Organisation ' });
    assert.deepEqual([r.status, r.body], [200, { name: 'Example Organisation' }]);
    assert.equal((await admin.request('POST', '/organisation/name', { name: 'x'.repeat(201) })).status, 400);
    assert.equal((await admin.request('POST', '/organisation/name', { name: '   ' })).status, 400);
  });

  test('two Finish setup requests at once register the organisation once', async () => {
    await seedUser(t.pool, 'second@example.org', 'enterprise_administrator');
    const second = await t.signIn('second@example.org');
    await admin.request('POST', '/organisation/name', { name: 'Example Organisation' });
    await admin.request('POST', '/domains', { domain: 'example.org' });
    await admin.request('POST', '/departments', { name: 'Operations' });
    const results = await Promise.all([admin.request('POST', '/organisation/finish', {}), second.request('POST', '/organisation/finish', {})]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    const audits = (await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'organisation.registered'`)).rows[0].n;
    assert.equal(audits, 1);
  });

  test('a member cannot set up the organisation', async () => {
    await seedUser(t.pool, 'member@example.org');
    const member = await t.signIn('member@example.org');
    assert.equal((await member.request('POST', '/organisation/name', { name: 'X' })).status, 403);
    assert.equal((await member.request('POST', '/organisation/finish', {})).status, 403);
  });

  test('after setup the last domain and the last active department stay', async () => {
    await finishSetup();
    const domainId = (await admin.request('GET', '/domains')).body.domains[0].id;
    const departmentId = (await admin.request('GET', '/departments')).body.departments[0].id;
    const d = await admin.request('POST', `/domains/${domainId}/remove`, {});
    assert.deepEqual([d.status, d.body.message], [409, 'The organisation needs at least one email domain.']);
    const p = await admin.request('POST', `/departments/${departmentId}/retire`, {});
    assert.deepEqual([p.status, p.body.message], [409, 'The organisation needs at least one active department.']);
    await admin.request('POST', '/domains', { domain: 'example.com' });
    assert.equal((await admin.request('POST', `/domains/${domainId}/remove`, {})).status, 200);
  });

  test('renaming after setup is recorded with the old and new name', async () => {
    await finishSetup();
    t.clock.advanceSeconds(60);
    await admin.request('POST', '/organisation/name', { name: 'Example Organisation Two' });
    const row = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'organisation.renamed'`)).rows[0];
    assert.deepEqual(row.detail, { from: 'Example Organisation', to: 'Example Organisation Two' });
  });
});
