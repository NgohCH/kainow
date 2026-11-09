import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const TEXT = 'Ann will export the records by 20 November 2026.';

describe('change requests', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let owner: Client;
  let sponsor: Client;
  let sponsor2: Client;
  const ids: Record<string, string> = {};
  let projectId: string;
  let runId: string;
  let versionId: string;
  let itemId: string;

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'sponsor', 'sponsor2', 'ann', 'aud']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    admin = await t.signIn('admin@example.org');
    await admin.request('POST', '/domains', { domain: 'example.org' });
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.sponsor2, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    sponsor2 = await t.signIn('sponsor2@example.org');
    versionId = (await pm.request('POST', `/projects/${projectId}/notes`, { title: 'N', text: TEXT })).body.version.id;
    runId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at) VALUES ($1, $2, $3, 'succeeded', 1, 0, now(), now())`,
      [runId, versionId, ids.pm],
    );
    itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, owner, due, quote, quote_start, quote_end, quote_matches, created_at)
       VALUES ($1, $2, $3, 0, 'action', 'Export the records.', 'Ann', 'by 20 November 2026', $4, 0, $5, 1, now())`,
      [itemId, runId, versionId, TEXT, TEXT.length],
    );
  });
  afterEach(async () => {
    await t?.close();
  });

  const setCount = (n: number) => t.pool.query(`UPDATE approval_policy SET required = $1`, [n]);
  const authorise = (c: Client, body: object = { assigneeId: ids.ann, dueOn: '2026-11-20' }) =>
    c.request('POST', `/extractions/${runId}/items/${itemId}/authorise`, { sourceVersionId: versionId, ...body });
  const approve = (c: Client, id: string, version = 1, extra: object = {}) => c.request('POST', `/changes/${id}/approve`, { version, ...extra });
  const tasks = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1`, [projectId])).rows[0].n as number;
  const status = async (id: string) => (await t.pool.query(`SELECT status FROM change_requests WHERE id = $1`, [id])).rows[0].status as string;

  test('with one approval, authorising behaves as before', async () => {
    const r = await authorise(owner);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.record.kind, 'task');
    assert.equal(r.body.request, undefined);
    assert.equal(await tasks(), 1);
    const req = (await t.pool.query(`SELECT status, required_approvals, decided_by FROM change_requests WHERE target_id = $1`, [itemId])).rows[0];
    assert.deepEqual(req, { status: 'authorised', required_approvals: 1, decided_by: ids.owner });
    const again = await authorise(sponsor);
    assert.equal(again.status, 200);
    assert.equal(again.body.record.id, r.body.record.id);
    const audit = (await t.pool.query(`SELECT action FROM audit_events WHERE subject_type = 'change_request'`)).rows.map((x) => x.action).sort();
    assert.deepEqual(audit, ['change.applied', 'change.approved', 'change.submitted']);
  });

  test('with two, the first approval waits and the second creates the record', async () => {
    await setCount(2);
    const r = await authorise(owner);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const request = r.body.request;
    assert.deepEqual([request.status, request.version, request.requiredApprovals, request.approvals.length], ['pending', 1, 2, 1]);
    assert.equal(request.approvals[0].name, 'owner');
    assert.equal(request.terms.assigneeId, ids.ann);
    assert.equal(await tasks(), 0, 'a pending request changes nothing');
    assert.equal((await t.pool.query(`SELECT review_status FROM extraction_items WHERE id = $1`, [itemId])).rows[0].review_status, 'pending');
    const listed = (await sponsor.request('GET', `/projects/${projectId}/changes`)).body.requests;
    assert.deepEqual([listed.length, listed[0].mayApprove, listed[0].why], [1, true, null]);
    const ownerView = (await owner.request('GET', `/projects/${projectId}/changes`)).body.requests[0];
    assert.deepEqual([ownerView.mayApprove, ownerView.mayRevise, ownerView.mayWithdraw], [false, true, true]);
    const a = await approve(sponsor, request.id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.applied.record.kind, 'task');
    assert.equal(a.body.request.status, 'authorised');
    assert.equal(await tasks(), 1);
    const task = (await t.pool.query(`SELECT authorised_by FROM tasks WHERE id = $1`, [a.body.applied.record.id])).rows[0];
    assert.equal(task.authorised_by, ids.sponsor, 'authorised by the approval that completed the count');
  });

  test('the same person approving twice does not count twice', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    const again = await approve(owner, id);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.request.status, again.body.request.approvals.length], ['pending', 1]);
    assert.equal(again.body.applied, undefined);
    assert.equal(await tasks(), 0);
  });

  test('two approvers completing at once apply the change once', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    const [a, b] = await Promise.all([approve(sponsor, id), approve(sponsor2, id)]);
    assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
    assert.equal([a, b].filter((x) => x.body.applied?.record).length, 1);
    assert.equal(await tasks(), 1);
    assert.equal(await status(id), 'authorised');
  });

  test('a stale version is refused', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    const rev = await owner.request('POST', `/changes/${id}/revise`, { terms: { sourceVersionId: versionId, assigneeId: ids.ann, dueOn: '2026-11-21' }, reason: 'One more day' });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    const r = await approve(sponsor, id, 1);
    assert.deepEqual([r.status, r.body.message], [409, 'This change was revised; review the new version.']);
  });

  test('revising resets the approvals', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    const rev = await owner.request('POST', `/changes/${id}/revise`, { terms: { sourceVersionId: versionId, assigneeId: ids.ann, dueOn: '2026-11-21' }, reason: 'One more day' });
    assert.deepEqual([rev.body.request.version, rev.body.request.approvals.length, rev.body.request.terms.dueOn], [2, 0, '2026-11-21']);
    const notMine = await sponsor.request('POST', `/changes/${id}/revise`, { terms: {}, reason: 'x' });
    assert.equal(notMine.status, 403);
    assert.equal((await approve(sponsor, id, 2)).body.request.status, 'pending');
    const done = await approve(owner, id, 2);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const due = (await t.pool.query(`SELECT to_char(due_on, 'YYYY-MM-DD') AS d FROM tasks WHERE id = $1`, [done.body.applied.record.id])).rows[0].d;
    assert.equal(due, '2026-11-21');
  });

  test('rejection ends the review', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    assert.equal((await sponsor.request('POST', `/changes/${id}/reject`, {})).status, 400);
    const r = await sponsor.request('POST', `/changes/${id}/reject`, { reason: 'Not now' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.request.status, r.body.request.outcomeReason], ['rejected', 'Not now']);
    const late = await approve(sponsor2, id);
    assert.deepEqual([late.status, late.body.message], [409, 'This change is no longer waiting for authorisation.']);
    assert.equal(await tasks(), 0);
  });

  test('rejecting an AI proposal ends its pending authorisation', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    t.clock.advanceSeconds(60);
    const r = await sponsor.request('POST', `/extractions/${runId}/items/${itemId}/review`, { decision: 'rejected', sourceVersionId: versionId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const req = (await t.pool.query(`SELECT status, decided_by, reason FROM change_requests WHERE id = $1`, [id])).rows[0];
    assert.deepEqual([req.status, req.decided_by], ['rejected', ids.sponsor]);
    assert.ok(req.reason);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'change.rejected' AND subject_id = $1`, [id])).rows[0].n, 1);
    const late = await approve(sponsor2, id);
    assert.deepEqual([late.status, late.body.message], [409, 'This change is no longer waiting for authorisation.']);
    assert.equal((await t.pool.query(`SELECT review_status FROM extraction_items WHERE id = $1`, [itemId])).rows[0].review_status, 'rejected');
    assert.equal(await tasks(), 0);
    const fresh = await authorise(sponsor2);
    assert.deepEqual([fresh.status, fresh.body.message], [409, 'This proposal was rejected.']);
  });

  test("rejecting a people's proposal ends its pending authorisation", async () => {
    await setCount(2);
    const proposal = (await pm.request('POST', `/projects/${projectId}/proposals`, { kind: 'action', text: 'Book the room', owner: 'Ann', due: 'by 30 November 2026' })).body.proposal.id;
    const a = await owner.request('POST', `/proposals/${proposal}/authorise`, { assigneeId: ids.ann, dueOn: '2026-11-30' });
    assert.equal(a.status, 202, JSON.stringify(a.body));
    const id = a.body.request.id;
    t.clock.advanceSeconds(60);
    const r = await sponsor.request('POST', `/proposals/${proposal}/reject`, { reason: 'Already booked' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const req = (await t.pool.query(`SELECT status, decided_by, reason FROM change_requests WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(req, { status: 'rejected', decided_by: ids.sponsor, reason: 'Already booked' });
    const late = await approve(sponsor2, id);
    assert.deepEqual([late.status, late.body.message], [409, 'This change is no longer waiting for authorisation.']);
    assert.equal((await t.pool.query(`SELECT review_status FROM human_proposals WHERE id = $1`, [proposal])).rows[0].review_status, 'rejected');
    assert.equal(await tasks(), 0);
  });

  test('the list can be limited to waiting requests', async () => {
    await setCount(3);
    const first = (await authorise(owner)).body.request.id;
    assert.equal((await sponsor.request('POST', `/changes/${first}/withdraw`, { reason: 'Wrong person' })).status, 403);
    assert.equal((await owner.request('POST', `/changes/${first}/withdraw`, { reason: 'Wrong person' })).status, 200);
    t.clock.advanceSeconds(60);
    const second = (await authorise(owner)).body.request.id;
    t.clock.advanceSeconds(60);
    assert.equal((await approve(sponsor, second)).body.request.status, 'pending', 'two of three');
    const all = (await sponsor2.request('GET', `/projects/${projectId}/changes`)).body.requests;
    assert.deepEqual(all.map((r: { id: string }) => r.id), [second, first]);
    const waiting = await sponsor2.request('GET', `/projects/${projectId}/changes?status=pending`);
    assert.equal(waiting.status, 200, JSON.stringify(waiting.body));
    assert.deepEqual(waiting.body.requests.map((r: { id: string; status: string }) => [r.id, r.status]), [[second, 'pending']]);
    const [w] = waiting.body.requests;
    assert.deepEqual([w.approvals.map((a: { name: string }) => a.name), w.submittedBy, w.terms.assigneeId, w.mayApprove], [['owner', 'sponsor'], 'owner', ids.ann, true]);
    assert.equal((await sponsor2.request('GET', `/projects/${projectId}/changes?status=nonsense`)).status, 400);
  });

  test('withdrawal by the submitter', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    const ann = await t.signIn('ann@example.org');
    assert.equal((await ann.request('POST', `/changes/${id}/withdraw`, { reason: 'x' })).status, 403);
    const r = await owner.request('POST', `/changes/${id}/withdraw`, { reason: 'Wrong person' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.request.status, 'withdrawn');
    // A new request may then be made for the same proposal.
    assert.equal((await authorise(owner)).status, 202);
    const second = (await t.pool.query(`SELECT id FROM change_requests WHERE status = 'pending'`)).rows[0].id;
    assert.equal((await pm.request('POST', `/changes/${second}/withdraw`, { reason: 'Not needed' })).status, 200, 'the PM may withdraw');
  });

  test('not enough approvers', async () => {
    await setCount(3);
    await t.pool.query(`UPDATE memberships SET revoked_at = now() WHERE user_id = $1`, [ids.sponsor2]);
    const r = await authorise(owner);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.request.why, 'Not enough approvers: needs 3, the project has 2.');
    const a = await approve(sponsor, r.body.request.id);
    assert.deepEqual([a.status, a.body.message], [409, 'Not enough approvers: needs 3, the project has 2.']);
  });

  test('a second open request on the same target is refused', async () => {
    await setCount(2);
    assert.equal((await authorise(owner)).status, 202);
    const r = await authorise(sponsor);
    assert.deepEqual([r.status, r.body.message], [409, 'This proposal already has a change waiting for authorisation.']);
    const direct = await sponsor.request('POST', `/projects/${projectId}/changes`, {
      kind: 'authorise_proposal', targetKind: 'extraction_item', targetId: itemId, terms: { sourceVersionId: versionId, assigneeId: ids.ann, dueOn: '2026-11-20' },
    });
    assert.deepEqual([direct.status, direct.body.message], [409, 'This proposal already has a change waiting for authorisation.']);
  });

  test('a request can be submitted directly and approved later', async () => {
    await setCount(2);
    const r = await sponsor.request('POST', `/projects/${projectId}/changes`, {
      kind: 'authorise_proposal', targetKind: 'extraction_item', targetId: itemId, terms: { sourceVersionId: versionId, assigneeId: ids.ann, dueOn: '2026-11-20' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.request.status, r.body.request.approvals.length], ['pending', 0]);
    const terms = await approve(owner, r.body.request.id, 1, { terms: { dueOn: '2026-11-22' } });
    assert.deepEqual([terms.status, terms.body.message], [400, 'This change cannot be edited while approving.']);
  });

  test('an approval re-checks the terms', async () => {
    await setCount(2);
    const domain = (await admin.request('POST', '/domains', { domain: 'kainow.test' })).body.domain;
    const r = await authorise(owner, { inviteEmail: 'new@kainow.test', dueOn: '2026-11-20' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await admin.request('POST', `/domains/${domain.id}/remove`, {});
    const a = await approve(sponsor, r.body.request.id);
    assert.deepEqual([a.status, a.body.message], [400, 'That address is not in an eligible organisation domain.']);
    const after = (await owner.request('GET', `/projects/${projectId}/changes`)).body.requests[0];
    assert.deepEqual([after.status, after.approvals.length], ['pending', 1], 'the refused approval is not kept');
    assert.equal(await tasks(), 0);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM invitations WHERE email = 'new@kainow.test'`)).rows[0].n, 0);
  });

  test('an invited assignee is emailed once the count is reached', async () => {
    await setCount(2);
    const r = await authorise(owner, { inviteEmail: 'new@example.org', dueOn: '2026-11-20' });
    assert.equal(r.status, 202);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM invitations WHERE email = 'new@example.org'`)).rows[0].n, 0, 'nothing is issued while pending');
    const a = await approve(sponsor, r.body.request.id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.applied.delivered, true);
    assert.ok(t.sender.lastInvitation('new@example.org'));
  });

  test('editing an AI proposal sets aside its pending authorisation', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    const e = await pm.request('POST', `/extractions/${runId}/items/${itemId}/edit`, { sourceVersionId: versionId, text: 'Export all the records.', owner: 'Ann', due: 'by 20 November 2026' });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(await status(id), 'superseded');
    assert.equal((await approve(sponsor, id)).status, 409);
    assert.equal((await authorise(owner)).status, 202, 'authorisation starts again on the new wording');
  });

  test('Audit/Oversight holders cannot approve', async () => {
    await setCount(2);
    const id = (await authorise(owner)).body.request.id;
    const gid = (await owner.request('POST', `/projects/${projectId}/grants`, { userId: ids.aud, kind: 'audit', purpose: 'p', scope: 's', startsOn: '2026-11-09' })).body.grant.id;
    await admin.request('POST', `/grants/${gid}/approve`, {});
    const aud = await t.signIn('aud@example.org');
    assert.equal((await aud.request('GET', `/projects/${projectId}/changes`)).status, 200);
    const r = await approve(aud, id);
    assert.deepEqual([r.status, r.body.message], [403, 'Only an Owner or Sponsor of this project can approve.']);
    assert.equal((await approve(pm, id)).status, 403, 'nor the Project Manager');
  });
});
