import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';

describe('report types over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;
  const reason = 'Agreed with the PMO';
  const names = async (c: Client, path: string) => (await c.request('GET', path)).body.reportTypes.map((r: { name: string }) => r.name);

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'ann@example.org');
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('ann@example.org');
  });
  afterEach(async () => t.close());

  test('Administrator adds, renames and retires; retired types are not offered but keep history', async () => {
    assert.deepEqual(await names(admin, '/admin/report-types'), ['Status reports', 'Decisions and actions', 'Risk summaries', 'Specifications', 'Minutes', 'Exports', 'Other']);
    const added = await admin.request('POST', '/admin/report-types', { name: '  Lessons learned ', reason });
    assert.equal(added.status, 201);
    assert.equal(added.body.position, 8, 'goes to the end');
    t.clock.advanceSeconds(1);
    const id = added.body.id;
    assert.equal((await admin.request('PUT', `/admin/report-types/${id}`, { name: 'Lessons', reason })).status, 200);
    t.clock.advanceSeconds(1);
    const minutes = (await admin.request('GET', '/admin/report-types')).body.reportTypes.find((r: { name: string }) => r.name === 'Minutes');
    assert.equal((await admin.request('PUT', `/admin/report-types/${minutes.id}`, { status: 'retired', reason })).body.status, 'retired');
    assert.equal((await admin.request('PUT', `/admin/report-types/${minutes.id}`, { status: 'retired', reason })).status, 409);

    assert.ok(!(await names(member, '/report-types')).includes('Minutes'), 'not offered');
    assert.ok((await names(member, '/report-types')).includes('Lessons'));
    assert.ok((await names(admin, '/admin/report-types')).includes('Minutes'), 'still listed for the Administrator');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM report_types WHERE name = 'Minutes'`)).rows[0].n, 1, 'history kept');

    const audit = (await t.pool.query(`SELECT action, detail FROM audit_events WHERE action LIKE 'report_type.%' ORDER BY occurred_at, id`)).rows;
    assert.deepEqual(audit.map((a) => a.action), ['report_type.added', 'report_type.renamed', 'report_type.retired']);
    assert.deepEqual([audit[1].detail.previous, audit[1].detail.next, audit[1].detail.reason], ['Lessons learned', 'Lessons', reason]);
  });

  test('names unique and 1 to 100 characters; a reason is needed', async () => {
    assert.equal((await admin.request('POST', '/admin/report-types', { name: 'minutes', reason })).status, 409);
    assert.equal((await admin.request('POST', '/admin/report-types', { name: '   ', reason })).status, 400);
    assert.equal((await admin.request('POST', '/admin/report-types', { name: 'x'.repeat(101), reason })).status, 400);
    assert.equal((await admin.request('POST', '/admin/report-types', { name: 'x'.repeat(100), reason })).status, 201);
    assert.equal((await admin.request('POST', '/admin/report-types', { name: 'Fresh' })).status, 400);
    assert.equal((await admin.request('POST', '/admin/report-types', { name: 'Fresh', reason: '  ' })).status, 400);
    const other = (await admin.request('GET', '/admin/report-types')).body.reportTypes.find((r: { name: string }) => r.name === 'Other');
    assert.equal((await admin.request('PUT', `/admin/report-types/${other.id}`, { name: 'EXPORTS', reason })).status, 409);
    assert.equal((await admin.request('PUT', `/admin/report-types/${other.id}`, { name: 'OTHER', reason })).status, 200, 'its own name in another case');
    assert.equal((await admin.request('PUT', '/admin/report-types/not-an-id', { name: 'A', reason })).status, 404);
  });

  test('members cannot manage', async () => {
    assert.equal((await member.request('GET', '/admin/report-types')).status, 403);
    assert.equal((await member.request('POST', '/admin/report-types', { name: 'Mine', reason })).status, 403);
    assert.equal((await member.request('PUT', '/admin/report-types/00000000-0000-4000-8000-000000000000', { name: 'Mine', reason })).status, 403);
    assert.equal((await t.anonymous('GET', '/report-types')).status, 401);
  });
});
