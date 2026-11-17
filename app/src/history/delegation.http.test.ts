import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

describe('delegating record deletion to the Project Manager (D83)', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let own: Client;
  let spo: Client;
  let dep: Client;

  const delegate = (c: Client, reason: unknown = 'The PM keeps the register tidy') => c.request('POST', `/projects/${project}/record-deletion-delegation`, { reason });
  const revoke = (c: Client, reason: unknown = 'Back to us') => c.request('POST', `/projects/${project}/record-deletion-delegation/revoke`, { reason });
  const task = async (status = 'cancelled') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) VALUES ($1, $2, NULL, 0, 'Order valves', $3, '2026-11-20', $4, $5, now())`,
      [id, project, ids.ada, status, ids.own],
    );
    return id;
  };
  const notices = async () => (await t.pool.query(`SELECT user_id, summary FROM notifications ORDER BY summary, user_id`)).rows;

  beforeEach(async () => {
    t = await startTestApp(undefined, { assistQueue: { enqueue: async () => undefined } });
    for (const k of ['pm', 'own', 'spo', 'dep', 'ada', 'next']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.own, role: 'owner' },
        { userId: ids.spo, role: 'sponsor' },
        { userId: ids.dep, role: 'deputy_pm' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    [pm, own, spo, dep] = [await t.signIn('pm@example.org'), await t.signIn('own@example.org'), await t.signIn('spo@example.org'), await t.signIn('dep@example.org')];
  });
  afterEach(async () => {
    await t.close();
  });

  test('Sponsor delegates; PM then deletes a cancelled task', async () => {
    const id = await task();
    assert.equal((await pm.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate' })).status, 403);
    assert.equal((await delegate(pm)).status, 403, 'the PM cannot delegate to themselves');
    assert.equal((await delegate(spo, '  ')).status, 400);
    const d = await delegate(spo);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const view = await pm.request('GET', `/projects/${project}`);
    assert.deepEqual(
      { ...view.body.project.recordDeletionDelegation, at: undefined },
      { pm: 'pm', by: 'spo', reason: 'The PM keeps the register tidy', at: undefined },
    );
    const r = await pm.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await t.pool.query(`SELECT deleted_by FROM tasks WHERE id = $1`, [id])).rows[0].deleted_by, ids.pm);
    const back = await pm.request('POST', `/records/task/${id}/restore`, { reason: 'Needed after all' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
  });

  test('Owners and Sponsors get an in-app notice titled "<PM> deleted a task in <project>"', async () => {
    await delegate(own);
    const id = await task();
    assert.equal((await own.request('POST', `/records/task/${id}/delete`, { reason: 'Mine to delete' })).status, 200);
    assert.deepEqual(await notices(), [], 'no notice when an Owner acts');
    await own.request('POST', `/records/task/${id}/restore`, { reason: 'Back' });
    assert.equal((await pm.request('POST', `/records/task/${id}/delete`, { reason: 'Secret reason text' })).status, 200);
    const n = await notices();
    assert.deepEqual(n.map((x) => x.summary), ['pm deleted a task in Alpha Project', 'pm deleted a task in Alpha Project']);
    assert.deepEqual(n.map((x) => x.user_id).sort(), [ids.own, ids.spo].sort());
    assert.ok(!JSON.stringify(n).includes('valves') && !JSON.stringify(n).includes('Secret'));
    assert.equal((await pm.request('POST', `/records/task/${id}/restore`, { reason: 'Restoring it' })).status, 200);
    assert.equal((await notices()).filter((x) => x.summary === 'pm restored a task in Alpha Project').length, 2);
  });

  test('a Deputy cannot receive or use it', async () => {
    await delegate(own);
    const id = await task();
    assert.equal((await dep.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate' })).status, 403);
    assert.equal((await dep.request('POST', `/projects/${project}/record-deletion-delegation/revoke`, { reason: 'x' })).status, 403);
    assert.equal((await t.pool.query(`SELECT pm_user_id FROM record_deletion_delegations`)).rows[0].pm_user_id, ids.pm);
  });

  test('a second open delegation is refused', async () => {
    assert.equal((await delegate(own)).status, 200);
    const again = await delegate(spo);
    assert.equal(again.status, 409);
    assert.equal(again.body.message, 'The Project Manager is already allowed to delete and restore records.');
  });

  test('changing the PM ends it', async () => {
    await delegate(own);
    assert.equal((await own.request('POST', `/projects/${project}/members`, { userId: ids.next, role: 'pm', startsOn: '2026-11-09' })).status, 201);
    const row = (await t.pool.query(`SELECT revoked_by, revoked_at FROM record_deletion_delegations`)).rows[0];
    assert.equal(row.revoked_by, ids.own);
    assert.ok(row.revoked_at);
    const id = await task();
    assert.equal((await pm.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate' })).status, 404, 'the old PM left the project');
    assert.equal((await (await t.signIn('next@example.org')).request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate' })).status, 403);
  });

  test('any Owner or Sponsor revokes it with a reason', async () => {
    await delegate(own);
    assert.equal((await revoke(spo, '')).status, 400);
    assert.equal((await revoke(pm)).status, 403);
    const r = await revoke(spo, 'Taking it back');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (await t.pool.query(`SELECT revoked_by, revoke_reason FROM record_deletion_delegations`)).rows[0];
    assert.deepEqual([row.revoked_by, row.revoke_reason], [ids.spo, 'Taking it back']);
    assert.equal((await revoke(own)).status, 409);
    const id = await task();
    assert.equal((await pm.request('POST', `/records/task/${id}/delete`, { reason: 'Duplicate' })).status, 403);
    assert.equal((await pm.request('GET', `/projects/${project}`)).body.project.recordDeletionDelegation, null);
    assert.equal((await delegate(own)).status, 200, 'it can be delegated again');
  });
});
