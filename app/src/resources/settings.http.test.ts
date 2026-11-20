import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedUser } from '../testing/projects';
import { isCatalogueMaintainer, loadResourceSettings } from './settings.service';

const SETTINGS = '/admin/resources/settings';
const MAINTAINERS = '/admin/resources/maintainers';

describe('resource and finance settings, catalogue maintainers (D94)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let adminId: string;
  let member: Client;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'plain@example.org');
    for (const p of ['ann', 'bob']) ids[p] = await seedUser(t.pool, `${p}@example.com`);
    ids.off = await seedUser(t.pool, 'off@example.com');
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ids.off]);
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('plain@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const put = (b: Record<string, unknown>, reason: unknown = 'Policy review') => admin.request('PUT', SETTINGS, { ...b, reason });

  test('non-EA gets 403, anonymous 401', async () => {
    assert.equal((await member.request('GET', SETTINGS)).status, 403);
    assert.equal((await member.request('PUT', SETTINGS, { warnFirstPct: 70, reason: 'x' })).status, 403);
    assert.equal((await member.request('GET', MAINTAINERS)).status, 403);
    assert.equal((await member.request('POST', MAINTAINERS, { userId: ids.ann, reason: 'x' })).status, 403);
    assert.equal((await t.anonymous('GET', SETTINGS)).status, 401);
  });

  test('get shows the defaults and an empty history', async () => {
    const r = await admin.request('GET', SETTINGS);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.settings, {
      projectsMayManageFinance: true, defaultCurrency: 'MYR', enabledCurrencies: ['MYR', 'SGD', 'USD'], warnFirstPct: 80, warnSecondPct: 100,
    });
    assert.deepEqual(r.body.changes, []);
  });

  test('a reason is required', async () => {
    for (const reason of [null, '', '   ']) assert.equal((await put({ warnFirstPct: 70 }, reason)).status, 400);
    assert.equal((await loadResourceSettings(t.pool)).warnFirstPct, 80);
  });

  test('thresholds 90/90 is refused naming the thresholds; out of range too', async () => {
    const r = await put({ warnFirstPct: 90, warnSecondPct: 90 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Warning thresholds/);
    assert.equal((await put({ warnFirstPct: 0 })).status, 400);
    assert.equal((await put({ warnSecondPct: 201 })).status, 400);
    assert.equal((await put({ warnFirstPct: 50.5 })).status, 400);
  });

  test('currency rules', async () => {
    const a = await put({ enabledCurrencies: ['MYR'], defaultCurrency: 'USD' });
    assert.equal(a.status, 400);
    assert.match(a.body.message, /default currency must be enabled/);
    assert.match((await put({ enabledCurrencies: [] })).body.message, /at least one currency/);
    assert.equal((await put({ enabledCurrencies: ['MYR', 'EUR'] })).status, 400);
    assert.equal((await put({ defaultCurrency: 'EUR' })).status, 400);
    assert.equal((await put({ projectsMayManageFinance: 'yes' })).status, 400);
  });

  test('a change writes the row, a history row with previous and next, and an audit event', async () => {
    const r = await put({ enabledCurrencies: ['SGD', 'MYR'], defaultCurrency: 'SGD', warnFirstPct: 70, projectsMayManageFinance: false }, 'Move to Singapore');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.settings, {
      projectsMayManageFinance: false, defaultCurrency: 'SGD', enabledCurrencies: ['MYR', 'SGD'], warnFirstPct: 70, warnSecondPct: 100,
    });
    assert.equal(r.body.changes.length, 1);
    const c = r.body.changes[0];
    assert.equal(c.reason, 'Move to Singapore');
    assert.equal(c.actor, 'admin');
    assert.equal(c.previous.defaultCurrency, 'MYR');
    assert.equal(c.previous.warnFirstPct, 80);
    assert.equal(c.next.defaultCurrency, 'SGD');
    assert.equal(c.next.warnFirstPct, 70);
    const { rows } = await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'resources.settings_changed'`);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].detail.fields.sort(), ['defaultCurrency', 'enabledCurrencies', 'projectsMayManageFinance', 'warnFirstPct']);
    t.clock.advanceSeconds(60);
    const second = await put({ warnSecondPct: 120 }, 'Later');
    assert.equal(second.body.changes.length, 2);
    assert.equal(second.body.changes[0].reason, 'Later');
  });

  test('an unchanged save is refused with Nothing to change and writes no history or audit', async () => {
    const current = (await admin.request('GET', SETTINGS)).body.settings;
    for (const body of [{}, current, { warnFirstPct: current.warnFirstPct }, { enabledCurrencies: [...current.enabledCurrencies].reverse() }]) {
      const r = await put(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.message, 'Nothing to change.');
    }
    assert.equal((await t.pool.query(`SELECT 1 FROM resource_settings_changes`)).rowCount, 0);
    assert.equal((await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'resources.settings_changed'`)).rowCount, 0);
  });

  test('a refused change writes nothing', async () => {
    await put({ warnFirstPct: 90, warnSecondPct: 90 });
    assert.equal((await t.pool.query(`SELECT 1 FROM resource_settings_changes`)).rowCount, 0);
    assert.equal((await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'resources.settings_changed'`)).rowCount, 0);
  });

  test('maintainers: add, list in added order, remove, with events', async () => {
    assert.equal((await admin.request('POST', MAINTAINERS, { userId: ids.bob, reason: 'Runs the store' })).status, 201);
    t.clock.advanceSeconds(60);
    assert.equal((await admin.request('POST', MAINTAINERS, { userId: ids.ann, reason: 'Backup' })).status, 201);
    const list = await admin.request('GET', MAINTAINERS);
    assert.deepEqual(list.body.maintainers.map((m: any) => m.email), ['bob@example.com', 'ann@example.com']);
    assert.equal(list.body.maintainers[0].reason, 'Runs the store');
    assert.equal(await isCatalogueMaintainer(t.pool, ids.bob), true);
    assert.equal(await isCatalogueMaintainer(t.pool, adminId), true);
    assert.equal(await isCatalogueMaintainer(t.pool, ids.ann), true);
    assert.equal(await isCatalogueMaintainer(t.pool, ids.off), false);

    t.clock.advanceSeconds(60);
    assert.equal((await admin.request('DELETE', MAINTAINERS, { userId: ids.bob, reason: 'Moved on' })).status, 200);
    assert.equal(await isCatalogueMaintainer(t.pool, ids.bob), false);
    assert.deepEqual((await admin.request('GET', MAINTAINERS)).body.maintainers.map((m: any) => m.email), ['ann@example.com']);
    const { rows } = await t.pool.query(`SELECT kind, subject_kind, subject_id, reason FROM resource_catalogue_events ORDER BY at, id`);
    assert.deepEqual(rows.map((e) => [e.kind, e.subject_kind, e.reason]), [
      ['maintainer_added', 'maintainer', 'Runs the store'],
      ['maintainer_added', 'maintainer', 'Backup'],
      ['maintainer_removed', 'maintainer', 'Moved on'],
    ]);
    assert.equal(rows[2].subject_id, ids.bob);
  });

  test('maintainer refusals', async () => {
    const a = await admin.request('POST', MAINTAINERS, { userId: adminId, reason: 'Why not' });
    assert.equal(a.status, 400);
    assert.equal(a.body.message, 'Administrators can already maintain the catalogue.');
    const d = await admin.request('POST', MAINTAINERS, { userId: ids.off, reason: 'Why not' });
    assert.equal(d.status, 400);
    assert.equal(d.body.message, 'Only an active user can maintain the catalogue.');
    assert.equal((await admin.request('POST', MAINTAINERS, { userId: ids.ann })).status, 400);
    assert.equal((await admin.request('POST', MAINTAINERS, { userId: 'nope', reason: 'x' })).status, 400);
    assert.equal((await admin.request('POST', MAINTAINERS, { userId: '018f0000-0000-7000-8000-000000000000', reason: 'x' })).status, 404);
    await admin.request('POST', MAINTAINERS, { userId: ids.ann, reason: 'Once' });
    assert.equal((await admin.request('POST', MAINTAINERS, { userId: ids.ann, reason: 'Twice' })).status, 409);
    assert.equal((await admin.request('DELETE', MAINTAINERS, { userId: ids.bob, reason: 'Not listed' })).status, 404);
    assert.equal((await admin.request('DELETE', MAINTAINERS, { userId: ids.ann })).status, 400);
    assert.equal((await t.pool.query(`SELECT 1 FROM resource_catalogue_events`)).rowCount, 1);
  });
});
