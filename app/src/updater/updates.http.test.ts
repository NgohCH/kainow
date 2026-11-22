import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { OperationsState } from '../ops/state';
import { seedUser } from '../testing/projects';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('updates API', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('member@example.org');
    // The release check talks to the test app itself (a 404 there), never to the internet.
    (t.app.get(APP_CONFIG) as AppConfig).release.api = t.base;
  });
  afterEach(async () => {
    await t?.close();
  });

  const now = () => t.clock.now();
  async function ready() {
    const finished = new Date(now().getTime() - HOUR);
    await t.pool.query(
      `INSERT INTO backup_runs (id, kind, started_at, finished_at, outcome, set_name, folder_label, key_id, database_bytes, files_total, files_new, source_area)
       VALUES ($1, 'daily', $2, $3, 'succeeded', 'set-1', 'backup-disk-1', 'key-aa11', 1000, 3, 1, 'not_in_use')`,
      [uuidv7(), new Date(finished.getTime() - 10 * MIN), finished],
    );
    await t.pool.query(`INSERT INTO releases_seen (tag, commit, first_seen_at, notified_at) VALUES ('v1.0.0', $1, $2, $2)`, ['c'.repeat(40), now()]);
  }
  const approveBody = () => ({ tag: 'v1.0.0', startsAt: new Date(now().getTime() + 2 * DAY).toISOString(), expectedMinutes: 30, reason: 'Routine update' });

  test('permissions: a Member gets 403 on every updates route except the banner', async () => {
    await ready();
    const id = uuidv7();
    assert.equal((await member.request('GET', '/admin/updates')).status, 403);
    assert.equal((await member.request('POST', '/admin/updates/check')).status, 403);
    assert.equal((await member.request('POST', '/admin/updates', approveBody())).status, 403);
    assert.equal((await member.request('POST', `/admin/updates/${id}/reschedule`, { startsAt: approveBody().startsAt, reason: 'x' })).status, 403);
    assert.equal((await member.request('POST', `/admin/updates/${id}/cancel`, { reason: 'x' })).status, 403);
    assert.equal((await member.request('GET', '/updates/banner')).status, 200);
    assert.equal((await t.anonymous('GET', '/updates/banner')).status, 401);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM updates`)).rows[0].n, 0);
  });

  test('overview, approve, reschedule and cancel for an Enterprise Administrator', async () => {
    await ready();
    await t.pool.query(`INSERT INTO updater_ticks (id, at, did, running_tag, key_fingerprint) VALUES ($1, $2, 'idle', 'v0.0.0', 'SHA256:abc')`, [uuidv7(), now()]);
    let g = await admin.request('GET', '/admin/updates');
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.running, '0.0.0');
    assert.equal(g.body.keyFingerprint, 'SHA256:abc');
    assert.equal(g.body.available.tag, 'v1.0.0');
    assert.match(g.body.available.releaseUrl, /^https:\/\/github\.com\/.+\/releases\/tag\/v1\.0\.0$/);
    assert.equal(g.body.current, null);
    assert.deepEqual(g.body.history, []);
    assert.equal(g.body.needsRecovery, false);

    const a = await admin.request('POST', '/admin/updates', approveBody());
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.state, 'approved');
    g = await admin.request('GET', '/admin/updates');
    assert.equal(g.body.current.id, a.body.id);
    assert.equal(g.body.history.length, 1);

    const r = await admin.request('POST', `/admin/updates/${a.body.id}/reschedule`, {
      startsAt: new Date(now().getTime() + 3 * DAY).toISOString(),
      expectedMinutes: 60,
      reason: 'Later',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.expectedMinutes, 60);
    const c = await admin.request('POST', `/admin/updates/${a.body.id}/cancel`, { reason: 'Not needed' });
    assert.equal(c.status, 200);
    assert.equal(c.body.state, 'cancelled');
    assert.equal((await admin.request('POST', `/admin/updates/${a.body.id}/cancel`, { reason: 'Again' })).status, 409);
    assert.equal((await admin.request('POST', `/admin/updates/${uuidv7()}/cancel`, { reason: 'None' })).status, 404);
  });

  test('in protective mode (low space) an approved update can still be cancelled, but not approved or moved (M7)', async () => {
    await ready();
    const a = await admin.request('POST', '/admin/updates', approveBody());
    assert.equal(a.status, 201);
    await t.pool.query(`UPDATE operations_state SET protective = true, reason = 'low_space', since = $1 WHERE id`, [now()]);
    t.app.get(OperationsState).invalidate(); // past the state cache
    const moved = await admin.request('POST', `/admin/updates/${a.body.id}/reschedule`, { startsAt: approveBody().startsAt, expectedMinutes: 30, reason: 'Later' });
    assert.equal(moved.status, 503);
    const c = await admin.request('POST', `/admin/updates/${a.body.id}/cancel`, { reason: 'Disk is low' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.state, 'cancelled');
  });

  test('approve without a fresh backup is 409 with the fixed text', async () => {
    await t.pool.query(`INSERT INTO releases_seen (tag, commit, first_seen_at, notified_at) VALUES ('v1.0.0', $1, $2, $2)`, ['c'.repeat(40), now()]);
    const r = await admin.request('POST', '/admin/updates', approveBody());
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'Updates are refused until a backup succeeds. See Backups above.');
  });

  test('check now twice within a minute is 429', async () => {
    const first = await admin.request('POST', '/admin/updates/check');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.result.outcome, 'failed');
    const second = await admin.request('POST', '/admin/updates/check');
    assert.equal(second.status, 429);
    assert.equal(second.body.code, 'check_too_soon');
    t.clock.advanceSeconds(61);
    assert.equal((await admin.request('POST', '/admin/updates/check')).status, 200);
  });

  test('updates/banner shows the scheduled update to a Member', async () => {
    await ready();
    assert.deepEqual((await member.request('GET', '/updates/banner')).body, { scheduled: null });
    const a = await admin.request('POST', '/admin/updates', approveBody());
    assert.equal(a.status, 201);
    const b = await member.request('GET', '/updates/banner');
    assert.equal(b.status, 200);
    assert.equal(b.body.scheduled.startsAt, a.body.startsAt);
    assert.equal(b.body.scheduled.expectedMinutes, 30);
    assert.match(b.body.scheduled.text, /^Kainow will be unavailable on [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} from \d\d:\d\d for about 30 minutes for an update\.$/);
    const ob = await member.request('GET', '/operations/banner');
    assert.equal(ob.body.scheduled.text, b.body.scheduled.text);
  });
});
