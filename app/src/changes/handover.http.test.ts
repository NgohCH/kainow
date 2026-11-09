import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const NOT_ACTIVE = 'The receiving project must be active.';
const WAITING = 'Hand-over waiting for acceptance';

describe('handing a risk to another project at closure', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let owner: Client;
  let rOwner: Client;
  let rSponsor: Client;
  let rPm: Client;
  let stranger: Client;
  const ids: Record<string, string> = {};
  let origin: string;
  let receiver: string;
  let riskId: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'sponsor', 'rpm', 'rowner', 'rsponsor', 'rann', 'stranger']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    origin = await seedProject(t.pool, {
      status: 'active',
      name: 'Records Upgrade',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
      ],
    });
    receiver = await seedProject(t.pool, {
      status: 'active',
      name: 'Records Operations',
      members: [
        { userId: ids.rpm, role: 'pm' },
        { userId: ids.rowner, role: 'owner' },
        { userId: ids.rsponsor, role: 'sponsor' },
        { userId: ids.rann, role: 'member' },
        { userId: ids.owner, role: 'member' },
        { userId: ids.pm, role: 'member' },
      ],
    });
    owner = await t.signIn('owner@example.org');
    rOwner = await t.signIn('rowner@example.org');
    rSponsor = await t.signIn('rsponsor@example.org');
    rPm = await t.signIn('rpm@example.org');
    stranger = await t.signIn('stranger@example.org');
    await (await t.signIn('admin@example.org')).request('POST', '/domains', { domain: 'example.org' });
    riskId = await risk();
  });
  afterEach(async () => {
    await t?.close();
  });

  const risk = async (projectId = origin) => {
    const id = uuidv7();
    const proposal = uuidv7();
    await t.pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', 'R', $3, now())`, [proposal, projectId, ids.owner]);
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, status, responsible_id, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'Supplier may withdraw', 'high', 'open', $3, $4, $3, now())`,
      [id, projectId, ids.owner, proposal],
    );
    return id;
  };
  const dispose = (c: Client, disposition: string, extra: object = {}, recordId = riskId) =>
    c.request('POST', `/projects/${origin}/closure/dispositions`, { recordKind: 'risk', recordId, disposition, reason: 'Operations will own it', ...extra });
  const offer = (c: Client = owner, to = receiver) => dispose(c, 'handover', { handoverProjectId: to });
  const close = (c: Client) => c.request('POST', `/projects/${origin}/transition`, { to: 'closed', reason: 'Finished', outcome: 'partially_delivered' });
  const incoming = async (c: Client) => (await c.request('GET', `/projects/${receiver}/changes`)).body.requests as Array<Record<string, any>>;
  const accept = async (c: Client, terms?: object) => {
    const [r] = await incoming(c);
    return c.request('POST', `/changes/${r.id}/approve`, { version: r.version, ...(terms ? { terms } : {}) });
  };
  const terms = () => ({ responsibleId: ids.rann, reviewOn: '2026-12-01' });
  const risksOf = async (c: Client, projectId: string) => (await c.request('GET', `/projects/${projectId}/records`)).body.risks as Array<Record<string, any>>;

  test('the receiving Owner accepts with a responsible person and review date, creating a linked risk', async () => {
    const made = await offer();
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.request.status, 'pending');
    const waiting = await incoming(rOwner);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].kind, 'risk_handover');
    assert.equal(waiting[0].status, 'pending');
    assert.deepEqual(waiting[0].terms, { fromProjectId: origin });
    assert.equal(waiting[0].offer.fromProject.name, 'Records Upgrade');
    assert.equal(waiting[0].offer.risk.description, 'Supplier may withdraw');
    assert.equal(waiting[0].mayApprove, true);

    t.clock.advanceSeconds(60);
    const done = await accept(rOwner, terms());
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.request.status, 'authorised');
    assert.equal(done.body.applied.record.kind, 'risk');

    const created = (await risksOf(rOwner, receiver)).find((r) => r.id === done.body.applied.record.id) as Record<string, any>;
    assert.equal(created.description, 'Supplier may withdraw');
    assert.equal(created.severity, 'high');
    assert.equal(created.status, 'open');
    assert.equal(created.reviewOn, '2026-12-01');
    assert.equal(created.responsible.id, ids.rann);
    assert.deepEqual(created.handedOverFrom, { projectId: origin, name: 'Records Upgrade' });
    const was = (await risksOf(owner, origin)).find((r) => r.id === riskId) as Record<string, any>;
    assert.deepEqual(was.handedOverTo, { projectId: receiver, name: 'Records Operations' });

    const events = (await t.pool.query(`SELECT record_id, kind FROM record_events WHERE kind LIKE 'handed_over%' ORDER BY kind`)).rows;
    assert.deepEqual(events, [
      { record_id: created.id, kind: 'handed_over_from' },
      { record_id: riskId, kind: 'handed_over_to' },
    ]);
    const audit = (await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'risk.handed_over'`)).rowCount;
    assert.equal(audit, 1);
  });

  test('with a count of 2 the second approver accepting on the same terms completes it', async () => {
    const admin = await t.signIn('admin@example.org');
    assert.equal((await admin.request('POST', '/approval-policy', { required: 2, reason: 'Two sets of eyes', pending: 'keep' })).status, 200);
    assert.equal((await offer()).status, 201);
    t.clock.advanceSeconds(60);
    const first = await accept(rOwner, terms());
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.request.status, 'pending');
    t.clock.advanceSeconds(60);
    const second = await accept(rSponsor, terms());
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.request.status, 'authorised', 'the same terms are not a revision, so the first approval stands');
    assert.equal((await risksOf(rOwner, receiver)).length, 1);
  });

  test('closing waits for the hand-over', async () => {
    assert.equal((await offer()).status, 201);
    const refused = await close(owner);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.message, 'Closing needs a disposition for every open item: 1 remain.');
    assert.deepEqual(refused.body.missing, [{ kind: 'risk', id: riskId, why: WAITING }]);
    t.clock.advanceSeconds(60);
    assert.equal((await accept(rOwner, terms())).status, 200);
    const closed = await close(owner);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const view = (await owner.request('GET', `/projects/${origin}/closure`)).body;
    assert.equal(view.readiness.ready, true);
    const [handed] = (await t.pool.query(`SELECT status FROM risks WHERE id = $1`, [riskId])).rows;
    assert.equal(handed.status, 'open', 'the origin risk is not edited by closing');
  });

  test('a decline leaves the origin needing another disposition', async () => {
    assert.equal((await offer()).status, 201);
    const [r] = await incoming(rOwner);
    const declined = await rOwner.request('POST', `/changes/${r.id}/reject`, { reason: 'We have no capacity' });
    assert.equal(declined.status, 200);
    assert.equal(declined.body.request.status, 'rejected');
    const refused = await close(owner);
    assert.equal(refused.status, 409);
    const declinedWhy = 'Declined by the receiving project: We have no capacity';
    assert.deepEqual(refused.body.missing, [{ kind: 'risk', id: riskId, why: declinedWhy }]);
    const shown = (await owner.request('GET', `/projects/${origin}/closure`)).body.items.risks.find((x: { id: string }) => x.id === riskId);
    assert.deepEqual([shown.why, shown.disposition.disposition], [declinedWhy, 'handover'], 'the disposition stays; the closer chooses again');
    t.clock.advanceSeconds(60);
    assert.equal((await dispose(owner, 'final_accept')).status, 201);
    assert.equal((await close(owner)).status, 200);
    assert.equal((await risksOf(rOwner, receiver)).length, 0);
  });

  test("the receiving project's PM cannot withdraw an incoming hand-over", async () => {
    assert.equal((await offer()).status, 201);
    const [r] = await incoming(rPm);
    assert.equal(r.mayWithdraw, false);
    const w = await rPm.request('POST', `/changes/${r.id}/withdraw`, { reason: 'Not ours' });
    assert.deepEqual([w.status, w.body.message], [403, 'Only the person who offered this risk can withdraw the hand-over; the receiving project declines it.']);
    assert.equal((await t.pool.query(`SELECT status FROM change_requests WHERE id = $1`, [r.id])).rows[0].status, 'pending');
  });

  test('the receiving project must be active', async () => {
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [receiver]);
    const refused = await offer();
    assert.deepEqual([refused.status, refused.body.message], [409, NOT_ACTIVE]);
    await t.pool.query(`UPDATE projects SET status = 'active' WHERE id = $1`, [receiver]);
    assert.equal((await offer()).status, 201);
    // It stops being active before the Owner accepts: acceptance waits for it to return.
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [receiver]);
    const blocked = await accept(rOwner, terms());
    assert.deepEqual([blocked.status, blocked.body.message], [409, 'This change cannot be approved while the project is Deferred.']);
    assert.equal((await risksOf(rOwner, receiver)).length, 0);
  });

  test('the receiving project is one the closer can see, and not the project being closed', async () => {
    const hidden = await seedProject(t.pool, { status: 'active', members: [{ userId: ids.rowner, role: 'owner' }] });
    const refused = await offer(owner, hidden);
    assert.equal(refused.status, 404);
    assert.equal((await offer(owner, uuidv7())).status, 404);
    const self = await offer(owner, origin);
    assert.equal(self.status, 409);
    assert.equal(self.body.message, 'Choose a project other than this one.');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM change_requests WHERE kind = 'risk_handover'`)).rows[0].n, 0);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM closure_dispositions`)).rows[0].n, 0);
  });

  test('accepting needs a responsible person and a review date', async () => {
    assert.equal((await offer()).status, 201);
    t.clock.advanceSeconds(60);
    const none = await accept(rOwner);
    assert.equal(none.status, 400);
    assert.equal(none.body.message, 'Choose a responsible person and a review date to accept this risk.');
    const noDate = await accept(rOwner, { responsibleId: ids.rann });
    assert.equal(noDate.status, 400);
    const outsider = await accept(rOwner, { responsibleId: ids.stranger, reviewOn: '2026-12-01' });
    assert.equal(outsider.status, 400);
    assert.equal(outsider.body.message, "Choose the responsible person from the project's people.");
    const past = await accept(rOwner, { responsibleId: ids.rann, reviewOn: '2026-11-08' });
    assert.equal(past.status, 400);
    assert.equal(past.body.message, 'Choose a review date that is not in the past.');
    assert.equal((await risksOf(rOwner, receiver)).length, 0);
    const [r] = await incoming(rOwner);
    assert.equal(r.status, 'pending');
    assert.equal(r.version, 1, 'a refused acceptance leaves no new version');
  });

  test('accepting with terms records a new version, and a count of 2 waits for the second approver', async () => {
    await t.pool.query(`UPDATE approval_policy SET required = 2`);
    assert.equal((await offer()).status, 201);
    t.clock.advanceSeconds(60);
    const first = await accept(rOwner, terms());
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.request.status, 'pending');
    assert.equal(first.body.request.version, 2);
    assert.deepEqual(first.body.request.terms, { fromProjectId: origin, ...terms() });
    t.clock.advanceSeconds(60);
    const second = await accept(rSponsor);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.request.status, 'authorised');
    assert.equal((await risksOf(rOwner, receiver)).length, 1);
  });

  test('changing the disposition withdraws the waiting hand-over, and a handed-over risk cannot be changed', async () => {
    assert.equal((await offer()).status, 201);
    t.clock.advanceSeconds(60);
    assert.equal((await dispose(owner, 'final_accept')).status, 201);
    assert.deepEqual((await incoming(rOwner)).map((r) => r.status), ['withdrawn']);
    t.clock.advanceSeconds(60);
    assert.equal((await offer()).status, 201);
    assert.deepEqual((await incoming(rOwner)).map((r) => r.status).sort(), ['pending', 'withdrawn']);
    t.clock.advanceSeconds(60);
    assert.equal((await accept(rOwner, terms())).status, 200);
    const again = await dispose(owner, 'final_accept');
    assert.deepEqual([again.status, again.body.message], [409, 'This risk has already been handed over.']);
  });

  test('a project Manager prepares the offer only when delegated, and cannot accept it', async () => {
    const pm = await t.signIn('pm@example.org');
    assert.equal((await offer(pm)).status, 403);
    assert.equal((await owner.request('POST', `/projects/${origin}/closure/delegation`, { reason: 'The PM knows it' })).status, 201);
    t.clock.advanceSeconds(60);
    assert.equal((await offer(pm)).status, 201);
    const [r] = await incoming(rPm);
    assert.equal(r.mayApprove, false);
    const refused = await rPm.request('POST', `/changes/${r.id}/approve`, { version: r.version, terms: terms() });
    assert.equal(refused.status, 403);
  });
  test('a Planned project cannot hand a risk over', async () => {
    const planned = await seedProject(t.pool, {
      status: 'planned',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.owner, role: 'owner' }, { userId: ids.sponsor, role: 'sponsor' }],
    });
    const plannedRisk = await risk(planned);
    const refused = await owner.request('POST', `/projects/${planned}/closure/dispositions`, {
      recordKind: 'risk', recordId: plannedRisk, disposition: 'handover', reason: 'Operations will own it', handoverProjectId: receiver,
    });
    assert.deepEqual([refused.status, refused.body.message], [409, 'This change cannot be proposed while the project is Planned.']);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM change_requests WHERE kind = 'risk_handover'`)).rows[0].n, 0);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM closure_dispositions WHERE project_id = $1`, [planned])).rows[0].n, 0);
  });
});
