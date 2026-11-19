import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedUser } from '../testing/projects';

describe('analytics saved views', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let admin2: Client;
  let member: Client;
  let dept: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'admin2@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    dept = await seedDepartment(t.pool, 'Alpha Unit');
    admin = await t.signIn('admin@example.org');
    admin2 = await t.signIn('admin2@example.org');
    member = await t.signIn('member@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  test("own views CRUD; another user's view 404; name unique per user", async () => {
    assert.equal((await member.request('GET', '/admin/analytics/views')).status, 403);
    assert.deepEqual((await admin.request('GET', '/admin/analytics/views')).body, { views: [] });

    const created = await admin.request('POST', '/admin/analytics/views', {
      name: '  Weekly look  ',
      config: { filters: { period: 'last_4w', department: dept, status: ['active'], ownership: 'owned', includeArchived: true }, panels: { order: ['trends', 'progress'], hidden: ['system'] } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const view = created.body.view;
    assert.equal(view.name, 'Weekly look');
    assert.equal(view.config.filters.period, 'last_4w');
    assert.equal(view.config.filters.department, dept);
    assert.deepEqual(view.config.filters.status, ['active']);
    assert.deepEqual(view.config.panels.order.slice(0, 2), ['trends', 'progress']);
    assert.deepEqual(view.config.panels.hidden, ['system']);

    const list = await admin.request('GET', '/admin/analytics/views');
    assert.deepEqual(list.body.views.map((v: any) => v.id), [view.id]);
    assert.deepEqual((await admin2.request('GET', '/admin/analytics/views')).body, { views: [] });

    // Same name for the same user is refused; another user may use it.
    const dup = await admin.request('POST', '/admin/analytics/views', { name: 'Weekly look', config: {} });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal((await admin2.request('POST', '/admin/analytics/views', { name: 'Weekly look', config: {} })).status, 201);

    // Another user's view is not found, for every verb.
    assert.equal((await admin2.request('PUT', `/admin/analytics/views/${view.id}`, { name: 'Taken', config: {} })).status, 404);
    assert.equal((await admin2.request('DELETE', `/admin/analytics/views/${view.id}`)).status, 404);
    assert.equal((await admin2.request('GET', `/admin/analytics/views/${view.id}`)).status, 404);
    assert.equal((await admin.request('GET', `/admin/analytics/views/${uuidv7()}`)).status, 404);
    assert.equal((await admin.request('GET', '/admin/analytics/views/not-a-uuid')).status, 404);

    const one = await admin.request('GET', `/admin/analytics/views/${view.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.view.name, 'Weekly look');

    const updated = await admin.request('PUT', `/admin/analytics/views/${view.id}`, { name: 'Monthly look', config: { filters: { period: 'this_month' } } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.view.name, 'Monthly look');
    assert.equal(updated.body.view.config.filters.period, 'this_month');

    const second = await admin.request('POST', '/admin/analytics/views', { name: 'Second', config: {} });
    assert.equal((await admin.request('PUT', `/admin/analytics/views/${second.body.view.id}`, { name: 'Monthly look', config: {} })).status, 409);

    assert.equal((await admin.request('DELETE', `/admin/analytics/views/${view.id}`)).status, 200);
    assert.equal((await admin.request('GET', `/admin/analytics/views/${view.id}`)).status, 404);
    assert.deepEqual((await admin.request('GET', '/admin/analytics/views')).body.views.map((v: any) => v.name), ['Second']);
  });

  test('name is 1 to 100 characters and credential-checked', async () => {
    for (const name of ['', '   ', 'x'.repeat(101), 42]) {
      const r = await admin.request('POST', '/admin/analytics/views', { name, config: {} });
      assert.equal(r.status, 400, String(name));
    }
    assert.equal((await admin.request('POST', '/admin/analytics/views', { name: 'x'.repeat(100), config: {} })).status, 201);
    const secret = await admin.request('POST', '/admin/analytics/views', { name: `key sk-test-${'x'.repeat(30)}`, config: {} });
    assert.equal(secret.status, 400, JSON.stringify(secret.body));
  });

  test('config keeps known keys and values only; no free text survives', async () => {
    const r = await admin.request('POST', '/admin/analytics/views', {
      name: 'Mixed',
      config: {
        note: 'free text here',
        filters: { period: 'last_5w', department: 'Finance team', status: ['active', 'secret', 'closed'], ownership: 'everyone', includeArchived: 'yes', extra: 'x' },
        panels: { order: ['problems', 'leaks', 'problems'], hidden: ['progress', 'free text'] },
        columns: { progress: { order: ['blocked', 'evil'], hidden: ['overdue', 'x'] }, people: { order: ['email'] } },
        charts: { 'progress.onTime': 'table', 'trends.tasks_completed': 'chart', 'progress.names': 'table', 'trends.tasks_authorised': 'pie' },
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = r.body.view.config;
    const stored = (await t.pool.query(`SELECT config FROM analytics_views WHERE id = $1`, [r.body.view.id])).rows[0].config;
    assert.deepEqual(stored, c);
    const text = JSON.stringify(c);
    for (const bad of ['free text', 'Finance team', 'secret', 'everyone', 'leaks', 'evil', 'people', 'email', 'names', 'pie', 'extra', 'note']) {
      assert.ok(!text.includes(bad), `${bad} kept in ${text}`);
    }
    assert.equal(c.filters.period, 'last_12w');
    assert.equal(c.filters.department, null);
    assert.deepEqual(c.filters.status, ['active', 'closed']);
    assert.equal(c.filters.ownership, 'both');
    assert.equal(c.filters.includeArchived, false);
    assert.equal(c.panels.order[0], 'problems');
    assert.equal(new Set(c.panels.order).size, c.panels.order.length);
    assert.deepEqual(c.panels.hidden, ['progress']);
    assert.equal(c.columns.progress.order[0], 'blocked');
    assert.deepEqual(c.columns.progress.hidden, ['overdue']);
    assert.equal(c.charts['progress.onTime'], 'table');
    assert.equal(c.charts['trends.tasks_completed'], 'chart');
    assert.equal(c.charts['trends.tasks_authorised'], 'chart');
  });
});
