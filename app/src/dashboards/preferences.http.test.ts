import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';
import { DEFAULT_PREFS } from './preferences';

describe('preferences endpoints', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let ann: Client;
  let bob: Client;

  beforeEach(async () => {
    t = await startTestApp();
    const adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.com', $2, now())`, [uuidv7(), adminId]);
    await seedUser(t.pool, 'ann@example.com');
    await seedUser(t.pool, 'bob@example.com');
    ann = await t.signIn('ann@example.com');
    bob = await t.signIn('bob@example.com');
  });
  afterEach(async () => {
    await t?.close();
  });

  const auditCount = async (): Promise<number> => Number((await t.pool.query(`SELECT count(*) FROM audit_events`)).rows[0].count);

  test('a new user gets the defaults', async () => {
    const r = await ann.request('GET', '/me/preferences');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, DEFAULT_PREFS);
  });

  test('unknown sections dropped; needsYou cannot be hidden or moved', async () => {
    const put = await ann.request('PUT', '/me/preferences', { theme: 'dark', home: { order: ['myTasks', 'ghost', 'needsYou'], hidden: ['needsYou', 'myProjects'] }, ghost: 1 });
    assert.equal(put.status, 200);
    const get = await ann.request('GET', '/me/preferences');
    assert.deepEqual(get.body, put.body);
    assert.equal(get.body.theme, 'dark');
    assert.deepEqual(get.body.home.order, ['needsYou', 'myTasks', 'myProjects']);
    assert.deepEqual(get.body.home.hidden, ['myProjects']);
  });

  test('bad theme falls back to light', async () => {
    const put = await ann.request('PUT', '/me/preferences', { theme: 'purple' });
    assert.equal(put.body.theme, 'light');
  });

  test('each user reads only their own', async () => {
    await ann.request('PUT', '/me/preferences', { theme: 'dark', accent: 'blue' });
    const b = await bob.request('GET', '/me/preferences');
    assert.equal(b.body.theme, 'light');
    assert.equal(b.body.accent, 'teal');
    await bob.request('PUT', '/me/preferences', { accent: 'slate' });
    assert.equal((await ann.request('GET', '/me/preferences')).body.accent, 'blue');
  });

  test('a second PUT replaces the first, keeps one row and writes no audit row', async () => {
    const before = await auditCount();
    await ann.request('PUT', '/me/preferences', { theme: 'dark' });
    await ann.request('PUT', '/me/preferences', { accent: 'plum' });
    const g = await ann.request('GET', '/me/preferences');
    assert.equal(g.body.theme, 'light');
    assert.equal(g.body.accent, 'plum');
    assert.equal(Number((await t.pool.query(`SELECT count(*) FROM user_preferences`)).rows[0].count), 1);
    assert.equal(await auditCount(), before);
  });
});
