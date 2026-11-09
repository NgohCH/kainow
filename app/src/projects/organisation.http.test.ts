import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';

describe('departments and eligible domains', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;

  beforeEach(async () => {
    // Before setup, so the last department and domain may still be retired or removed (after setup: onboarding.http.test).
    t = await startTestApp(undefined, { organisation: false });
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'sam@example.org');
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('sam@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  test('only an administrator manages departments; everyone signed in can read the active ones', async () => {
    assert.equal((await member.request('POST', '/departments', { name: 'Registry' })).status, 403);
    const made = await admin.request('POST', '/departments', { name: ' Registry ' });
    assert.equal(made.status, 201);
    assert.equal(made.body.department.name, 'Registry');
    const id = made.body.department.id;
    assert.equal((await admin.request('POST', '/departments', { name: 'registry' })).status, 409);
    assert.equal((await admin.request('POST', '/departments', { name: '  ' })).status, 400);

    const renamed = await admin.request('POST', `/departments/${id}/rename`, { name: 'Registry Office' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.department.id, id, 'renaming keeps the id');

    const list = await member.request('GET', '/departments');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.departments.map((d: { name: string }) => d.name), ['Registry Office']);

    assert.equal((await admin.request('POST', `/departments/${id}/retire`)).status, 200);
    assert.deepEqual((await member.request('GET', '/departments')).body.departments, []);
    const all = await admin.request('GET', '/departments?all=1');
    assert.equal(all.body.departments[0].status, 'retired');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'department.%'`)).rows[0].n, 3);
  });

  test('only an administrator manages eligible domains', async () => {
    assert.equal((await member.request('GET', '/domains')).status, 403);
    assert.equal((await member.request('POST', '/domains', { domain: 'example.com' })).status, 403);
    const made = await admin.request('POST', '/domains', { domain: ' EXAMPLE.com ' });
    assert.equal(made.status, 201);
    assert.equal(made.body.domain.domain, 'example.com');
    assert.equal((await admin.request('POST', '/domains', { domain: 'example.com' })).status, 409);
    for (const bad of ['', 'example', 'a@example.com', 'example .com']) {
      const r = await admin.request('POST', '/domains', { domain: bad });
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.message, 'Enter a domain such as example.com.');
    }
    assert.equal((await admin.request('POST', `/domains/${made.body.domain.id}/remove`)).status, 200);
    assert.deepEqual((await admin.request('GET', '/domains')).body.domains, []);
    assert.equal((await admin.request('POST', '/domains', { domain: 'example.com' })).status, 201, 'a removed domain can be added again');
  });
});
