import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { PolicyService } from './policy.service';
import { seedProject, seedUser } from '../testing/projects';

describe('the approval policy', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let owner: Client;
  let pm: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['owner', 'pm', 'ann']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    admin = await t.signIn('admin@example.org');
    owner = await t.signIn('owner@example.org');
    pm = await t.signIn('pm@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const orgRow = async () => (await t.pool.query(`SELECT required, projects_may_override AS "mayOverride" FROM approval_policy`)).rows[0];

  /** A pending request with one approval on version 1, as Task 4 will leave it. */
  const pendingRequest = async (required: number, project = projectId) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, 'amend_task', 'task', $3, 1, $4, 'pending', $5, now())`,
      [id, project, uuidv7(), required, ids.pm],
    );
    await t.pool.query(
      `INSERT INTO change_request_versions (request_id, version, terms, reason, author_id, at) VALUES ($1, 1, '{"title":"New"}', 'Why', $2, now())`,
      [id, ids.pm],
    );
    await t.pool.query(`INSERT INTO approvals (id, request_id, version, approver_id, at) VALUES ($1, $2, 1, $3, now())`, [uuidv7(), id, ids.owner]);
    return id;
  };

  test('the Administrator sets the organisation count with a reason and it is recorded', async () => {
    const r = await admin.request('POST', '/approval-policy', { required: 2, reason: 'Two sets of eyes', pending: 'keep' });
    assert.equal(r.status, 200);
    assert.equal((await orgRow()).required, 2);
    const g = await admin.request('GET', '/approval-policy');
    assert.equal(g.status, 200);
    assert.equal(g.body.required, 2);
    assert.equal(g.body.projectsMayOverride, false);
    assert.equal(g.body.history.length, 1);
    assert.deepEqual(
      [g.body.history[0].field, g.body.history[0].oldValue, g.body.history[0].newValue, g.body.history[0].reason, g.body.history[0].actor],
      ['required', '1', '2', 'Two sets of eyes', 'admin'],
    );
    const noReason = await admin.request('POST', '/approval-policy', { required: 3, reason: ' ', pending: 'keep' });
    assert.equal(noReason.status, 400);
    assert.equal((await owner.request('GET', '/approval-policy')).status, 403);
    assert.equal((await owner.request('POST', '/approval-policy', { required: 3, reason: 'x', pending: 'keep' })).status, 403);
  });

  test('a count outside 1–3 is refused', async () => {
    for (const bad of [0, 4, 1.5, '2', null]) {
      const r = await admin.request('POST', '/approval-policy', { required: bad, reason: 'x', pending: 'keep' });
      assert.equal(r.status, 400, String(bad));
    }
    const badChoice = await admin.request('POST', '/approval-policy', { required: 2, reason: 'x', pending: 'maybe' });
    assert.equal(badChoice.status, 400);
    assert.equal((await orgRow()).required, 1);
  });

  test('projects may set their own count only when allowed', async () => {
    const off = await owner.request('POST', `/projects/${projectId}/approval-policy`, { required: 2, reason: 'Bigger project', pending: 'keep' });
    assert.deepEqual([off.status, off.body.message], [403, 'Approval counts are set by the Administrator.']);
    const view = await owner.request('GET', `/projects/${projectId}/approval-policy`);
    assert.deepEqual([view.body.effective, view.body.own, view.body.mayEdit], [1, null, false]);

    assert.equal((await admin.request('POST', '/approval-policy', { projectsMayOverride: true, reason: 'Allow it', pending: 'keep' })).status, 200);
    assert.equal((await owner.request('GET', `/projects/${projectId}/approval-policy`)).body.mayEdit, true);

    const notOwner = await pm.request('POST', `/projects/${projectId}/approval-policy`, { required: 2, reason: 'x', pending: 'keep' });
    assert.deepEqual([notOwner.status, notOwner.body.message], [403, "Only an Owner or Sponsor can set this project's approval count."]);
    const bad = await owner.request('POST', `/projects/${projectId}/approval-policy`, { required: 5, reason: 'x', pending: 'keep' });
    assert.equal(bad.status, 400);

    const ok = await owner.request('POST', `/projects/${projectId}/approval-policy`, { required: 2, reason: 'Bigger project', pending: 'keep' });
    assert.equal(ok.status, 200);
    const after = await owner.request('GET', `/projects/${projectId}/approval-policy`);
    assert.deepEqual([after.body.effective, after.body.own], [2, 2]);
    assert.equal(after.body.history.length, 1);
    assert.equal(after.body.history[0].actor, 'owner');
    assert.equal(after.body.history[0].reason, 'Bigger project');

    t.clock.advanceSeconds(60);
    const clear = await owner.request('POST', `/projects/${projectId}/approval-policy`, { required: null, reason: 'Back to default', pending: 'keep' });
    assert.equal(clear.status, 200);
    const cleared = await owner.request('GET', `/projects/${projectId}/approval-policy`);
    assert.deepEqual([cleared.body.effective, cleared.body.own, cleared.body.history.length], [1, null, 2]);
    assert.equal(cleared.body.history[0].newValue, null);
  });

  test('the effective count follows the override', async () => {
    await admin.request('POST', '/approval-policy', { required: 2, projectsMayOverride: true, reason: 'Policy', pending: 'keep' });
    assert.equal((await owner.request('GET', `/projects/${projectId}/approval-policy`)).body.effective, 2);
    await owner.request('POST', `/projects/${projectId}/approval-policy`, { required: 3, reason: 'Strict', pending: 'keep' });
    assert.equal((await owner.request('GET', `/projects/${projectId}/approval-policy`)).body.effective, 3);
    // Switching overrides off ignores the project's own count without erasing it.
    await admin.request('POST', '/approval-policy', { projectsMayOverride: false, reason: 'Central again', pending: 'keep' });
    const v = await owner.request('GET', `/projects/${projectId}/approval-policy`);
    assert.deepEqual([v.body.effective, v.body.own, v.body.mayEdit], [2, 3, false]);
  });

  test('keep leaves pending requests alone; restart clears their approvals and re-captures the count', async () => {
    const kept = await pendingRequest(2);

    assert.equal((await admin.request('POST', '/approval-policy', { required: 2, reason: 'Set two', pending: 'keep' })).status, 200);
    const unchanged = await t.pool.query(`SELECT version, required_approvals AS req FROM change_requests WHERE id = ANY($1)`, [[kept]]);
    assert.deepEqual(unchanged.rows.map((r) => [r.version, r.req]), [[1, 2]]);

    // Count 1 -> 2 already happened above with no pending requests; now 2 -> 3.
    assert.equal((await admin.request('POST', '/approval-policy', { required: 3, reason: 'Raise it', pending: 'keep' })).status, 200);
    const stillKept = (await t.pool.query(`SELECT version, required_approvals AS req FROM change_requests WHERE id = $1`, [kept])).rows[0];
    assert.deepEqual([stillKept.version, stillKept.req], [1, 2]);

  });

  test('restart re-captures the count and drops earlier approvals from the new version', async () => {
    await admin.request('POST', '/approval-policy', { required: 2, reason: 'Two', pending: 'keep' });
    const req = await pendingRequest(2);
    t.clock.advanceSeconds(60);
    const r = await admin.request('POST', '/approval-policy', { required: 3, reason: 'Three', pending: 'restart' });
    assert.equal(r.status, 200);
    const row = (await t.pool.query(`SELECT version, required_approvals AS req, status FROM change_requests WHERE id = $1`, [req])).rows[0];
    assert.deepEqual([row.version, row.req, row.status], [2, 3, 'pending']);
    const v2 = (await t.pool.query(`SELECT terms, reason, author_id AS author FROM change_request_versions WHERE request_id = $1 AND version = 2`, [req])).rows[0];
    assert.deepEqual(v2.terms, { title: 'New' });
    assert.equal(v2.reason, 'Review restarted after the approval count changed');
    assert.equal(v2.author, ids.admin);
    const onV2 = (await t.pool.query(`SELECT count(*)::int AS n FROM approvals WHERE request_id = $1 AND version = 2`, [req])).rows[0].n;
    assert.equal(onV2, 0);
    const onV1 = (await t.pool.query(`SELECT count(*)::int AS n FROM approvals WHERE request_id = $1 AND version = 1`, [req])).rows[0].n;
    assert.equal(onV1, 1);
    const audit = await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'change.review_restarted'`);
    assert.equal(audit.rowCount, 1);
    const hist = (await admin.request('GET', '/approval-policy')).body.history;
    assert.equal(hist[0].pendingChoice, 'restart');
  });

  test('a project restart only touches that project and skips projects with their own count', async () => {
    await admin.request('POST', '/approval-policy', { projectsMayOverride: true, reason: 'Allow', pending: 'keep' });
    const other = await seedProject(t.pool, { status: 'active', members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.ann, role: 'member' }] });
    await t.pool.query(`UPDATE projects SET required_approvals = 3 WHERE id = $1`, [other]);
    const mine = await pendingRequest(1);
    const theirs = await pendingRequest(3, other);
    t.clock.advanceSeconds(60);
    // Organisation count 1 -> 2: only the project without an override is affected.
    await admin.request('POST', '/approval-policy', { required: 2, reason: 'Two', pending: 'restart' });
    const get = async (id: string) => (await t.pool.query(`SELECT version, required_approvals AS req FROM change_requests WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(await get(mine), { version: 2, req: 2 });
    assert.deepEqual(await get(theirs), { version: 1, req: 3 });
    // A project-level change restarts only that project's requests.
    t.clock.advanceSeconds(60);
    const r = await owner.request('POST', `/projects/${projectId}/approval-policy`, { required: 3, reason: 'Three here', pending: 'restart' });
    assert.equal(r.status, 200);
    assert.deepEqual(await get(mine), { version: 3, req: 3 });
    assert.deepEqual(await get(theirs), { version: 1, req: 3 });
  });

  test('impact counts pending requests', async () => {
    assert.deepEqual((await admin.request('GET', '/approval-policy/impact')).body, { pending: 0 });
    await pendingRequest(1);
    const done = await pendingRequest(1);
    await t.pool.query(`UPDATE change_requests SET status = 'withdrawn' WHERE id = $1`, [done]);
    assert.deepEqual((await admin.request('GET', '/approval-policy/impact')).body, { pending: 1 });
    assert.equal((await owner.request('GET', '/approval-policy/impact')).status, 403);
  });

  test('a request decided before the restart reached it is left untouched', async () => {
    const req = await pendingRequest(2);
    await t.pool.query(`UPDATE change_requests SET status = 'authorised' WHERE id = $1`, [req]);
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      const done = await t.app.get(PolicyService).restart(client, req, projectId, 3, ids.admin, new Date());
      await client.query('COMMIT');
      assert.equal(done, false);
    } finally {
      client.release();
    }
    const row = (await t.pool.query(`SELECT version, required_approvals AS req, status FROM change_requests WHERE id = $1`, [req])).rows[0];
    assert.deepEqual([row.version, row.req, row.status], [1, 2, 'authorised']);
    const versions = (await t.pool.query(`SELECT count(*)::int AS n FROM change_request_versions WHERE request_id = $1`, [req])).rows[0].n;
    assert.equal(versions, 1);
  });
});
