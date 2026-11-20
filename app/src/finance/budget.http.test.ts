import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

// 10:00 on 20 November 2026 in UTC+8.
const START = Date.UTC(2026, 10, 20, 2, 0, 0);
const TRACKING_OFF = 'Financial tracking is not required for this project, so finance changes cannot be approved.';
const NOT_REQUIRED = 'Financial tracking is not required for this project.';
const MISSING = 'The project is missing a required role, so proposals cannot be approved until it is repaired.';
const STALE = 'This change was revised; review the new version.';

describe('the budget through change requests over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let deputy: Client;
  let owner: Client;
  let sponsor: Client;
  let ann: Client;
  let ids: Record<string, string>;
  let projectId: string;
  const url = (path = '') => `/projects/${projectId}/finance${path}`;
  const tracking = (on: boolean, currency = 'MYR') =>
    t.pool.query(
      `INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, $2, $3)
       ON CONFLICT (project_id) DO UPDATE SET tracking = EXCLUDED.tracking, currency = EXCLUDED.currency`,
      [projectId, on ? 'enabled' : 'not_required', currency],
    );
  const propose = (c: Client, amount: unknown, reason: unknown = 'Approved scope for phase one') => c.request('POST', url('/budget'), { amount, reason });
  const approve = (c: Client, id: string, version = 1) => c.request('POST', `/changes/${id}/approve`, { version });
  const budget = async () => (await pm.request('GET', url())).body.figures.budget as string | null;
  const setCount = (n: number) => t.pool.query(`UPDATE approval_policy SET required = $1`, [n]);
  const listed = async (c: Client, id: string) => (await c.request('GET', `/projects/${projectId}/changes`)).body.requests.find((r: { id: string }) => r.id === id);

  beforeEach(async () => {
    t = await startTestApp(START);
    ids = {};
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'deputy', 'owner', 'sponsor', 'ann']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour Survey',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    pm = await t.signIn('pm@example.org');
    deputy = await t.signIn('deputy@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    ann = await t.signIn('ann@example.org');
    await tracking(true);
  });
  afterEach(async () => {
    await t?.close();
  });

  test('a PM proposes 120,000.00: Not provided until an Owner approves, then 120000.00 in the reporting currency', async () => {
    const r = await propose(pm, '120000.00');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.request.status, 'pending');
    assert.equal(r.body.request.kind, 'set_budget');
    assert.deepEqual(r.body.request.target, { kind: 'project_budget', id: projectId });
    assert.deepEqual(r.body.request.terms, { amount: '120000.00', currency: 'MYR', reason: 'Approved scope for phase one' });
    assert.equal(await budget(), null);
    const pending = (await pm.request('GET', url())).body.pending;
    assert.deepEqual(pending.map((p: { id: string; kind: string }) => [p.id, p.kind]), [[r.body.request.id, 'set_budget']]);

    t.clock.advanceSeconds(60);
    const a = await approve(owner, r.body.request.id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.request.status, 'authorised');
    assert.equal(await budget(), '120000.00');
    const view = (await pm.request('GET', url())).body;
    assert.deepEqual(
      view.budgetVersions.map((v: { amount: string; currency: string; changeRequestId: string }) => [v.amount, v.currency, v.changeRequestId]),
      [['120000.00', 'MYR', r.body.request.id]],
    );
    assert.deepEqual(view.pending, []);
    const audit = await t.pool.query(`SELECT actor_user_id, subject_id, detail FROM audit_events WHERE action = 'finance.budget_approved'`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_user_id, ids.owner);
    assert.equal(audit.rows[0].subject_id, projectId);
    assert.equal(audit.rows[0].detail.requestId, r.body.request.id);
  });

  test('a Deputy may propose; an Owner proposing alone with a policy of 1 is authorised at once; an explicit 0 is a budget', async () => {
    assert.equal((await propose(deputy, '5000')).status, 201);
    const id = (await pm.request('GET', url())).body.pending[0].id;
    assert.equal((await pm.request('POST', `/changes/${id}/withdraw`, { reason: 'Owner will set it' })).status, 200);

    const r = await propose(owner, '75000.5');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.request.status, 'authorised');
    assert.equal(await budget(), '75000.50');

    t.clock.advanceSeconds(60);
    const zero = await propose(sponsor, '0');
    assert.equal(zero.status, 201, JSON.stringify(zero.body));
    assert.equal(zero.body.request.status, 'authorised');
    assert.equal(await budget(), '0.00');
    assert.equal((await pm.request('GET', url())).body.budgetVersions.length, 2);
  });

  test('with a policy of 2 an Owner and a Sponsor are needed, and the same person twice does not count', async () => {
    await setCount(2);
    const r = await propose(owner, '120000');
    assert.equal(r.status, 201);
    assert.equal(r.body.request.status, 'pending');
    assert.equal(r.body.request.requiredApprovals, 2);
    assert.equal(r.body.request.approvals.length, 1);
    const again = await approve(owner, r.body.request.id);
    assert.equal(again.status, 200);
    assert.equal(again.body.request.status, 'pending');
    assert.equal(again.body.request.approvals.length, 1);
    assert.equal(await budget(), null);
    t.clock.advanceSeconds(60);
    const second = await approve(sponsor, r.body.request.id);
    assert.equal(second.status, 200);
    assert.equal(second.body.request.status, 'authorised');
    assert.equal(await budget(), '120000.00');
  });

  test('D03: a vacant required role in an Active project blocks approval', async () => {
    const r = await propose(pm, '1000');
    await t.pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $2 WHERE project_id = $1 AND user_id = $3`, [projectId, ids.owner, ids.ann]);
    const a = await approve(owner, r.body.request.id);
    assert.deepEqual([a.status, a.body.message], [409, MISSING]);
    const self = await propose(sponsor, '2000');
    assert.deepEqual([self.status, self.body.message], [409, MISSING], 'nor may an Owner or Sponsor approve by submitting');
    assert.equal(await budget(), null);
  });

  test('reject, withdraw and revise behave as for other kinds', async () => {
    const r = await propose(pm, '1000');
    const id = r.body.request.id;
    assert.equal((await propose(deputy, '2000')).status, 409, 'one waiting budget at a time');

    const revised = await pm.request('POST', `/changes/${id}/revise`, { terms: { amount: '1500', reason: 'Added the survey boat' }, reason: 'Added the survey boat' });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.request.version, 2);
    assert.deepEqual(revised.body.request.terms, { amount: '1500.00', currency: 'MYR', reason: 'Added the survey boat' });
    assert.equal((await deputy.request('POST', `/changes/${id}/revise`, { terms: { amount: '1', reason: 'x' }, reason: 'x' })).status, 403);
    assert.equal((await pm.request('POST', `/changes/${id}/revise`, { terms: { amount: '1.001', reason: 'x' }, reason: 'x' })).status, 400);

    const stale = await approve(owner, id, 1);
    assert.deepEqual([stale.status, stale.body.message], [409, STALE]);
    const rejected = await owner.request('POST', `/changes/${id}/reject`, { reason: 'Too high for this phase' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.request.status, 'rejected');
    assert.equal(rejected.body.request.outcomeReason, 'Too high for this phase');

    const w = await propose(deputy, '900');
    assert.equal((await ann.request('POST', `/changes/${w.body.request.id}/withdraw`, { reason: 'x' })).status, 403);
    const withdrawn = await pm.request('POST', `/changes/${w.body.request.id}/withdraw`, { reason: 'Waiting for quotes' });
    assert.equal(withdrawn.status, 200, 'the PM may withdraw a Deputy’s proposal');
    assert.equal(withdrawn.body.request.status, 'withdrawn');
    assert.equal((await approve(owner, w.body.request.id)).status, 409);
    assert.equal(await budget(), null);
    assert.equal((await t.pool.query(`SELECT 1 FROM budget_versions`)).rows.length, 0);
  });

  test('bad amounts, a missing reason and people who cannot propose are refused', async () => {
    for (const amount of ['-1', '1.234', '1,000', 1000, '', undefined, '1000000000000']) {
      const r = await propose(pm, amount);
      assert.equal(r.status, 400, `${String(amount)}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await propose(pm, '10', ' ')).status, 400);
    const member = await propose(ann, '10');
    assert.equal(member.status, 403);
    assert.equal((await t.pool.query(`SELECT 1 FROM change_requests`)).rows.length, 0);
  });

  test('tracking off: proposing is refused, approval is refused with the exact wording, and withdraw works', async () => {
    const r = await propose(pm, '1000');
    await tracking(false);
    const a = await approve(owner, r.body.request.id);
    assert.deepEqual([a.status, a.body.message], [409, TRACKING_OFF]);
    const row = await listed(owner, r.body.request.id);
    assert.equal(row.why, TRACKING_OFF);
    assert.equal(row.mayApprove, false);
    assert.equal(row.status, 'pending');

    const w = await pm.request('POST', `/changes/${r.body.request.id}/withdraw`, { reason: 'Tracking turned off' });
    assert.equal(w.status, 200);
    assert.equal(w.body.request.status, 'withdrawn');
    const refused = await propose(deputy, '2000');
    assert.deepEqual([refused.status, refused.body.message], [409, NOT_REQUIRED]);
    const self = await propose(owner, '2000');
    assert.deepEqual([self.status, self.body.message], [409, NOT_REQUIRED]);
    assert.equal((await t.pool.query(`SELECT 1 FROM change_requests`)).rows.length, 1);

    // Turned back on: a budget left waiting from before can be approved.
    await tracking(true);
    const later = await propose(pm, '3000');
    await tracking(false);
    assert.equal((await listed(owner, later.body.request.id)).mayApprove, false);
    await tracking(true);
    const row2 = await listed(owner, later.body.request.id);
    assert.deepEqual([row2.mayApprove, row2.why], [true, null]);
    assert.equal((await approve(owner, later.body.request.id)).status, 200);
    assert.equal(await budget(), '3000.00');
  });

  test('the budget takes the reporting currency as it is when approved', async () => {
    const r = await propose(pm, '1000');
    await tracking(true, 'SGD');
    assert.equal((await approve(owner, r.body.request.id)).status, 200);
    const v = (await pm.request('GET', url())).body.budgetVersions;
    assert.equal(v[0].currency, 'SGD');
  });

  test('Deferred: submitting and approving are both refused', async () => {
    const r = await propose(pm, '1000');
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    const a = await approve(owner, r.body.request.id);
    assert.deepEqual([a.status, a.body.message], [409, 'This change cannot be approved while the project is Deferred.']);
    assert.equal((await pm.request('POST', `/changes/${r.body.request.id}/withdraw`, { reason: 'Paused' })).status, 200);
    const s = await propose(owner, '1000');
    assert.equal(s.status, 403, JSON.stringify(s.body));
    assert.equal(await budget(), null);
  });
});
