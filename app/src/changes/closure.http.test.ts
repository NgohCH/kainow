import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const DELIVERED = 'Delivered needs every task finished or cancelled and the objectives confirmed as met.';
const FINAL_ACCEPT = 'Only an Owner or Sponsor can accept a risk with no further review.';
const CLOSE_OS = 'Only the Owner or a Sponsor can close the project.';

describe('closure accounting and delegated closure', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let owner: Client;
  let sponsor: Client;
  let ann: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'sponsor', 'ann', 'next']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Records Upgrade',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    ann = await t.signIn('ann@example.org');
    await (await t.signIn('admin@example.org')).request('POST', '/domains', { domain: 'example.org' });
  });
  afterEach(async () => {
    await t?.close();
  });

  const task = async (status = 'not_started') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at) VALUES ($1, $2, 0, 'Task', $3, '2026-11-20', $4, $5, now())`,
      [id, projectId, ids.ann, status, ids.owner],
    );
    return id;
  };
  const question = async (status = 'open') => {
    const id = uuidv7();
    const proposal = uuidv7();
    await t.pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'question', 'Q', $3, now())`, [proposal, projectId, ids.owner]);
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, 'Which vendor?', $3, $4, $5, $3, now())`,
      [id, projectId, ids.owner, status, proposal],
    );
    return id;
  };
  const risk = async (status = 'open', reviewOn: string | null = null) => {
    const id = uuidv7();
    const proposal = uuidv7();
    await t.pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', 'R', $3, now())`, [proposal, projectId, ids.owner]);
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, status, review_on, responsible_id, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'Delay', 'high', $3, $4, $5, $6, $5, now())`,
      [id, projectId, status, reviewOn, ids.owner, proposal],
    );
    return id;
  };
  const dispose = (c: Client, recordKind: string, recordId: string, disposition: string, reason = 'Because', extra: object = {}) =>
    c.request('POST', `/projects/${projectId}/closure/dispositions`, { recordKind, recordId, disposition, reason, ...extra });
  const close = (c: Client, outcome: string, extra: object = {}) =>
    c.request('POST', `/projects/${projectId}/transition`, { to: 'closed', reason: 'Finished', outcome, ...extra });
  const view = async (c: Client) => (await c.request('GET', `/projects/${projectId}/closure`)).body;
  const status = async () => (await t.pool.query(`SELECT status, closure_outcome FROM projects WHERE id = $1`, [projectId])).rows[0];
  const setCount = (n: number) => t.pool.query(`UPDATE approval_policy SET required = $1`, [n]);
  const delegate = (c: Client, reason = 'The PM knows the work') => c.request('POST', `/projects/${projectId}/closure/delegation`, { reason });

  test('close is refused until every open item has a disposition', async () => {
    const a = await task();
    await task('completed');
    const q = await question();
    const r = await risk();
    await risk('accepted', null);
    const refused = await close(owner, 'partially_delivered');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.message, 'Closing needs a disposition for every open item: 3 remain.');
    assert.deepEqual(
      refused.body.missing.map((m: { kind: string; id: string; why: string }) => `${m.kind}:${m.id}:${m.why}`).sort(),
      [`question:${q}:No disposition yet`, `risk:${r}:No disposition yet`, `task:${a}:No disposition yet`].sort(),
    );
    const before = await view(owner);
    assert.equal(before.readiness.ready, false);
    assert.equal(before.mayPrepare, true);
    assert.deepEqual([before.items.tasks.length, before.items.questions.length, before.items.risks.length], [1, 1, 1]);

    assert.equal((await dispose(owner, 'task', a, 'keep', 'Handed to operations')).status, 201);
    assert.equal((await dispose(owner, 'question', q, 'unresolved', 'Nobody can answer it')).status, 201);
    const fa = await dispose(owner, 'risk', r, 'final_accept', 'Tolerable');
    assert.equal(fa.status, 201, JSON.stringify(fa.body));
    const ready = await view(owner);
    assert.equal(ready.readiness.ready, true);
    assert.equal(ready.items.tasks[0].disposition.disposition, 'keep');
    const closed = await close(owner, 'partially_delivered');
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(await status(), { status: 'closed', closure_outcome: 'partially_delivered' });
    const finals = (await t.pool.query(`SELECT final FROM closure_dispositions WHERE project_id = $1`, [projectId])).rows;
    assert.deepEqual(finals.map((f) => f.final), [true, true, true]);
  });

  test('a kept task rules out Delivered', async () => {
    const a = await task('in_progress');
    await dispose(owner, 'task', a, 'keep', 'Operations will finish it');
    assert.equal((await view(owner)).readiness.deliveredAllowed, false);
    const refused = await close(owner, 'delivered', { objectivesMet: true });
    assert.deepEqual([refused.status, refused.body.message], [409, DELIVERED]);
    assert.equal((await status()).status, 'active');
    assert.equal((await close(owner, 'partially_delivered')).status, 200);
  });

  test('an unresolved question affecting delivery rules out Delivered', async () => {
    const q = await question('answered');
    await dispose(owner, 'question', q, 'unresolved', 'The client has not confirmed', { affectsDelivery: true });
    const refused = await close(owner, 'delivered', { objectivesMet: true });
    assert.deepEqual([refused.status, refused.body.message], [409, DELIVERED]);
    t.clock.advanceSeconds(60);
    await dispose(owner, 'question', q, 'unresolved', 'Only a detail remains', { affectsDelivery: false });
    const closed = await close(owner, 'delivered', { objectivesMet: true });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal((await t.pool.query(`SELECT status FROM questions WHERE id = $1`, [q])).rows[0].status, 'answered', 'left unresolved');
  });

  test('Delivered needs the objectives confirmed', async () => {
    await task('completed');
    const refused = await close(owner, 'delivered');
    assert.deepEqual([refused.status, refused.body.message], [409, DELIVERED]);
    const unticked = await close(owner, 'delivered', { objectivesMet: false });
    assert.equal(unticked.status, 409);
    const closed = await close(owner, 'delivered', { objectivesMet: true });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(await status(), { status: 'closed', closure_outcome: 'delivered' });
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'project.transition' AND subject_id = $1`, [projectId])).rows.at(-1);
    assert.equal(audit.detail.objectivesMet, true);
  });

  test('cancellations at closure follow the approval count', async () => {
    // Count 1 and an approver closing: the cancellation applies at once.
    const quick = await task();
    const now = await dispose(owner, 'task', quick, 'cancel', 'No longer needed');
    assert.equal(now.status, 201, JSON.stringify(now.body));
    assert.equal((await t.pool.query(`SELECT status FROM tasks WHERE id = $1`, [quick])).rows[0].status, 'cancelled');

    // Count 2 in a Deferred project: Close waits for the batch.
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    await setCount(2);
    const slow = await task();
    t.clock.advanceSeconds(60);
    const pending = await dispose(owner, 'task', slow, 'cancel', 'Out of scope');
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    assert.equal(pending.body.request.status, 'pending');
    assert.equal(pending.body.request.batchId, projectId, 'the project closure batch');
    assert.equal(pending.body.request.approvals.length, 1);
    const listed = (await view(owner)).items.tasks.find((x: { id: string }) => x.id === slow);
    assert.equal(listed.pendingRequest.id, pending.body.request.id);
    const refused = await close(owner, 'partially_delivered');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, 'Closing needs a disposition for every open item: 1 remain.');
    assert.deepEqual(refused.body.missing, [{ kind: 'task', id: slow, why: 'Cancellation waiting for authorisation' }]);
    t.clock.advanceSeconds(60);
    const second = await sponsor.request('POST', `/changes/${pending.body.request.id}/approve`, { version: 1 });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal((await t.pool.query(`SELECT status FROM tasks WHERE id = $1`, [slow])).rows[0].status, 'cancelled');
    const closed = await close(owner, 'partially_delivered');
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
  });

  test('questions and risks take their dispositions at close', async () => {
    const q1 = await question('open');
    const q2 = await question('answered');
    const r1 = await risk('mitigating', '2026-12-01');
    await dispose(owner, 'question', q1, 'resolve', 'Settled in the last meeting');
    await dispose(owner, 'question', q2, 'withdraw', 'No longer relevant');
    await dispose(sponsor, 'risk', r1, 'final_accept', 'Tolerable after go-live');
    const statuses = async () => [
      (await t.pool.query(`SELECT status FROM questions WHERE id = $1`, [q1])).rows[0].status,
      (await t.pool.query(`SELECT status FROM questions WHERE id = $1`, [q2])).rows[0].status,
      (await t.pool.query(`SELECT status, review_on FROM risks WHERE id = $1`, [r1])).rows[0],
    ];
    assert.deepEqual((await statuses()).slice(0, 2), ['open', 'answered'], 'nothing changes before Close');
    assert.equal((await statuses())[2].status, 'mitigating');
    assert.equal((await close(owner, 'partially_delivered')).status, 200);
    const [s1, s2, r] = await statuses();
    assert.deepEqual([s1, s2, r.status, r.review_on], ['resolved', 'withdrawn', 'accepted', null]);
    const events = (await t.pool.query(`SELECT record_id, kind, to_status, note FROM record_events WHERE record_id = ANY($1) ORDER BY record_id`, [[q1, q2, r1]])).rows;
    const by = (id: string) => events.find((e) => e.record_id === id);
    assert.deepEqual([by(q1).to_status, by(q1).note], ['resolved', 'Settled in the last meeting']);
    assert.deepEqual([by(q2).to_status, by(q2).note], ['withdrawn', 'No longer relevant']);
    assert.deepEqual([by(r1).to_status, by(r1).note], ['accepted', 'No further review required']);
  });

  test('final acceptance is for Owners and Sponsors only', async () => {
    const r = await risk();
    assert.equal((await delegate(owner)).status, 201);
    const byPm = await dispose(pm, 'risk', r, 'final_accept', 'Tolerable');
    assert.deepEqual([byPm.status, byPm.body.message], [403, FINAL_ACCEPT]);
    const byMember = await dispose(ann, 'risk', r, 'final_accept', 'Tolerable');
    assert.equal(byMember.status, 403);
    assert.equal((await dispose(owner, 'risk', r, 'final_accept', 'Tolerable')).status, 201);
  });

  test('an Owner lets the PM close; the PM closes and the Owners and Sponsors are emailed', async () => {
    const a = await task();
    assert.deepEqual([(await close(pm, 'partially_delivered')).status, (await close(pm, 'partially_delivered')).body.message], [403, CLOSE_OS]);
    assert.equal((await dispose(pm, 'task', a, 'keep', 'x')).status, 403);
    assert.equal((await view(pm)).mayPrepare, false);
    const byPm = await delegate(pm);
    assert.equal(byPm.status, 403);
    const noReason = await delegate(owner, '');
    assert.deepEqual([noReason.status, noReason.body.message], [400, 'A reason is required.']);
    const d = await delegate(owner);
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal((await delegate(sponsor)).status, 409, 'one open delegation');
    const v = await view(pm);
    assert.equal(v.mayPrepare, true);
    assert.deepEqual([v.delegation.pm, v.delegation.by, v.delegation.reason], ['pm', 'owner', 'The PM knows the work']);
    assert.equal((await dispose(pm, 'task', a, 'keep', 'Operations will finish it')).status, 201);
    const closed = await close(pm, 'partially_delivered');
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(
      t.sender.closureNotices.map((n) => n.email).sort(),
      ['owner@example.org', 'sponsor@example.org'],
    );
    assert.equal(t.sender.closureNotices[0].projectName, 'Records Upgrade');
    assert.ok(t.sender.closureNotices[0].link.endsWith(`/#/projects/${projectId}`));
    const del = (await t.pool.query(`SELECT revoked_by FROM closure_delegations WHERE project_id = $1`, [projectId])).rows[0];
    assert.equal(del.revoked_by, ids.pm, 'closing ends the delegation');
  });

  test("the delegated PM's approval does not count", async () => {
    const a = await task();
    await delegate(owner);
    const r = await dispose(pm, 'task', a, 'cancel', 'No longer needed');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.request.status, 'pending');
    assert.equal(r.body.request.approvals.length, 0);
    const byPm = await pm.request('POST', `/changes/${r.body.request.id}/approve`, { version: 1 });
    assert.equal(byPm.status, 403);
    assert.equal((await close(pm, 'partially_delivered')).status, 409);
    t.clock.advanceSeconds(60);
    assert.equal((await owner.request('POST', `/changes/${r.body.request.id}/approve`, { version: 1 })).status, 200);
    assert.equal((await t.pool.query(`SELECT status FROM tasks WHERE id = $1`, [a])).rows[0].status, 'cancelled');
    assert.equal((await close(pm, 'partially_delivered')).status, 200);
  });

  test('revoked delegation stops the PM', async () => {
    const a = await task();
    await delegate(owner);
    t.clock.advanceSeconds(60);
    const revoked = await sponsor.request('POST', `/projects/${projectId}/closure/delegation/revoke`);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.delegation, null);
    assert.equal((await dispose(pm, 'task', a, 'keep', 'x')).status, 403);
    assert.equal((await close(pm, 'partially_delivered')).status, 403);

    // A new delegation ends when the PM changes.
    t.clock.advanceSeconds(60);
    assert.equal((await delegate(owner)).status, 201);
    t.clock.advanceSeconds(60);
    const appointed = await owner.request('POST', `/projects/${projectId}/members`, { userId: ids.next, role: 'pm', startsOn: '2026-11-09' });
    assert.equal(appointed.status, 201, JSON.stringify(appointed.body));
    const open = (await t.pool.query(`SELECT revoked_by FROM closure_delegations WHERE project_id = $1 ORDER BY at DESC LIMIT 1`, [projectId])).rows[0];
    assert.equal(open.revoked_by, ids.owner);
    const next = await t.signIn('next@example.org');
    assert.equal((await view(next)).mayPrepare, false);
    assert.equal((await close(next, 'partially_delivered')).status, 403);
  });

  test('dispositions can be changed before closing and the history is kept', async () => {
    const q = await question();
    await dispose(owner, 'question', q, 'unresolved', 'Waiting on the vendor', { affectsDelivery: true });
    t.clock.advanceSeconds(60);
    const changed = await dispose(sponsor, 'question', q, 'resolve', 'The vendor answered');
    assert.equal(changed.status, 201, JSON.stringify(changed.body));
    const rows = (
      await t.pool.query(
        `SELECT disposition, reason, affects_delivery, chosen_by, replaced_at IS NOT NULL AS replaced FROM closure_dispositions WHERE record_id = $1 ORDER BY chosen_at`,
        [q],
      )
    ).rows;
    assert.deepEqual(rows, [
      { disposition: 'unresolved', reason: 'Waiting on the vendor', affects_delivery: true, chosen_by: ids.owner, replaced: true },
      { disposition: 'resolve', reason: 'The vendor answered', affects_delivery: false, chosen_by: ids.sponsor, replaced: false },
    ]);
    assert.equal((await view(owner)).items.questions[0].disposition.disposition, 'resolve');
    assert.equal((await close(owner, 'delivered', { objectivesMet: true })).status, 200);
    assert.equal((await t.pool.query(`SELECT status FROM questions WHERE id = $1`, [q])).rows[0].status, 'resolved');
  });
  test('dispositions finalised at an earlier closure do not satisfy a later one', async () => {
    const a = await task('in_progress');
    await dispose(owner, 'task', a, 'keep', 'Operations will finish it');
    assert.equal((await close(owner, 'partially_delivered')).status, 200);
    t.clock.advanceSeconds(60);
    const reopened = await owner.request('POST', `/projects/${projectId}/transition`, { to: 'active', reason: 'More work', stage: 'Execution' });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    t.clock.advanceSeconds(60);
    const refused = await close(owner, 'partially_delivered');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.missing, [{ kind: 'task', id: a, why: 'No disposition yet' }]);
    assert.equal((await view(owner)).items.tasks[0].disposition, null);
    assert.equal((await dispose(owner, 'task', a, 'keep', 'Still with operations')).status, 201);
    assert.equal((await close(owner, 'partially_delivered')).status, 200);
    const rows = (await t.pool.query(`SELECT final, replaced_at IS NOT NULL AS replaced FROM closure_dispositions WHERE project_id = $1 ORDER BY chosen_at`, [projectId])).rows;
    assert.deepEqual(rows, [{ final: true, replaced: false }, { final: true, replaced: false }]);
  });
});
