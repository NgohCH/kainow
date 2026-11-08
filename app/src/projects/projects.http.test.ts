import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

describe('projects', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let sam: Client;
  let lee: Client;
  let dept: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'sam@example.org');
    await seedUser(t.pool, 'lee@example.org');
    admin = await t.signIn('admin@example.org');
    sam = await t.signIn('sam@example.org');
    lee = await t.signIn('lee@example.org');
    dept = await seedDepartment(t.pool, 'Registry');
  });
  afterEach(async () => {
    await t?.close();
  });

  const body = (over: object = {}) => ({ name: 'EMS rollout', purpose: 'Roll out EMS', owningDepartmentId: dept, ...over });

  test('an administrator creates the first project and does not become its Project Manager', async () => {
    const refused = await sam.request('POST', '/projects', body());
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, 'An Enterprise Administrator creates the first project.');
    const made = await admin.request('POST', '/projects', body());
    assert.equal(made.status, 201);
    assert.equal(made.body.project.status, 'draft');
    assert.equal(made.body.project.stage.stage, 'Initiation');
    assert.deepEqual(made.body.project.memberships, []);
  });

  test('after the first project anyone signed in may create one and becomes its Project Manager', async () => {
    await admin.request('POST', '/projects', body());
    const made = await sam.request('POST', '/projects', body({ name: 'Student app' }));
    assert.equal(made.status, 201);
    assert.deepEqual(
      made.body.project.memberships.map((m: { userId: string; role: string; state: string; startsOn: string }) => [m.userId, m.role, m.state, m.startsOn]),
      [[sam.userId, 'pm', 'active', '2026-11-09']],
    );
    assert.deepEqual(made.body.project.myRoles, ['pm']);
  });

  test('a project needs a name, a purpose and an active owning department', async () => {
    const cases: Array<[object, string]> = [
      [{ name: ' ' }, 'Give the project a name.'],
      [{ purpose: '' }, "Describe the project's purpose."],
      [{ owningDepartmentId: 'not-a-department' }, 'Choose an active owning department.'],
      [{ plannedEnd: '31/12/2026' }, 'The planned end must be a date in the form YYYY-MM-DD.'],
      [{ contributingDepartmentIds: [dept] }, 'A contributing department cannot also be the owning department.'],
    ];
    for (const [over, message] of cases) {
      const r = await admin.request('POST', '/projects', body(over));
      assert.equal(r.status, 400, message);
      assert.equal(r.body.message, message);
    }
    await t.pool.query(`UPDATE departments SET status = 'retired' WHERE id = $1`, [dept]);
    assert.equal((await admin.request('POST', '/projects', body())).body.message, 'Choose an active owning department.');
  });

  test('people see only the projects they are active in; an administrator sees every project without content', async () => {
    const mine = await seedProject(t.pool, { name: 'Mine', members: [{ userId: sam.userId, role: 'pm' }] });
    await seedProject(t.pool, { name: 'Old', members: [{ userId: sam.userId, role: 'member', revoked: true }, { userId: lee.userId, role: 'pm' }] });
    await seedProject(t.pool, { name: 'Later', members: [{ userId: sam.userId, role: 'member', startsOn: '2026-12-01' }, { userId: lee.userId, role: 'pm' }] });

    const list = await sam.request('GET', '/projects');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.projects.map((p: { id: string }) => p.id), [mine]);
    assert.equal(list.body.all, undefined);

    const adminList = await admin.request('GET', '/projects');
    assert.deepEqual(adminList.body.projects, [], 'the administrator holds no role');
    assert.equal(adminList.body.all.length, 3);
    assert.deepEqual(Object.keys(adminList.body.all[0]).sort(), ['id', 'name', 'owningDepartment', 'roleHolders', 'status']);
  });

  test('a non-participant gets not found; the administrator may read the details to manage appointments', async () => {
    const id = await seedProject(t.pool, { members: [{ userId: sam.userId, role: 'pm' }] });
    const outsider = await lee.request('GET', `/projects/${id}`);
    assert.equal(outsider.status, 404);
    assert.equal(outsider.body.message, 'Project not found');
    assert.equal((await sam.request('GET', `/projects/${id}`)).status, 200);
    const asAdmin = await admin.request('GET', `/projects/${id}`);
    assert.equal(asAdmin.status, 200);
    assert.deepEqual(asAdmin.body.project.myRoles, []);
    assert.equal(asAdmin.body.project.isAdmin, true);
    assert.equal((await sam.request('GET', '/projects/00000000-0000-7000-8000-000000000000')).status, 404);
  });

  test('the Project Manager may edit the details; a Member may not', async () => {
    const id = await seedProject(t.pool, { members: [{ userId: sam.userId, role: 'pm' }, { userId: lee.userId, role: 'member' }] });
    const edited = await sam.request('POST', `/projects/${id}/edit`, { name: 'Renamed', purpose: 'New purpose', plannedEnd: '2027-06-30' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.project.name, 'Renamed');
    assert.equal(edited.body.project.plannedEnd, '2027-06-30');
    const refused = await lee.request('POST', `/projects/${id}/edit`, { name: 'No' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, "Only the Project Manager, Owner or a Sponsor can change the project's details, and not while it is Deferred or Closed.");
  });
});
