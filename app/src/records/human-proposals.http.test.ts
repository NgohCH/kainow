import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('human proposals', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let owner: Client;
  let member: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'mem', 'x']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.mem, role: 'member' }],
    });
    owner = await t.signIn('owner@example.org');
    member = await t.signIn('mem@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const propose = (c: Client, over: object = {}) => c.request('POST', `/projects/${projectId}/proposals`, { kind: 'action', text: 'Book the room for the launch', owner: 'Mem', due: 'by 30 November 2026', ...over });

  test('a member proposes a task; the Owner authorises it', async () => {
    const r = await propose(member);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const listed = (await owner.request('GET', `/projects/${projectId}/proposals`)).body.proposals;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].label, 'Human proposal — no discussion source');
    assert.equal(listed[0].proposedBy, 'mem');
    assert.deepEqual([listed[0].dueReading.state, listed[0].dueReading.latest], ['exact', '2026-11-30'], 'the written due is read so the form can pre-fill it');
    const a = await owner.request('POST', `/proposals/${r.body.proposal.id}/authorise`, { assigneeId: ids.mem, dueOn: '2026-11-30' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.record.kind, 'task');
    const again = await owner.request('POST', `/proposals/${r.body.proposal.id}/authorise`, { assigneeId: ids.mem, dueOn: '2026-11-30' });
    assert.equal(again.status, 200, 'a repeated click returns the record');
    const after = (await owner.request('GET', `/projects/${projectId}/proposals`)).body.proposals[0];
    assert.deepEqual([after.reviewStatus, after.record.kind], ['approved', 'task']);
    assert.equal((await member.request('POST', `/proposals/${r.body.proposal.id}/authorise`, {})).status, 403, 'a member does not authorise');
  });

  test('rejecting needs a reason', async () => {
    const id = (await propose(member, { kind: 'question', text: 'Who books the room?' })).body.proposal.id;
    const r = await owner.request('POST', `/proposals/${id}/reject`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'A reason is required.');
    assert.equal((await owner.request('POST', `/proposals/${id}/reject`, { reason: 'Already decided' })).status, 200);
    const again = await owner.request('POST', `/proposals/${id}/authorise`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'This proposal was rejected.');
  });

  test('a grant holder cannot propose', async () => {
    const admin = await t.signIn('admin@example.org');
    const gid = (await owner.request('POST', `/projects/${projectId}/grants`, { userId: ids.x, kind: 'audit', purpose: 'p', scope: 's', startsOn: '2026-11-09' })).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    const x = await t.signIn('x@example.org');
    assert.equal((await x.request('GET', `/projects/${projectId}/proposals`)).status, 200);
    const r = await propose(x);
    assert.equal(r.status, 403);
  });

  test('not while Deferred', async () => {
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await propose(member)).status, 403);
  });
});
