import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

// 10:00 on 20 November 2026 in UTC+8.
const START = Date.UTC(2026, 10, 20, 2, 0, 0);
const TRACKING_OFF = 'Financial tracking is not required for this project, so finance changes cannot be approved.';
const CONVERT_FIRST = 'Convert this entry before correcting or refunding it.';
const ONLY_FOREIGN = 'Only an entry in another currency can be converted.';
const tooMuch = (amount: string) => `A refund cannot be more than the entry's counted amount (${amount}).`;
const ENTRY = { spentOn: '2026-11-18', amount: '100.00', currency: 'MYR', description: 'Survey pegs' };

type Entry = { id: string; counted: string | null; adjustments: Array<{ kind: string; amount: string; rate: string | null; rateOn: string | null; refundOn: string | null; reason: string }> };

describe('spending adjustments through change requests over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let deputy: Client;
  let owner: Client;
  let sponsor: Client;
  let ann: Client;
  let ids: Record<string, string>;
  let projectId: string;
  const url = (path = '') => `/projects/${projectId}/finance${path}`;
  const tracking = (on: boolean) =>
    t.pool.query(
      `INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, $2, 'MYR')
       ON CONFLICT (project_id) DO UPDATE SET tracking = EXCLUDED.tracking`,
      [projectId, on ? 'enabled' : 'not_required'],
    );
  const record = async (over: Partial<typeof ENTRY> = {}) => (await pm.request('POST', url('/spending'), { ...ENTRY, ...over })).body.entry.id as string;
  const adjust = (c: Client, entryId: string, body: Record<string, unknown>) => c.request('POST', url(`/spending/${entryId}/adjust`), { reason: 'Invoice checked', ...body });
  const approve = async (c: Client, id: string, version = 1) => {
    t.clock.advanceSeconds(60);
    return c.request('POST', `/changes/${id}/approve`, { version });
  };
  const view = async () => (await pm.request('GET', url())).body;
  const entry = async (id: string): Promise<Entry> => (await view()).entries.find((e: Entry) => e.id === id);
  /** Proposes and approves; returns the request id. */
  const adjusted = async (entryId: string, body: Record<string, unknown>) => {
    const r = await adjust(pm, entryId, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const a = await approve(owner, r.body.request.id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.request.status, 'authorised');
    return r.body.request.id as string;
  };

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

  test('a correction to 0 voids the entry: totals unchanged until approved, then reduced', async () => {
    const id = await record();
    await record({ amount: '50.00' });
    const r = await adjust(deputy, id, { type: 'correction', amount: '0', reason: 'Duplicate of INV-0001' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.request.kind, 'finance_adjustment');
    assert.deepEqual(r.body.request.target, { kind: 'expenditure', id });
    assert.deepEqual(r.body.request.terms, { type: 'correction', amount: '0.00', reason: 'Duplicate of INV-0001' });
    let v = await view();
    assert.equal(v.figures.spent, '150.00');
    assert.equal(v.entries.find((e: Entry) => e.id === id).counted, '100.00');
    assert.equal(v.pending.length, 1);

    const a = await approve(sponsor, r.body.request.id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    v = await view();
    assert.equal(v.figures.spent, '50.00');
    const e = v.entries.find((x: Entry) => x.id === id);
    assert.equal(e.counted, '0.00');
    assert.deepEqual(e.adjustments.map((x: Entry['adjustments'][0]) => [x.kind, x.amount, x.reason]), [['correction', '0.00', 'Duplicate of INV-0001']]);
    // The original entry is never altered.
    assert.equal(e.amount, '100.00');
    const audit = await t.pool.query(`SELECT actor_user_id, subject_id, detail FROM audit_events WHERE action = 'finance.adjustment_approved'`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_user_id, ids.sponsor);
    assert.deepEqual(Object.keys(audit.rows[0].detail).sort(), ['adjustmentId', 'entryId', 'requestId', 'type']);
  });

  test('a refund equal to the counted amount leaves 0.00; one minor unit above is refused, over HTTP', async () => {
    const id = await record();
    const over = await adjust(pm, id, { type: 'refund', amount: '100.01', refundOn: '2026-11-19' });
    assert.deepEqual([over.status, over.body.message], [409, tooMuch('100.00')]);
    assert.equal((await t.pool.query(`SELECT 1 FROM change_requests`)).rows.length, 0);

    await adjusted(id, { type: 'refund', amount: '30', refundOn: '2026-11-19', reason: 'Returned three pegs' });
    assert.equal((await entry(id)).counted, '70.00');
    const over2 = await adjust(pm, id, { type: 'refund', amount: '70.01', refundOn: '2026-11-19' });
    assert.deepEqual([over2.status, over2.body.message], [409, tooMuch('70.00')]);
    await adjusted(id, { type: 'refund', amount: '70.00', refundOn: '2026-11-20' });
    const e = await entry(id);
    assert.equal(e.counted, '0.00');
    assert.deepEqual(e.adjustments.map((x) => [x.kind, x.amount, x.refundOn]), [['refund', '30.00', '2026-11-19'], ['refund', '70.00', '2026-11-20']]);
    assert.equal((await view()).figures.spent, '0.00');
    const none = await adjust(pm, id, { type: 'refund', amount: '0.01', refundOn: '2026-11-20' });
    assert.deepEqual([none.status, none.body.message], [409, tooMuch('0.00')]);
  });

  test('the refund limit is checked again when approving, against the entry as it is then', async () => {
    const id = await record({ amount: '1500.00' });
    const r = await adjust(pm, id, { type: 'refund', amount: '1200', refundOn: '2026-11-19' });
    assert.equal(r.status, 201);
    // An adjustment approved meanwhile (as another approval in its own transaction would leave it).
    const other = uuidv7();
    await t.pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, 'finance_adjustment', 'expenditure', $3, 1, 1, 'authorised', $4, now())`,
      [other, projectId, id, ids.pm],
    );
    await t.pool.query(
      `INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, reason, change_request_id, approved_at) VALUES ($1, $2, 'correction', 1000.00, 'Discount', $3, $4)`,
      [uuidv7(), id, other, new Date(START + 1000)],
    );
    const a = await approve(owner, r.body.request.id);
    assert.deepEqual([a.status, a.body.message], [409, tooMuch('1,000.00')]);
    assert.equal((await entry(id)).counted, '1000.00');
    const row = (await t.pool.query(`SELECT status FROM change_requests WHERE id = $1`, [r.body.request.id])).rows[0];
    assert.equal(row.status, 'pending', 'the refused approval is rolled back with it');
    assert.equal((await t.pool.query(`SELECT 1 FROM approvals WHERE request_id = $1`, [r.body.request.id])).rows.length, 0);
  });

  test('a foreign entry: convert first; a conversion, a correction, a refund, then a re-conversion that replaces them', async () => {
    const id = await record({ amount: '1250.00', currency: 'USD', description: 'Drone hire' });
    assert.deepEqual((await view()).figures.notInTotals, [{ currency: 'USD', amount: '1250.00' }]);
    for (const body of [{ type: 'correction', amount: '1200' }, { type: 'refund', amount: '10', refundOn: '2026-11-19' }]) {
      const r = await adjust(pm, id, body);
      assert.deepEqual([r.status, r.body.message], [409, CONVERT_FIRST], body.type);
    }
    const r = await adjust(pm, id, { type: 'conversion', amount: '5500.00', rate: '4.40', rateOn: '2026-11-18', reason: 'Rate of the day' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.request.terms, { type: 'conversion', amount: '5500.00', rate: '4.4', rateOn: '2026-11-18', reason: 'Rate of the day' });
    assert.equal((await approve(owner, r.body.request.id)).status, 200);
    let v = await view();
    assert.deepEqual(v.figures.notInTotals, []);
    assert.equal(v.figures.spent, '5500.00');
    let e = v.entries.find((x: Entry) => x.id === id);
    assert.equal(e.counted, '5500.00');
    assert.deepEqual([e.adjustments[0].rate, e.adjustments[0].rateOn], ['4.40000000', '2026-11-18']);

    await adjusted(id, { type: 'correction', amount: '5400' });
    assert.equal((await entry(id)).counted, '5400.00');
    await adjusted(id, { type: 'refund', amount: '400', refundOn: '2026-11-19' });
    assert.equal((await entry(id)).counted, '5000.00');

    // A later conversion fixes the rate: it replaces the correction and refund approved before it.
    await adjusted(id, { type: 'conversion', amount: '5600.00', rate: '4.48', rateOn: '2026-11-19' });
    e = await entry(id);
    assert.equal(e.counted, '5600.00');
    assert.deepEqual(e.adjustments.map((x: { kind: string }) => x.kind), ['conversion', 'correction', 'refund', 'conversion']);
    // The refund limit is now the new converted amount.
    const over = await adjust(pm, id, { type: 'refund', amount: '5600.01', refundOn: '2026-11-20' });
    assert.deepEqual([over.status, over.body.message], [409, tooMuch('5,600.00')]);
    await adjusted(id, { type: 'refund', amount: '5600.00', refundOn: '2026-11-20' });
    assert.equal((await entry(id)).counted, '0.00');
    v = await view();
    assert.equal(v.figures.spent, '0.00');
  });

  test('each validation refusal has its wording', async () => {
    const myr = await record();
    const usd = await record({ currency: 'USD' });
    const cases: Array<[string, Record<string, unknown>, number, string?]> = [
      [myr, { type: 'conversion', amount: '100', rate: '1', rateOn: '2026-11-18' }, 409, ONLY_FOREIGN],
      [usd, { type: 'conversion', amount: '440', rateOn: '2026-11-18' }, 400, 'A conversion needs a rate and the date of the rate.'],
      [usd, { type: 'conversion', amount: '440', rate: '4.4' }, 400, 'A conversion needs a rate and the date of the rate.'],
      [usd, { type: 'conversion', amount: '440', rate: '0', rateOn: '2026-11-18' }, 400, 'Enter a rate above 0 with at most 8 decimal places.'],
      [usd, { type: 'conversion', amount: '440', rate: '4.4', rateOn: '18/11/2026' }, 400, 'Enter the date as YYYY-MM-DD.'],
      [usd, { type: 'conversion', amount: '440', rate: '4.4', rateOn: '0000-11-18' }, 400, 'Enter the date as YYYY-MM-DD.'],
      [myr, { type: 'refund', amount: '10', refundOn: '0000-01-01', reason: 'Returned' }, 400, 'Enter the date as YYYY-MM-DD.'],
      [usd, { type: 'conversion', amount: '0', rate: '4.4', rateOn: '2026-11-18' }, 400, 'Enter an amount above 0.'],
      [myr, { type: 'refund', amount: '10' }, 400, 'A refund needs the date of the refund.'],
      [myr, { type: 'refund', amount: '0', refundOn: '2026-11-18' }, 400, 'Enter an amount above 0.'],
      [myr, { type: 'correction', amount: '1.005' }, 400, 'Enter an amount with at most 2 decimal places.'],
      [myr, { type: 'void', amount: '0' }, 400, 'Choose a correction, a refund or a conversion.'],
      [myr, { type: 'correction', amount: '10', reason: ' ' }, 400, 'Give a reason for the change (up to 1,000 characters).'],
      [myr, { type: 'correction', amount: '10', reason: 'key sk-test-' + 'x'.repeat(40) }, 400],
    ];
    for (const [id, body, status, message] of cases) {
      const r = await adjust(pm, id, body);
      assert.equal(r.status, status, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      if (message) assert.equal(r.body.message, message, JSON.stringify(body));
    }
    assert.equal((await adjust(pm, uuidv7(), { type: 'correction', amount: '1' })).status, 404);
    assert.equal((await t.pool.query(`SELECT 1 FROM change_requests`)).rows.length, 0);
    // One waiting adjustment per entry.
    assert.equal((await adjust(pm, myr, { type: 'correction', amount: '90' })).status, 201);
    const second = await adjust(deputy, myr, { type: 'correction', amount: '80' });
    assert.deepEqual([second.status, second.body.message], [409, 'This spending entry already has a change waiting for authorisation.']);
  });

  test('an entry of another project is not found', async () => {
    const otherProject = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    await t.pool.query(`INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, 'enabled', 'MYR')`, [otherProject]);
    const there = (await pm.request('POST', `/projects/${otherProject}/finance/spending`, ENTRY)).body.entry.id;
    assert.equal((await adjust(pm, there, { type: 'correction', amount: '1' })).status, 404);
  });

  test('only the PM or a Deputy proposes an adjustment: an Owner, a Sponsor and a Member get 403', async () => {
    const id = await record();
    for (const c of [owner, sponsor, ann]) {
      const r = await adjust(c, id, { type: 'correction', amount: '90' });
      assert.equal(r.status, 403, JSON.stringify(r.body));
    }
    const generic = await owner.request('POST', `/projects/${projectId}/changes`, {
      kind: 'finance_adjustment', targetKind: 'expenditure', targetId: id, terms: { type: 'correction', amount: '90', reason: 'x' }, approve: true,
    });
    assert.equal(generic.status, 403, 'nor through the generic route');
    assert.equal((await t.pool.query(`SELECT 1 FROM change_requests`)).rows.length, 0);
  });

  test('reject, withdraw and revise behave as for other kinds', async () => {
    const id = await record();
    const r = await adjust(pm, id, { type: 'correction', amount: '90' });
    const revised = await pm.request('POST', `/changes/${r.body.request.id}/revise`, { terms: { type: 'correction', amount: '95', reason: 'Credit note' }, reason: 'Credit note' });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.deepEqual(revised.body.request.terms, { type: 'correction', amount: '95.00', reason: 'Credit note' });
    const badRevise = await pm.request('POST', `/changes/${r.body.request.id}/revise`, { terms: { type: 'refund', amount: '101', refundOn: '2026-11-19', reason: 'x' }, reason: 'x' });
    assert.deepEqual([badRevise.status, badRevise.body.message], [409, tooMuch('100.00')]);
    const rejected = await owner.request('POST', `/changes/${r.body.request.id}/reject`, { reason: 'Keep the invoice amount' });
    assert.equal(rejected.body.request.status, 'rejected');
    const w = await adjust(deputy, id, { type: 'correction', amount: '80' });
    assert.equal((await pm.request('POST', `/changes/${w.body.request.id}/withdraw`, { reason: 'Wrong entry' })).status, 200);
    assert.equal((await entry(id)).counted, '100.00');
    assert.equal((await t.pool.query(`SELECT 1 FROM expenditure_adjustments`)).rows.length, 0);
  });

  test('tracking off: approval is refused with the exact wording, proposing is refused, and withdraw works', async () => {
    const id = await record();
    const r = await adjust(pm, id, { type: 'correction', amount: '90' });
    await tracking(false);
    const a = await approve(owner, r.body.request.id);
    assert.deepEqual([a.status, a.body.message], [409, TRACKING_OFF]);
    const row = (await owner.request('GET', `/projects/${projectId}/changes?status=pending`)).body.requests.find((x: { id: string }) => x.id === r.body.request.id);
    assert.deepEqual([row.mayApprove, row.why], [false, TRACKING_OFF]);
    const w = await pm.request('POST', `/changes/${r.body.request.id}/withdraw`, { reason: 'Tracking turned off' });
    assert.equal(w.status, 200);
    const again = await adjust(pm, id, { type: 'correction', amount: '90' });
    assert.deepEqual([again.status, again.body.message], [409, 'Financial tracking is not required for this project.']);
    assert.equal((await t.pool.query(`SELECT 1 FROM expenditure_adjustments`)).rows.length, 0);
  });

  test('Deferred: submit and approve are both refused', async () => {
    const id = await record();
    const r = await adjust(pm, id, { type: 'correction', amount: '90' });
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    const a = await approve(owner, r.body.request.id);
    assert.deepEqual([a.status, a.body.message], [409, 'This change cannot be approved while the project is Deferred.']);
    assert.equal((await pm.request('POST', `/changes/${r.body.request.id}/withdraw`, { reason: 'Paused' })).status, 200);
    const s = await adjust(pm, id, { type: 'correction', amount: '90' });
    assert.equal(s.status, 403, JSON.stringify(s.body));
    assert.equal((await entry(id)).counted, '100.00');
  });
});
