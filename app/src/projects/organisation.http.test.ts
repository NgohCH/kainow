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

  test('a retired department’s name is never used again: it is brought back instead', async () => {
    const id = (await admin.request('POST', '/departments', { name: 'Water Services' })).body.department.id;
    const other = (await admin.request('POST', '/departments', { name: 'Asset Management' })).body.department.id;
    assert.equal((await admin.request('POST', `/departments/${id}/retire`)).status, 200);

    // Adding it again, in any case or spacing, is refused and names the retired department.
    for (const name of ['Water Services', 'water  services', ' WATER SERVICES ']) {
      const again = await admin.request('POST', '/departments', { name });
      assert.equal(again.status, 409, name);
      assert.equal(again.body.message, 'A retired department is called Water Services. Bring it back instead of making a second one.');
      assert.deepEqual(again.body.retiredDepartment, { id, name: 'Water Services' });
    }
    // So is renaming another department to it.
    assert.equal((await admin.request('POST', `/departments/${other}/rename`, { name: 'Water services' })).status, 409);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM departments`)).rows[0].n, 2);

    // Bringing it back: Administrator only, keeps the id, and it can be chosen again.
    assert.equal((await member.request('POST', `/departments/${id}/restore`)).status, 403);
    const back = await admin.request('POST', `/departments/${id}/restore`);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(back.body.department, { id, name: 'Water Services', status: 'active' });
    assert.deepEqual((await member.request('GET', '/departments')).body.departments.map((d: { id: string }) => d.id).sort(), [id, other].sort());
    assert.equal((await admin.request('POST', `/departments/${id}/restore`)).status, 409, 'not retired');
    const audit = await t.pool.query(`SELECT actor_user_id FROM audit_events WHERE action = 'department.restored' AND subject_id = $1`, [id]);
    assert.equal(audit.rowCount, 1);

    // A retired department whose name an active one took meanwhile (made before this rule) cannot come back under it.
    assert.equal((await admin.request('POST', `/departments/${other}/retire`)).status, 200);
    await t.pool.query(`INSERT INTO departments (id, name, created_by, created_at) SELECT gen_random_uuid(), 'Asset Management', created_by, created_at FROM departments WHERE id = $1`, [other]);
    const clash = await admin.request('POST', `/departments/${other}/restore`);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.message, 'A department with that name already exists.');
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
