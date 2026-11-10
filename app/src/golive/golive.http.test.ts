import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { Sweep } from '../notifications/sweep';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { pngHeader } from '../testing/images';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

const step = (body: any, key: string) => body.steps.find((s: any) => s.key === key);
const events = async (t: TestApp) => (await t.pool.query(`SELECT step_key, action, actor_id, note FROM golive_events ORDER BY at, id`)).rows;

describe('go-live checklist', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let adminId: string;

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const get = async () => (await admin.request('GET', '/go-live')).body;
  const queueTestEmail = async (status: string) => {
    await t.pool.query(
      `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, status, created_at)
       VALUES ($1, 'admin@example.org', 'Test', 'Test', 'test', 'person', $2, now())`,
      [uuidv7(), status],
    );
  };

  test('everyone but an Active Enterprise Administrator gets 404 on every route', async () => {
    await seedUser(t.pool, 'member@example.org');
    const member = await t.signIn('member@example.org');
    const routes: [string, string][] = [['GET', '/go-live'], ['GET', '/go-live/summary'], ['POST', '/go-live/steps/recovery/tick'], ['POST', '/go-live/steps/recovery/untick'], ['POST', '/go-live/steps/logos/skip']];
    for (const [method, path] of routes) {
      assert.equal((await member.request(method, path, method === 'POST' ? {} : undefined)).status, 404, `${method} ${path}`);
    }
    assert.equal((await admin.request('GET', '/go-live/summary')).status, 200);
    assert.equal((await t.anonymous('GET', '/go-live')).status, 401);
  });

  test('the page lists the 11 steps in order with text, explanation and link', async () => {
    const body = await get();
    assert.deepEqual(body.steps.map((s: any) => s.key), ['organisation', 'logos', 'second_admin', 'recovery', 'mailbox', 'test_email', 'calendar', 'backups', 'department', 'users', 'project']);
    assert.deepEqual(body.steps.map((s: any) => s.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(step(body, 'organisation').text, 'Register your organisation: its name and email domains');
    assert.equal(step(body, 'organisation').link, '#/organisation');
    assert.ok(body.steps.every((s: any) => s.explanation.length > 0 && s.explanation.length <= 160));
    assert.deepEqual(body.steps.map((s: any) => s.mode), ['auto', 'auto_or_skip', 'auto', 'confirm', 'confirm', 'confirm', 'confirm', 'confirm', 'auto', 'auto', 'auto']);
    assert.deepEqual([body.closedAt, body.notDoneAtClose], [null, []]);
  });

  test('the organisation step ticks itself once the organisation is registered', async () => {
    await t.close();
    t = await startTestApp(undefined, { organisation: false });
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    admin = await t.signIn('admin@example.org');
    assert.equal((await admin.request('GET', '/go-live')).status, 409, 'closed until setup is finished');
    await admin.request('POST', '/organisation/name', { name: 'Example Organisation' });
    await admin.request('POST', '/domains', { domain: 'example.org' });
    await admin.request('POST', '/departments', { name: 'Operations' });
    assert.equal((await admin.request('POST', '/organisation/finish', {})).status, 200);
    const body = await get();
    assert.deepEqual([step(body, 'organisation').done, step(body, 'organisation').tickedBy], [true, 'kainow']);
    assert.equal((await get()).steps.filter((s: any) => s.key === 'organisation').length, 1);
    assert.deepEqual((await events(t)).filter((e) => e.step_key === 'organisation'), [{ step_key: 'organisation', action: 'ticked', actor_id: null, note: null }], 'ticked once, by Kainow');
  });

  test('second administrator, department and logo tick themselves', async () => {
    let body = await get();
    assert.deepEqual(['second_admin', 'department', 'logos'].map((k) => step(body, k).done), [false, false, false]);
    await seedUser(t.pool, 'second@example.org', 'enterprise_administrator');
    await seedDepartment(t.pool);
    assert.equal((await admin.upload('PUT', '/organisation/logos/square', pngHeader(64, 64), 'image/png')).status, 200);
    body = await get();
    for (const k of ['second_admin', 'department', 'logos']) assert.deepEqual([k, step(body, k).done, step(body, k).tickedBy], [k, true, 'kainow']);
    assert.equal(body.steps.filter((s: any) => s.done).length, 4, 'with the organisation');
    assert.deepEqual((await admin.request('GET', '/go-live/summary')).body, { open: true, done: 4, total: 11 });
  });

  test('a disabled second Administrator does not count', async () => {
    const id = await seedUser(t.pool, 'second@example.org', 'enterprise_administrator');
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [id]);
    assert.equal(step(await get(), 'second_admin').done, false);
  });

  test('an Administrator who is also a project Member does not make "users" true', async () => {
    await seedProject(t.pool, { status: 'draft', members: [{ userId: adminId, role: 'pm' }] });
    assert.equal(step(await get(), 'users').done, false);
    const member = await seedUser(t.pool, 'member@example.org');
    await t.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [member]);
    assert.equal(step(await get(), 'users').done, false, 'a disabled account does not count');
    await t.pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [member]);
    assert.equal(step(await get(), 'users').done, true);
  });

  test('a test email that is queued or failed does not enable the test-email step; a sent one does', async () => {
    assert.equal(step(await get(), 'test_email').canTick, false);
    await queueTestEmail('queued');
    await queueTestEmail('failed');
    assert.equal(step(await get(), 'test_email').canTick, false);
    const refused = await admin.request('POST', '/go-live/steps/test_email/tick', {});
    assert.deepEqual([refused.status, refused.body.message], [409, 'Send a test email first, then check it arrived.']);
    await queueTestEmail('sent');
    assert.equal(step(await get(), 'test_email').canTick, true);
    const ok = await admin.request('POST', '/go-live/steps/test_email/tick', {});
    assert.equal(ok.status, 200);
    assert.equal(step(ok.body, 'test_email').done, true);
  });

  test('a project that was Active and then Deferred still counts', async () => {
    const id = await seedProject(t.pool, { status: 'deferred', members: [{ userId: adminId, role: 'pm' }] });
    assert.equal(step(await get(), 'project').done, false);
    await t.pool.query(
      `INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, 'planned', 'active', $3, now())`,
      [uuidv7(), id, adminId],
    );
    assert.equal(step(await get(), 'project').done, true);
  });

  test('a project still in draft or planned does not count', async () => {
    await seedProject(t.pool, { status: 'planned', members: [{ userId: adminId, role: 'pm' }] });
    assert.equal(step(await get(), 'project').done, false);
  });

  test('tick, note, untick and skip are recorded, and a note is limited to 200 characters', async () => {
    const ticked = await admin.request('POST', '/go-live/steps/backups/tick', { note: 'Restore tested on 3 Dec' });
    assert.equal(ticked.status, 200);
    const b = step(ticked.body, 'backups');
    assert.deepEqual([b.done, b.tickedBy, b.note], [true, { id: adminId, name: 'admin' }, 'Restore tested on 3 Dec']);
    assert.equal((await admin.request('POST', '/go-live/steps/recovery/tick', { note: 'x'.repeat(201) })).status, 400);
    const un = await admin.request('POST', '/go-live/steps/backups/untick');
    assert.deepEqual([step(un.body, 'backups').done, step(un.body, 'backups').note], [false, null]);
    const skipped = await admin.request('POST', '/go-live/steps/logos/skip', { note: 'Later' });
    assert.deepEqual([step(skipped.body, 'logos').done, step(skipped.body, 'logos').skipped, step(skipped.body, 'logos').tickedBy.id], [true, true, adminId]);
    assert.equal(step((await admin.request('POST', '/go-live/steps/logos/untick')).body, 'logos').skipped, false);
    assert.equal((await admin.request('POST', '/go-live/steps/nonsense/tick', {})).status, 404);
    const rows = (await events(t)).filter((e) => e.actor_id === adminId);
    assert.deepEqual(rows.map((r) => [r.step_key, r.action, r.note]), [
      ['backups', 'ticked', 'Restore tested on 3 Dec'], ['backups', 'unticked', null], ['logos', 'ticked', 'Skipped. Later'], ['logos', 'unticked', null],
    ]);
  });

  test('an automatic logo tick cannot be skipped or unticked; a skip can be undone', async () => {
    assert.equal((await admin.upload('PUT', '/organisation/logos/square', pngHeader(64, 64), 'image/png')).status, 200);
    assert.equal(step(await get(), 'logos').canUntick, false);
    for (const path of ['/go-live/steps/logos/skip', '/go-live/steps/logos/untick']) {
      const r = await admin.request('POST', path, {});
      assert.deepEqual([r.status, r.body.message], [409, 'Kainow ticks this step itself.'], path);
    }
    assert.equal(step(await get(), 'logos').tickedBy, 'kainow');
    await t.pool.query(`DELETE FROM organisation_logos`);
    await t.pool.query(`UPDATE golive_steps SET ticked_by = NULL, ticked_at = NULL WHERE key = 'logos'`);
    const skipped = await admin.request('POST', '/go-live/steps/logos/skip', {});
    assert.deepEqual([step(skipped.body, 'logos').canUntick, step(skipped.body, 'logos').canTick], [true, false]);
    assert.equal(step((await admin.request('POST', '/go-live/steps/logos/untick')).body, 'logos').done, false);
  });

  test('the logos and calendar texts use straight apostrophes', async () => {
    const body = await get();
    assert.equal(step(body, 'logos').text, "Upload your organisation's logos (optional)");
    assert.equal(step(body, 'calendar').text, "Set the working weekdays and this year's holidays");
  });

  test('a done step cannot be ticked again and a step that is not done cannot be unticked', async () => {
    const first = await admin.request('POST', '/go-live/steps/recovery/tick', { note: 'First' });
    assert.equal(first.status, 200);
    assert.deepEqual([step(first.body, 'recovery').canTick, step(first.body, 'recovery').canUntick], [false, true], 'a done Confirm step');
    const before = (await t.pool.query(`SELECT ticked_by, ticked_at, note FROM golive_steps WHERE key = 'recovery'`)).rows[0];
    const again = await admin.request('POST', '/go-live/steps/recovery/tick', { note: 'Second' });
    assert.deepEqual([again.status, again.body.message], [409, 'This step is already done.']);
    assert.deepEqual((await t.pool.query(`SELECT ticked_by, ticked_at, note FROM golive_steps WHERE key = 'recovery'`)).rows[0], before, 'who and when kept');
    const notDone = await admin.request('POST', '/go-live/steps/calendar/untick');
    assert.deepEqual([notDone.status, notDone.body.message], [409, 'This step is not done.']);
    assert.deepEqual([step(await get(), 'calendar').canTick, step(await get(), 'calendar').canUntick], [true, false], 'a Confirm step not done');
    await admin.request('POST', '/go-live/steps/logos/skip', {});
    const skipAgain = await admin.request('POST', '/go-live/steps/logos/skip', {});
    assert.deepEqual([skipAgain.status, skipAgain.body.message], [409, 'This step is already done.']);
    assert.deepEqual((await events(t)).filter((e) => e.actor_id === adminId).map((e) => [e.step_key, e.action]), [['recovery', 'ticked'], ['logos', 'ticked']], 'no history for refused changes');
  });

  test('a skipped logos step becomes a Kainow tick once a logo is uploaded', async () => {
    await admin.request('POST', '/go-live/steps/logos/skip', { note: 'Later' });
    assert.equal(step(await get(), 'logos').skipped, true);
    assert.equal((await admin.upload('PUT', '/organisation/logos/square', pngHeader(64, 64), 'image/png')).status, 200);
    const logos = step(await get(), 'logos');
    assert.deepEqual([logos.done, logos.skipped, logos.tickedBy, logos.canUntick, logos.note], [true, false, 'kainow', false, null]);
    assert.deepEqual((await events(t)).filter((e) => e.step_key === 'logos').map((e) => [e.action, e.actor_id]), [['ticked', adminId], ['ticked', null]]);
  });

  test('the recovery and mailbox steps point to INSTALL.md sections; the organisation text uses a straight apostrophe', async () => {
    const body = await get();
    assert.equal(step(body, 'recovery').text, 'Nominate the recovery custodian and test the recovery procedure');
    assert.equal(step(body, 'recovery').explanation, "Agree who the recovery custodian is and record how to reach them. Kainow's recovery procedure is still being written; check it is in place before go-live.");
    assert.equal(step(body, 'recovery').link, 'INSTALL.md, the section on Recovery custodian');
    assert.equal(step(body, 'mailbox').link, 'INSTALL.md, the section on Microsoft 365 email');
    assert.ok(!body.steps.some((s: any) => /[‘’]/.test(s.text + s.explanation)), 'no curly apostrophes');
    assert.equal(step(body, 'organisation').explanation, "Kainow needs the organisation's name and email domains before anyone can be invited.");
  });

  test('after closing, no step can be ticked or unticked, Confirm steps included', async () => {
    await admin.request('POST', '/go-live/steps/recovery/tick', {});
    await reachClose();
    const body = await get();
    assert.ok(body.closedAt);
    assert.deepEqual([step(body, 'recovery').canUntick, step(body, 'recovery').canTick, step(body, 'calendar').canTick], [false, false, false]);
  });

  test('Kainow-ticked steps cannot be ticked or unticked by a person', async () => {
    for (const key of ['organisation', 'department']) {
      const r = await admin.request('POST', `/go-live/steps/${key}/tick`, {});
      assert.deepEqual([r.status, r.body.message], [409, 'Kainow ticks this step itself.']);
      assert.equal((await admin.request('POST', `/go-live/steps/${key}/untick`)).status, 409);
    }
    assert.equal((await admin.request('POST', '/go-live/steps/logos/tick', {})).status, 409);
    assert.equal(step(await get(), 'organisation').done, true, 'still ticked');
  });

  const reachClose = async () => {
    await seedUser(t.pool, 'member@example.org');
    await seedProject(t.pool, { status: 'active', members: [{ userId: adminId, role: 'pm' }] });
  };

  test('the checklist closes when department, users and project are done, and lists what is open', async () => {
    await admin.request('POST', '/go-live/steps/recovery/tick', { note: 'Done' });
    await reachClose();
    const body = await get();
    assert.ok(body.closedAt);
    assert.deepEqual(body.notDoneAtClose, ['logos', 'second_admin', 'mailbox', 'test_email', 'calendar', 'backups']);
    assert.equal((await admin.request('GET', '/go-live/summary')).body.open, false);
    const closes = (await events(t)).filter((e) => e.action === 'closed');
    assert.deepEqual(closes, [{ step_key: null, action: 'closed', actor_id: null, note: null }]);
    const again = await get();
    assert.equal(again.closedAt, body.closedAt, 'closed once');
    assert.equal((await events(t)).filter((e) => e.action === 'closed').length, 1);
  });

  test('after closing, tick, untick and skip are refused', async () => {
    await reachClose();
    await get();
    for (const path of ['/go-live/steps/recovery/tick', '/go-live/steps/recovery/untick', '/go-live/steps/logos/skip']) {
      const r = await admin.request('POST', path, {});
      assert.deepEqual([r.status, r.body.message], [409, 'The go-live checklist is closed.'], path);
    }
  });

  test('a sweep run also ticks and closes', async () => {
    await reachClose();
    const warnings: string[] = [];
    const sweep = new Sweep({ pool: t.pool, clock: t.clock.now, appUrl: 'https://kainow.example.org', nudge: { nudge: async () => undefined }, log: { warn: (m: string) => { warnings.push(m); } } });
    await sweep.run();
    assert.deepEqual(warnings, []);
    const closed = (await t.pool.query(`SELECT closed_at FROM golive_checklist`)).rows[0].closed_at;
    assert.ok(closed);
    const ticked = (await t.pool.query(`SELECT key FROM golive_steps WHERE ticked_at IS NOT NULL AND ticked_by IS NULL ORDER BY position`)).rows.map((r) => r.key);
    assert.deepEqual(ticked, ['organisation', 'department', 'users', 'project']);
  });

  test('refreshing at the same moment from several places ticks each step once', async () => {
    await reachClose();
    await Promise.all([get(), get(), get()]);
    const rows = (await events(t)).filter((e) => e.action === 'ticked');
    assert.equal(rows.length, new Set(rows.map((r) => r.step_key)).size);
  });
});
