import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

describe('my profile and department', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let adminId: string;
  let samId: string;
  let sam: Client;
  let admin: Client;
  let registry: string;

  beforeEach(async () => {
    t = await startTestApp(); // 9 November 2026, 10:00 in UTC+8
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    samId = await seedUser(t.pool, 'sam@example.org');
    registry = await seedDepartment(t.pool, 'Registry');
    admin = await t.signIn('admin@example.org');
    sam = await t.signIn('sam@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const profile = async (c: Client = sam) => {
    const r = await c.request('GET', '/me/profile');
    assert.equal(r.status, 200);
    return r.body;
  };
  const audits = async () =>
    (
      await t.pool.query(
        `SELECT actor_user_id AS actor, subject_type AS type, subject_id AS subject, detail FROM audit_events
          WHERE action = 'person.department_changed' ORDER BY occurred_at, id`,
      )
    ).rows;

  test('shows the name, email and no department or roles at first; needs a sign-in', async () => {
    assert.deepEqual(await profile(), { name: 'sam', email: 'sam@example.org', department: null, roles: [], pastRoles: [] });
    assert.equal((await t.anonymous('GET', '/me/profile')).status, 401);
  });

  test('a role is current through its expiry day and past from the next, by the UTC+8 day', async () => {
    const id = await seedProject(t.pool, { name: 'Alpha', members: [{ userId: samId, role: 'member', expiresOn: '2026-11-09' }] });
    const now = { projectId: id, projectName: 'Alpha', role: 'member', since: '2026-11-01', until: '2026-11-09', canOpen: true };
    assert.deepEqual((await profile()).roles, [now]);
    const until = async (at: number) => t.clock.advanceSeconds((at - t.clock.now().getTime()) / 1000);
    await until(Date.UTC(2026, 10, 9, 15, 58, 0)); // 23:58 in UTC+8; signing in takes the clock to 23:59
    const before = await (await t.signIn('sam@example.org')).request('GET', '/me/profile');
    assert.deepEqual([before.body.roles, before.body.pastRoles], [[now], []]);
    await until(Date.UTC(2026, 10, 9, 16, 0, 0)); // the next day in UTC+8
    const after = await profile(await t.signIn('sam@example.org'));
    assert.deepEqual(after.roles, []);
    assert.deepEqual(after.pastRoles, [{ projectId: id, projectName: 'Alpha', role: 'member', since: '2026-11-01', endedOn: '2026-11-09' }]);
  });

  test('a revoked role is past, ended on the UTC+8 day it was revoked or its earlier expiry', async () => {
    const alpha = await seedProject(t.pool, {
      name: 'Alpha',
      members: [
        { userId: samId, role: 'pm' },
        { userId: samId, role: 'member' },
        { userId: samId, role: 'sponsor', expiresOn: '2026-11-04' },
        { userId: adminId, role: 'owner', revoked: true },
      ],
    });
    // 17:30 UTC on the 6th is the 7th in UTC+8; the Sponsor role had already expired on the 4th.
    await t.pool.query(
      `UPDATE memberships SET revoked_at = '2026-11-06T17:30:00Z', revoked_by = $1 WHERE project_id = $2 AND role IN ('member', 'sponsor')`,
      [adminId, alpha],
    );
    const p = await profile();
    assert.deepEqual(p.roles, [{ projectId: alpha, projectName: 'Alpha', role: 'pm', since: '2026-11-01', until: null, canOpen: true }]);
    assert.deepEqual(
      p.pastRoles.map((r: any) => [r.role, r.endedOn]),
      [
        ['member', '2026-11-07'],
        ['sponsor', '2026-11-04'],
      ],
    );
  });

  test('a role that starts later is listed as current with its since date, and its project cannot be opened yet', async () => {
    const id = await seedProject(t.pool, { name: 'Later', members: [{ userId: samId, role: 'member', startsOn: '2026-12-01', expiresOn: '2027-01-31' }] });
    assert.deepEqual((await profile()).roles, [{ projectId: id, projectName: 'Later', role: 'member', since: '2026-12-01', until: '2027-01-31', canOpen: false }]);
    assert.equal((await sam.request('GET', `/projects/${id}`)).status, 404);
  });

  test('canOpen says exactly what opening the project answers: a hold closes it, a grant or the Administrator role opens it', async () => {
    const held = await seedProject(t.pool, { name: 'Held', members: [{ userId: samId, role: 'member' }, { userId: adminId, role: 'member' }] });
    const granted = await seedProject(t.pool, { name: 'Granted', members: [{ userId: samId, role: 'member', startsOn: '2026-12-01' }] });
    await t.pool.query(`UPDATE memberships SET held_at = '2026-11-08T00:00:00Z', hold_reason = 'Account disabled' WHERE project_id = $1`, [held]);
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'oversight', 'P', 'S', '2026-11-01', '2026-11-30', $4, now(), 'approved', $4, now())`,
      [uuidv7(), granted, samId, adminId],
    );
    for (const c of [sam, admin]) {
      for (const r of (await profile(c)).roles) {
        assert.equal(r.canOpen, (await c.request('GET', `/projects/${r.projectId}`)).status === 200, r.projectName);
      }
    }
    const opens = async (c: Client) => (await profile(c)).roles.map((r: any) => [r.projectName, r.canOpen]);
    assert.deepEqual(await opens(sam), [['Granted', true], ['Held', false]]);
    assert.deepEqual(await opens(admin), [['Held', true]]);
  });

  test('a person chooses a department or none; only a real change is audited, by ids', async () => {
    const other = await seedDepartment(t.pool, 'Finance');
    const set = await sam.request('PUT', '/me/department', { departmentId: registry });
    assert.deepEqual([set.status, set.body], [200, { department: { id: registry, name: 'Registry', retired: false } }]);
    assert.deepEqual((await profile()).department, { id: registry, name: 'Registry', retired: false });
    assert.equal((await sam.request('PUT', '/me/department', { departmentId: registry })).status, 200);
    t.clock.advanceSeconds(1);
    assert.equal((await sam.request('PUT', '/me/department', { departmentId: other })).status, 200);
    t.clock.advanceSeconds(1);
    assert.deepEqual((await sam.request('PUT', '/me/department', { departmentId: null })).body, { department: null });
    assert.equal((await profile()).department, null);
    const row = (from: string | null, to: string | null) => ({ actor: samId, type: 'user', subject: samId, detail: { fromDepartmentId: from, toDepartmentId: to } });
    assert.deepEqual(await audits(), [row(null, registry), row(registry, other), row(other, null)]);
  });

  test('a retired or unknown department is refused, but a retired one already held still shows', async () => {
    await sam.request('PUT', '/me/department', { departmentId: registry });
    await t.pool.query(`UPDATE departments SET status = 'retired' WHERE id = $1`, [registry]);
    assert.deepEqual((await profile()).department, { id: registry, name: 'Registry', retired: true });
    for (const departmentId of [registry, uuidv7(), 'nonsense', 7, '', undefined]) {
      assert.equal((await sam.request('PUT', '/me/department', { departmentId })).status, 400, String(departmentId));
      assert.equal((await admin.request('PUT', `/users/${adminId}/department`, { departmentId })).status, 400, String(departmentId));
    }
    assert.equal((await profile()).department.id, registry, 'nothing changed');
    assert.equal((await audits()).length, 1);
    const people = (await admin.request('GET', '/users')).body.users;
    assert.deepEqual(people.find((u: any) => u.id === samId).department, { id: registry, name: 'Registry', retired: true });
    assert.equal((await sam.request('PUT', '/me/department', { departmentId: null })).status, 200, 'it can be cleared');
  });

  test('only an Enterprise Administrator changes another person, and the People list shows it', async () => {
    assert.equal((await sam.request('PUT', `/users/${adminId}/department`, { departmentId: registry })).status, 403);
    assert.equal((await sam.request('PUT', `/users/${samId}/department`, { departmentId: registry })).status, 403, 'nor themselves by this address');
    assert.equal((await t.anonymous('PUT', `/users/${samId}/department`, { departmentId: registry })).status, 401);
    const set = await admin.request('PUT', `/users/${samId}/department`, { departmentId: registry });
    assert.deepEqual([set.status, set.body], [200, { department: { id: registry, name: 'Registry', retired: false } }]);
    for (const id of [uuidv7(), 'nonsense']) assert.equal((await admin.request('PUT', `/users/${id}/department`, { departmentId: registry })).status, 404);
    const people = (await admin.request('GET', '/users')).body.users;
    assert.deepEqual(
      people.map((u: any) => [u.email, u.department]).sort(),
      [
        ['admin@example.org', null],
        ['sam@example.org', { id: registry, name: 'Registry', retired: false }],
      ],
    );
    assert.deepEqual(await audits(), [{ actor: adminId, type: 'user', subject: samId, detail: { fromDepartmentId: null, toDepartmentId: registry } }]);
    // A disabled person's department can still be put right.
    await admin.request('POST', `/users/${samId}/disable`);
    assert.equal((await admin.request('PUT', `/users/${samId}/department`, { departmentId: null })).status, 200);
  });

  test('a department gives no access: the same projects can be read before and after', async () => {
    const pm = await seedUser(t.pool, 'pm@example.org');
    const owned = await seedProject(t.pool, { name: 'Owned by it', departmentId: registry, members: [{ userId: pm, role: 'pm' }] });
    const contributing = await seedProject(t.pool, { name: 'Contributed to', members: [{ userId: pm, role: 'pm' }] });
    await t.pool.query(`INSERT INTO project_departments (project_id, department_id) VALUES ($1, $2)`, [contributing, registry]);
    const mine = await seedProject(t.pool, { name: 'Mine', members: [{ userId: samId, role: 'member' }] });
    const readable = async () => ({
      listed: (await sam.request('GET', '/projects')).body.projects.map((p: any) => p.id),
      opened: await Promise.all([owned, contributing, mine].map(async (id) => (await sam.request('GET', `/projects/${id}`)).status)),
      roles: (await profile()).roles,
      people: (await sam.request('GET', '/users')).status,
    });
    const before = await readable();
    assert.deepEqual([before.listed, before.opened], [[mine], [404, 404, 200]]);
    assert.equal((await sam.request('PUT', '/me/department', { departmentId: registry })).status, 200);
    assert.deepEqual(await readable(), before);
  });

  test("no one can read another person's profile", async () => {
    assert.equal((await admin.request('GET', `/me/profile?userId=${samId}`)).body.email, 'admin@example.org');
    assert.equal((await sam.request('GET', `/me/profile?userId=${adminId}`)).body.email, 'sam@example.org');
    for (const path of [`/users/${samId}/profile`, `/users/${samId}`, `/me/${samId}/profile`]) {
      for (const c of [admin, sam]) assert.equal((await c.request('GET', path)).status, 404, path);
    }
    // A body naming someone else changes only the person signed in.
    await sam.request('PUT', '/me/department', { departmentId: registry, userId: adminId, id: adminId });
    const set = (await t.pool.query(`SELECT id FROM users WHERE department_id IS NOT NULL`)).rows;
    assert.deepEqual(set, [{ id: samId }]);
  });
});
