import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

describe('archive and department transfer', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let owner: Client;
  let member: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'mem']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.mem, role: 'member' }],
    });
    admin = await t.signIn('admin@example.org');
    owner = await t.signIn('owner@example.org');
    member = await t.signIn('mem@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const close = () => owner.request('POST', `/projects/${projectId}/transition`, { to: 'closed', outcome: 'delivered', reason: 'Done' });
  const project = async (c: Client) => (await c.request('GET', `/projects/${projectId}`)).body.project;

  test('only a Closed project can be archived, by its PM, Owner or Sponsor', async () => {
    const early = await owner.request('POST', `/projects/${projectId}/archive`, { reason: 'Tidy up' });
    assert.equal(early.status, 403);
    assert.equal(early.body.message, 'Only the Project Manager, the Owner or a Sponsor can archive a project, and only once it is Closed.');
    assert.equal((await close()).status, 200);
    assert.equal((await member.request('POST', `/projects/${projectId}/archive`, { reason: 'x' })).status, 403);
    assert.equal((await owner.request('POST', `/projects/${projectId}/archive`, {})).body.message, 'A reason is required.');
    assert.equal((await owner.request('POST', `/projects/${projectId}/archive`, { reason: 'Finished' })).status, 200);
    const p = await project(owner);
    assert.deepEqual([p.archived, p.archivedAutomatically], [true, false]);
    assert.equal((await owner.request('POST', `/projects/${projectId}/archive`, { reason: 'again' })).body.message, 'This project is already archived.');
    t.clock.advanceSeconds(60); // ids are not ordered within one instant
    assert.equal((await owner.request('POST', `/projects/${projectId}/unarchive`, { reason: 'Needed for reference' })).status, 200);
    assert.equal((await project(owner)).archived, false);
    assert.equal((await owner.request('POST', `/projects/${projectId}/unarchive`, { reason: 'again' })).body.message, 'This project is not archived.');
    const listed = (await owner.request('GET', '/projects')).body.projects.find((r: { id: string }) => r.id === projectId);
    assert.equal(listed.archived, false);
  });

  test('a Closed project is archived twelve months after closing', async () => {
    await close();
    t.clock.advanceSeconds(364 * 86400);
    let o = await t.signIn('owner@example.org');
    assert.equal((await project(o)).archived, false, '2027-11-08 UTC+8');
    t.clock.advanceSeconds(86400);
    o = await t.signIn('owner@example.org');
    const p = await project(o);
    assert.deepEqual([p.archived, p.archivedAutomatically], [true, true], '2027-11-09 UTC+8');
    assert.equal((await o.request('POST', `/projects/${projectId}/unarchive`, { reason: 'Still in use' })).status, 200);
    t.clock.advanceSeconds(30 * 86400);
    o = await t.signIn('owner@example.org');
    assert.equal((await project(o)).archived, false, 'stays unarchived');
  });

  test('reopening ends archive state', async () => {
    await close();
    await owner.request('POST', `/projects/${projectId}/archive`, { reason: 'Finished' });
    t.clock.advanceSeconds(60);
    assert.equal((await owner.request('POST', `/projects/${projectId}/transition`, { to: 'active', reason: 'More work', stage: 'Execution' })).status, 200);
    assert.equal((await project(owner)).archived, false);
    t.clock.advanceSeconds(60);
    await close();
    assert.equal((await project(owner)).archived, false, 'a fresh closing starts a new count');
  });

  test('the Administrator moves a project to another department with a reason', async () => {
    const finance = await seedDepartment(t.pool, 'Finance');
    const pm = await t.signIn('pm@example.org');
    const refused = await pm.request('POST', `/projects/${projectId}/department`, { departmentId: finance, reason: 'Reorganised' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, 'Only an Enterprise Administrator can move a project to another owning department.');
    assert.equal((await admin.request('POST', `/projects/${projectId}/department`, { departmentId: finance })).body.message, 'A reason is required.');
    assert.equal((await admin.request('POST', `/projects/${projectId}/department`, { departmentId: finance, reason: 'Reorganised' })).status, 200);
    assert.equal((await project(owner)).owningDepartment.name, 'Finance');
    const change = (await t.pool.query(`SELECT files_decision, reason FROM project_department_changes WHERE project_id = $1`, [projectId])).rows;
    assert.deepEqual(change, [{ files_decision: 'kept_in_place', reason: 'Reorganised' }]);
    const same = await admin.request('POST', `/projects/${projectId}/department`, { departmentId: finance, reason: 'x' });
    assert.equal(same.status, 409);
    assert.equal(same.body.message, 'The project already belongs to that department.');
    const helper = await seedDepartment(t.pool, 'Facilities');
    await owner.request('POST', `/projects/${projectId}/edit`, { contributingDepartmentIds: [helper] });
    const contributing = await admin.request('POST', `/projects/${projectId}/department`, { departmentId: helper, reason: 'x' });
    assert.equal(contributing.status, 409);
    assert.equal(contributing.body.message, 'That department contributes to this project; remove it from the contributing departments first.');
  });
});
