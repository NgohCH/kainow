import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('Audit and Oversight grants', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let owner: Client;
  let sponsor: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'sponsor', 'mem', 'x']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.mem, role: 'member' },
      ],
    });
    admin = await t.signIn('admin@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const request = (by: Client, over: object = {}) =>
    by.request('POST', `/projects/${projectId}/grants`, { userId: ids.x, kind: 'audit', purpose: 'Annual audit', scope: 'Everything in the project', startsOn: '2026-11-09', ...over });

  test('a manager records a request and a different manager approves it', async () => {
    const rec = await request(owner);
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.equal(rec.body.grant.expiresOn, '2026-12-09');
    assert.equal(rec.body.grant.state, 'requested');
    const gid = rec.body.grant.id;
    const self = await owner.request('POST', `/grants/${gid}/approve`, {});
    assert.equal(self.status, 403);
    assert.equal(self.body.message, 'The person who recorded the request cannot also decide it.');
    const x = await t.signIn('x@example.org');
    const own = await x.request('POST', `/grants/${gid}/approve`, {});
    assert.equal(own.status, 404, 'the grantee is not a participant and cannot see it');
    const pm = await t.signIn('pm@example.org');
    assert.equal((await pm.request('POST', `/grants/${gid}/approve`, {})).status, 403, 'a Project Manager does not manage grants');
    const ok = await sponsor.request('POST', `/grants/${gid}/approve`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.grant.state, 'active');
    assert.equal((await sponsor.request('POST', `/grants/${gid}/approve`, {})).body.message, 'This request has already been decided.');
  });

  test('nobody approves access for themselves', async () => {
    const gid = (await request(admin, { userId: ids.sponsor, kind: 'oversight' })).body.grant.id;
    const r = await sponsor.request('POST', `/grants/${gid}/approve`, {});
    assert.equal(r.status, 403);
    assert.equal(r.body.message, 'Nobody can approve access for themselves.');
  });

  test('the holder can read but not change anything', async () => {
    const gid = (await request(owner)).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    const x = await t.signIn('x@example.org');
    const p = await x.request('GET', `/projects/${projectId}`);
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.project.myRoles, []);
    assert.equal((await x.request('GET', `/projects/${projectId}/notes`)).status, 200);
    const add = await x.request('POST', `/projects/${projectId}/notes`, { title: 'T', text: 'Some notes.' });
    assert.equal(add.status, 403);
    assert.equal(add.body.message, 'Audit and Oversight access is read-only.');
    assert.equal((await x.request('POST', `/projects/${projectId}/edit`, { name: 'No' })).status, 403);
    const list = await x.request('GET', '/projects');
    assert.deepEqual(list.body.projects.map((r: { id: string; access: string | null }) => [r.id, r.access]), [[projectId, 'audit']]);
  });

  test('access ends with the grant', async () => {
    const gid = (await request(owner)).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    const x = await t.signIn('x@example.org');
    const see = async () => (await x.request('GET', `/projects/${projectId}`)).status;
    assert.equal((await owner.request('POST', `/grants/${gid}/suspend`, {})).body.message, 'A reason is required.');
    assert.equal((await owner.request('POST', `/grants/${gid}/suspend`, { reason: 'Checking scope' })).status, 200);
    assert.equal(await see(), 404);
    assert.equal((await owner.request('POST', `/grants/${gid}/restore`, { reason: 'Scope confirmed' })).status, 200);
    assert.equal(await see(), 200);
    assert.equal((await owner.request('POST', `/grants/${gid}/extend`, { expiresOn: '2027-03-09' })).status, 200);
    assert.equal((await owner.request('POST', `/grants/${gid}/extend`, { expiresOn: '2027-06-09' })).body.message, 'Access can be granted for at most 90 days at a time.');
    assert.equal((await owner.request('POST', `/grants/${gid}/revoke`, { reason: 'Audit finished' })).status, 200);
    assert.equal(await see(), 404);
    const again = await owner.request('POST', `/grants/${gid}/restore`, { reason: 'x' });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'This access was revoked; record a new request instead.');
  });

  test('a grant ends after its last day', async () => {
    const gid = (await request(owner, { expiresOn: '2026-11-10' })).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    const x = await t.signIn('x@example.org');
    assert.equal((await x.request('GET', `/projects/${projectId}`)).status, 200);
    t.clock.advanceSeconds(2 * 86400);
    const x2 = await t.signIn('x@example.org');
    assert.equal((await x2.request('GET', `/projects/${projectId}`)).status, 404);
  });

  test('at most 90 days', async () => {
    const r = await request(owner, { expiresOn: '2027-02-08' });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Access can be granted for at most 90 days at a time.');
    assert.equal((await request(owner, { expiresOn: '2027-02-07' })).status, 201);
  });

  test('a hold suspends grants in that project', async () => {
    const gid = (await request(owner, { userId: ids.mem })).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    await admin.request('POST', '/domains', { domain: 'example.org' });
    await admin.request('POST', `/users/${ids.mem}/disable`);
    await admin.request('POST', `/users/${ids.mem}/enable`);
    const mem = await t.signIn('mem@example.org');
    assert.equal((await mem.request('GET', `/projects/${projectId}`)).status, 404);
    const list = await mem.request('GET', '/projects');
    assert.equal(list.status, 200, 'My Projects still loads while a membership is held');
    assert.deepEqual(list.body.projects, []);
  });

  test('managers see every grant; a holder sees only their own', async () => {
    const gid = (await request(owner)).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    await request(owner, { userId: ids.pm, kind: 'oversight' });
    const forOwner = (await owner.request('GET', `/projects/${projectId}`)).body.project.grants;
    assert.equal(forOwner.length, 2);
    const x = await t.signIn('x@example.org');
    const forX = (await x.request('GET', `/projects/${projectId}`)).body.project.grants;
    assert.deepEqual(forX.map((g: { id: string }) => g.id), [gid]);
    const pm = await t.signIn('pm@example.org');
    assert.deepEqual((await pm.request('GET', `/projects/${projectId}`)).body.project.grants.map((g: { kind: string }) => g.kind), ['oversight'], 'the PM sees only their own');
  });
});
