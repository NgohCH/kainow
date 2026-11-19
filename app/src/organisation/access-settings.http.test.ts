import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const URL = '/admin/access-settings';

describe('access and records settings (D90)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let adminId: string;
  let member: Client;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.com', $2, now())`, [uuidv7(), adminId]);
    for (const p of ['owner', 'pm', 'mem', 'x']) ids[p] = await seedUser(t.pool, `${p}@example.com`);
    await seedUser(t.pool, 'plain@example.org');
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('plain@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const put = (b: Record<string, unknown>, reason: unknown = 'Policy review') => admin.request('PUT', URL, { ...b, reason });

  test('non-EA gets 403', async () => {
    assert.equal((await member.request('GET', URL)).status, 403);
    assert.equal((await member.request('POST', `${URL}/preview`, { archiveAfterMonths: 6 })).status, 403);
    assert.equal((await member.request('PUT', URL, { archiveAfterMonths: 6, reason: 'Because' })).status, 403);
    assert.equal((await t.anonymous('GET', URL)).status, 401);
  });

  test('get shows the settings, defaults and bounds', async () => {
    const r = await admin.request('GET', URL);
    assert.equal(r.status, 200);
    const base = { archiveAfterMonths: 12, grantDefaultDays: 30, grantMaxDays: 90, invitationValidDays: 7, analyticsExportAllowed: true };
    assert.deepEqual(r.body.settings, base);
    assert.deepEqual(r.body.defaults, base);
    assert.deepEqual(r.body.bounds.grantMaxDays, { min: 1, max: 365 });
    assert.deepEqual(r.body.changes, []);
  });

  test('reason required', async () => {
    for (const reason of [null, '', '   ', 'x'.repeat(1001)]) {
      const r = await put({ archiveAfterMonths: 6 }, reason);
      assert.equal(r.status, 400, `reason ${JSON.stringify(reason)?.length}`);
    }
    const secret = await put({ archiveAfterMonths: 6 }, `key is sk-${'a1B2c3D4e5'.repeat(3)}`);
    assert.equal(secret.status, 400);
    assert.equal((await put({ archiveAfterMonths: 6 }, 'x'.repeat(1000))).status, 200);
    assert.equal((await admin.request('GET', URL)).body.settings.archiveAfterMonths, 6);
  });

  test('history row has previous and next', async () => {
    const r = await put({ archiveAfterMonths: 24, invitationValidDays: 14 }, '  Longer retention  ');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.settings.archiveAfterMonths, 24);
    const rows = (await t.pool.query(`SELECT actor_id, reason, previous, next FROM access_settings_changes`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, adminId);
    assert.equal(rows[0].reason, 'Longer retention');
    assert.deepEqual(rows[0].previous, { archiveAfterMonths: 12, grantDefaultDays: 30, grantMaxDays: 90, invitationValidDays: 7, analyticsExportAllowed: true });
    assert.deepEqual(rows[0].next, { archiveAfterMonths: 24, grantDefaultDays: 30, grantMaxDays: 90, invitationValidDays: 14, analyticsExportAllowed: true });
    assert.equal(r.body.changes.length, 1);
    assert.equal(r.body.changes[0].reason, 'Longer retention');
    const audit = await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'access_settings.changed'`);
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0].detail.fields, ['archiveAfterMonths', 'invitationValidDays']);
    assert.ok(!JSON.stringify(audit.rows[0].detail).includes('Longer retention'), 'the audit event does not carry the reason');
  });

  test('out-of-range values are a 400 naming the field and range, and nothing is written', async () => {
    const r = await put({ archiveAfterMonths: 61 });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Archive delay must be 1–60 months.');
    assert.equal((await put({ invitationValidDays: 0 })).body.message, 'Invitation validity must be 1–30 days.');
    assert.equal((await put({ analyticsExportAllowed: 'no' })).status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM access_settings_changes`)).rows[0].n, 0);
  });

  test('preview lists only changed projects', async () => {
    // Today is 2026-11-09 (UTC+8). Closing and archive instants are all at 02:00Z, which is 10:00 in UTC+8.
    const closedProject = async (name: string, closedOn: string, unarchivedOn?: string) => {
      const id = await seedProject(t.pool, { status: 'closed', name, members: [{ userId: ids.pm, role: 'pm' }] });
      await t.pool.query(
        `INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, reason, closure_outcome, at) VALUES ($1, $2, 'active', 'closed', $3, 'Done', 'abandoned', $4)`,
        [uuidv7(), id, ids.pm, `${closedOn}T02:00:00Z`],
      );
      if (unarchivedOn) {
        await t.pool.query(
          `INSERT INTO project_archive_events (id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, 'unarchived', $3, 'Needed again', $4)`,
          [uuidv7(), id, ids.pm, `${unarchivedOn}T02:00:00Z`],
        );
      }
      return id;
    };
    const recent = await closedProject('Recent closing', '2026-09-09'); // 2 months ago
    const old = await closedProject('Old closing', '2025-09-09'); // 14 months ago, archived now
    // Unarchived 12.5 months after closing: after the 12-month due date (2026-09-09), before a 13-month one (2026-10-09).
    const reopened = await closedProject('Old but unarchived', '2025-09-09', '2026-09-24');
    // A project that is not Closed never appears.
    await seedProject(t.pool, { status: 'active', name: 'Still running', members: [{ userId: ids.pm, role: 'pm' }] });

    const preview = async (b: object) => {
      const r = await admin.request('POST', `${URL}/preview`, b);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.projects;
    };

    assert.deepEqual(await preview({}), [], 'no change, no rows');
    assert.deepEqual(await preview({ archiveAfterMonths: 12 }), []);
    assert.deepEqual(await preview({ archiveAfterMonths: 1 }), [
      { projectId: recent, name: 'Recent closing', closedOn: '2026-09-09', archivedNow: false, archivedAfter: true },
    ]);
    // 13 months: the third project was unarchived before the new due date (2026-10-09), so it archives again; the old one stays archived.
    assert.deepEqual(await preview({ archiveAfterMonths: 13 }), [
      { projectId: reopened, name: 'Old but unarchived', closedOn: '2025-09-09', archivedNow: false, archivedAfter: true },
    ]);
    // 24 months: the old closing is no longer archived; the unarchived one still is not.
    assert.deepEqual(await preview({ archiveAfterMonths: 24 }), [
      { projectId: old, name: 'Old closing', closedOn: '2025-09-09', archivedNow: true, archivedAfter: false },
    ]);
    assert.equal((await admin.request('POST', `${URL}/preview`, { archiveAfterMonths: 99 })).status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM access_settings_changes`)).rows[0].n, 0, 'a preview writes nothing');

    // The setting in force is read at evaluation time.
    assert.equal((await admin.request('GET', `/projects/${recent}`)).body.project.archived, false);
    await put({ archiveAfterMonths: 1 });
    assert.equal((await admin.request('GET', `/projects/${recent}`)).body.project.archived, true);
  });

  test('new invitation uses new validity; existing keeps its expiry', async () => {
    const pm = await t.signIn('pm@example.com');
    const projectId = await seedProject(t.pool, { members: [{ userId: ids.pm, role: 'pm' }] });
    const invite = (email: string) => pm.request('POST', `/projects/${projectId}/invitations`, { role: 'member', startsOn: '2026-11-09', email });
    const days = async (email: string) => {
      const r = (await t.pool.query(`SELECT issued_at, expires_at FROM invitations WHERE email = $1`, [email])).rows[0];
      return (r.expires_at.getTime() - r.issued_at.getTime()) / 86_400_000;
    };
    assert.equal((await invite('first@example.com')).status, 201);
    assert.equal(await days('first@example.com'), 7);
    assert.equal((await put({ invitationValidDays: 3 })).status, 200);
    t.clock.advanceSeconds(3600);
    assert.equal((await invite('second@example.com')).status, 201);
    assert.equal(await days('second@example.com'), 3);
    assert.equal(await days('first@example.com'), 7, 'the existing invitation keeps its expiry');
    assert.equal((await put({ invitationValidDays: 30 })).status, 200);
    assert.equal((await invite('third@example.com')).status, 201);
    assert.equal(await days('third@example.com'), 30);
  });

  test('default above maximum is a 400; existing grant keeps dates; extension uses new maximum', async () => {
    const projectId = await seedProject(t.pool, {
      status: 'active',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.mem, role: 'member' }],
    });
    const owner = await t.signIn('owner@example.com');
    const request = (over: object = {}) =>
      owner.request('POST', `/projects/${projectId}/grants`, { userId: ids.x, kind: 'audit', purpose: 'Annual audit', scope: 'Everything', startsOn: '2026-11-09', ...over });

    // A 90-day grant under the defaults.
    const made = await request({ expiresOn: '2027-02-07' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const gid = made.body.grant.id;
    assert.equal((await admin.request('POST', `/grants/${gid}/approve`, {})).status, 200);

    // The default may not exceed the maximum: a plain 400 naming the default length, nothing written.
    const bad = await put({ grantDefaultDays: 60, grantMaxDays: 45 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, 'Default grant length (60 days) cannot be longer than the maximum (45 days).');
    // Lowering only the maximum below the stored default is refused the same way, on the merged values.
    assert.equal((await put({ grantMaxDays: 20 })).status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM access_settings_changes`)).rows[0].n, 0);

    // Lower the maximum below the existing grant's length.
    assert.equal((await put({ grantMaxDays: 45 })).status, 200);
    const kept = (await t.pool.query(`SELECT to_char(starts_on, 'YYYY-MM-DD') AS s, to_char(expires_on, 'YYYY-MM-DD') AS e FROM access_grants WHERE id = $1`, [gid])).rows[0];
    assert.deepEqual(kept, { s: '2026-11-09', e: '2027-02-07' }, 'the existing grant keeps its dates');

    // Extension is measured against the new maximum: 2027-02-07 plus 45 days is 2027-03-24.
    const over = await owner.request('POST', `/grants/${gid}/extend`, { expiresOn: '2027-03-25' });
    assert.equal(over.status, 400);
    assert.equal(over.body.message, 'Access can be granted for at most 45 days at a time.');
    assert.equal((await owner.request('POST', `/grants/${gid}/extend`, { expiresOn: '2027-03-24' })).status, 200);

    // A new request is measured the same way, and without an end it takes the new default.
    assert.equal((await request({ startsOn: '2026-11-09', expiresOn: '2026-12-25' })).status, 400);
    assert.equal((await request({ startsOn: '2026-11-09', expiresOn: '2026-12-24' })).status, 201);
    assert.equal((await put({ grantDefaultDays: 10 })).status, 200);
    assert.equal((await request({ startsOn: '2026-11-09' })).body.grant.expiresOn, '2026-11-19');
  });
});
