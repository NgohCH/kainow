import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

// 10:00 on 20 November 2026 in UTC+8.
const START = Date.UTC(2026, 10, 20, 2, 0, 0);
const NOT_READER = "Only the project's finance readers can see financial detail.";
const NOT_REQUIRED = 'Financial tracking is not required for this project.';
const HISTORY = 'Financial tracking is not required for this project. Earlier entries are kept here for reference.';
const ENTRY = { spentOn: '2026-11-18', amount: '100.00', currency: 'MYR', description: 'Survey pegs', reference: 'INV-0001' };

describe('spending entries and the finance view over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let deputy: Client;
  let owner: Client;
  let ann: Client;
  let auditor: Client;
  let outsider: Client;
  let ids: Record<string, string>;
  let projectId: string;
  const url = (path = '') => `/projects/${projectId}/finance${path}`;
  const settings = (s: Record<string, unknown>) =>
    t.pool.query(
      `INSERT INTO project_finance_settings (project_id, tracking, currency, members_read, grants_read)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id) DO UPDATE SET tracking = EXCLUDED.tracking, currency = EXCLUDED.currency,
         members_read = EXCLUDED.members_read, grants_read = EXCLUDED.grants_read`,
      [projectId, s.tracking ?? 'enabled', s.currency ?? 'MYR', s.membersRead ?? false, s.grantsRead ?? false],
    );
  /** A change request inserted directly (submitting finance requests arrives with Task 8). */
  const changeRequest = async (kind: string, targetKind: string, targetId: string, terms: unknown, status = 'pending', at = new Date(START)) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $7, $8)`,
      [id, projectId, kind, targetKind, targetId, status, ids.pm, at],
    );
    await t.pool.query(`INSERT INTO change_request_versions (request_id, version, terms, author_id, at) VALUES ($1, 1, $2, $3, $4)`, [id, JSON.stringify(terms), ids.pm, at]);
    return id;
  };

  beforeEach(async () => {
    t = await startTestApp(START);
    ids = {};
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['owner', 'pm', 'deputy', 'ann', 'auditor', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour Survey',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), projectId, ids.auditor, ids.pm, ids.admin],
    );
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    deputy = await t.signIn('deputy@example.org');
    owner = await t.signIn('owner@example.org');
    ann = await t.signIn('ann@example.org');
    auditor = await t.signIn('auditor@example.org');
    outsider = await t.signIn('outsider@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  test('a PM records MYR 100.00: the entry is listed, the spent total is 100.00 and the audit event has the entry id only', async () => {
    await settings({});
    const made = await pm.request('POST', url('/spending'), ENTRY);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const entry = made.body.entry;
    assert.equal(entry.amount, '100.00');
    assert.equal(entry.counted, '100.00');
    assert.equal(entry.currency, 'MYR');
    assert.equal(entry.spentOn, '2026-11-18');
    assert.equal(entry.reference, 'INV-0001');
    assert.deepEqual(entry.recordedBy, { id: ids.pm, name: 'pm' });

    const view = await pm.request('GET', url());
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.tracking, 'enabled');
    assert.equal(view.body.currency, 'MYR');
    assert.equal(view.body.historyOnly, false);
    assert.equal(view.body.figures.spent, '100.00');
    assert.equal(view.body.figures.budget, null);
    assert.equal(view.body.figures.balance, null);
    assert.deepEqual(view.body.figures.warnThresholds, [80, 100]);
    assert.equal(view.body.entries.length, 1);
    assert.equal(view.body.entries[0].id, entry.id);
    assert.deepEqual(view.body.entries[0].adjustments, []);
    assert.equal(view.body.entries[0].pending, null);

    const audit = await t.pool.query(`SELECT actor_user_id, subject_id, detail FROM audit_events WHERE action = 'finance.spending_recorded'`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_user_id, ids.pm);
    assert.deepEqual(audit.rows[0].detail, { entryId: entry.id });
  });

  test('a USD entry on an MYR project is Not in totals until converted; approved adjustments count in approval order', async () => {
    await settings({});
    const usd = (await deputy.request('POST', url('/spending'), { ...ENTRY, amount: '1250', currency: 'USD', description: 'Drone hire' })).body.entry;
    const myr = (await pm.request('POST', url('/spending'), ENTRY)).body.entry;
    let view = await pm.request('GET', url());
    assert.equal(view.body.figures.spent, '100.00');
    assert.deepEqual(view.body.figures.notInTotals, [{ currency: 'USD', amount: '1250.00' }]);
    assert.equal(view.body.entries.find((e: { id: string }) => e.id === usd.id).counted, null);

    // A budget, a conversion, a refund on the MYR entry and a pending correction, inserted as Task 8 would approve them.
    const budgetCr = await changeRequest('set_budget', 'project_budget', projectId, { amount: '6000.00' }, 'authorised');
    await t.pool.query(`INSERT INTO budget_versions (id, project_id, amount, currency, change_request_id, approved_at) VALUES ($1, $2, 6000.00, 'MYR', $3, $4)`, [
      uuidv7(), projectId, budgetCr, new Date(START),
    ]);
    const conv = await changeRequest('finance_adjustment', 'expenditure', usd.id, { kind: 'conversion' }, 'authorised');
    await t.pool.query(
      `INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, rate, rate_on, reason, change_request_id, approved_at)
       VALUES ($1, $2, 'conversion', 5500.00, 4.4, '2026-11-18', 'Rate of the day', $3, $4)`,
      [uuidv7(), usd.id, conv, new Date(START)],
    );
    const refund = await changeRequest('finance_adjustment', 'expenditure', myr.id, { kind: 'refund' }, 'authorised');
    await t.pool.query(
      `INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, refund_on, reason, change_request_id, approved_at)
       VALUES ($1, $2, 'refund', 40.00, '2026-11-19', 'Returned pegs', $3, $4)`,
      [uuidv7(), myr.id, refund, new Date(START + 1000)],
    );
    const pendingId = await changeRequest('finance_adjustment', 'expenditure', myr.id, { kind: 'correction', amount: '90.00' });

    view = await pm.request('GET', url());
    assert.equal(view.body.figures.budget, '6000.00');
    assert.equal(view.body.figures.spent, '5560.00');
    assert.equal(view.body.figures.balance, '440.00');
    assert.equal(view.body.figures.percentUsed, 92);
    assert.equal(view.body.figures.level, 1);
    assert.deepEqual(view.body.figures.notInTotals, []);
    assert.equal(view.body.budgetVersions.length, 1);
    assert.equal(view.body.budgetVersions[0].amount, '6000.00');
    const m = view.body.entries.find((e: { id: string }) => e.id === myr.id);
    assert.equal(m.counted, '60.00');
    assert.equal(m.adjustments.length, 1);
    assert.equal(m.adjustments[0].kind, 'refund');
    assert.equal(m.adjustments[0].amount, '40.00');
    assert.equal(m.pending.id, pendingId);
    assert.deepEqual(m.pending.terms, { kind: 'correction', amount: '90.00' });
    assert.equal(view.body.entries.find((e: { id: string }) => e.id === usd.id).counted, '5500.00');
    assert.deepEqual(
      view.body.pending.map((p: { id: string; kind: string; targetId: string }) => [p.id, p.kind, p.targetId]),
      [[pendingId, 'finance_adjustment', myr.id]],
    );
    assert.deepEqual(view.body.pending[0].submittedBy, { id: ids.pm, name: 'pm' });
  });

  test('a Member reads only with membersRead; a grant holder only with grantsRead; outsiders and a non-participant Administrator get 404', async () => {
    await settings({});
    await pm.request('POST', url('/spending'), ENTRY);
    for (const c of [ann, auditor]) {
      const r = await c.request('GET', url());
      assert.equal(r.status, 403);
      assert.equal(r.body.message, NOT_READER);
    }
    assert.equal((await outsider.request('GET', url())).status, 404);
    assert.equal((await admin.request('GET', url())).status, 404);
    assert.equal((await admin.request('POST', url('/spending'), ENTRY)).status, 404);

    await settings({ membersRead: true });
    const member = await ann.request('GET', url());
    assert.equal(member.status, 200);
    assert.equal(member.body.figures.spent, '100.00');
    assert.equal((await auditor.request('GET', url())).status, 403);

    await settings({ grantsRead: true });
    const grant = await auditor.request('GET', url());
    assert.equal(grant.status, 200);
    assert.equal(grant.body.entries.length, 1);
    assert.equal((await ann.request('GET', url())).status, 403);
  });

  test('only the PM or a Deputy records: an Owner, a Member and a grant holder are refused', async () => {
    await settings({ membersRead: true, grantsRead: true });
    assert.equal((await owner.request('POST', url('/spending'), ENTRY)).status, 403);
    assert.equal((await ann.request('POST', url('/spending'), ENTRY)).status, 403);
    assert.equal((await auditor.request('POST', url('/spending'), ENTRY)).status, 403);
    assert.equal((await outsider.request('POST', url('/spending'), ENTRY)).status, 404);
    assert.equal((await t.pool.query(`SELECT 1 FROM expenditures`)).rows.length, 0);
  });

  test('bad values are refused with 400: amount, currency, dates and text limits', async () => {
    await settings({});
    await t.pool.query(`UPDATE resource_settings SET enabled_currencies = ARRAY['MYR','SGD'] WHERE id`);
    for (const body of [
      { ...ENTRY, amount: '0' },
      { ...ENTRY, amount: '1,000.00' },
      { ...ENTRY, amount: '10.005' },
      { ...ENTRY, amount: 100 },
      { ...ENTRY, currency: 'USD' },
      { ...ENTRY, currency: 'EUR' },
      { ...ENTRY, spentOn: '2026-02-30' },
      { ...ENTRY, spentOn: undefined },
      { ...ENTRY, description: ' ' },
      { ...ENTRY, description: 'x'.repeat(501) },
      { ...ENTRY, reference: 'r'.repeat(101) },
      { ...ENTRY, description: 'key sk-test-' + 'x'.repeat(40) },
    ]) {
      assert.equal((await pm.request('POST', url('/spending'), body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await t.pool.query(`SELECT 1 FROM expenditures`)).rows.length, 0);
    const ok = await pm.request('POST', url('/spending'), { ...ENTRY, amount: '  12.5 ', currency: 'SGD', reference: undefined, description: ' Pegs ' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.entry.amount, '12.50');
    assert.equal(ok.body.entry.reference, '');
    assert.equal(ok.body.entry.description, 'Pegs');
  });

  test('tracking off refuses recording with 409; a reader still sees the entries as history', async () => {
    await settings({});
    await pm.request('POST', url('/spending'), ENTRY);
    await settings({ tracking: 'not_required' });
    const refused = await pm.request('POST', url('/spending'), ENTRY);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, NOT_REQUIRED);
    const view = await pm.request('GET', url());
    assert.equal(view.status, 200);
    assert.equal(view.body.tracking, 'not_required');
    assert.equal(view.body.historyOnly, true);
    assert.equal(view.body.notice, HISTORY);
    assert.equal(view.body.entries.length, 1);
    assert.equal(view.body.figures.spent, '100.00');
  });

  test('a project that never had tracking: recording is refused and the view is history with no figures', async () => {
    assert.equal((await pm.request('POST', url('/spending'), ENTRY)).status, 409);
    const view = await pm.request('GET', url());
    assert.equal(view.status, 200);
    assert.equal(view.body.historyOnly, true);
    assert.equal(view.body.currency, null);
    assert.equal(view.body.figures, null);
    assert.deepEqual(view.body.entries, []);
  });

  test('Deferred refuses recording with the matrix wording', async () => {
    await settings({});
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await pm.request('POST', url('/spending'), ENTRY)).status, 403);
    assert.equal((await pm.request('GET', url())).status, 200);
  });

  test('AI spending this month is shown to the PM (confirmed, uncertain and reserved apart) and absent for a Deputy', async () => {
    await settings({});
    for (const [status, amount] of [
      ['confirmed', 312_400_000],
      ['reserved', 1_000_000],
    ] as const) {
      await t.pool.query(
        `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, actor_user_id, model_id, provider,
                                       input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro,
                                       myr_per_usd_micro, estimate_micro_myr, amount_micro_myr, project_id, ruled)
         VALUES ($1, $2, 1, $3, $3, $4, 'assist', $5, 'm', 'openai', 1, 1, 1, 1, $6, $6, $7, true)`,
        [uuidv7(), uuidv7(), new Date(START), status, ids.pm, amount, projectId],
      );
    }
    const mine = await pm.request('GET', url());
    assert.equal(mine.body.aiSpendThisMonth.confirmedMyr, '312.400000');
    assert.equal(mine.body.aiSpendThisMonth.reservedMyr, '1.000000');
    assert.equal(mine.body.aiSpendThisMonth.uncertainMyr, '0.000000');
    assert.equal(mine.body.aiSpendThisMonth.period.start, '2026-10-31T16:00:00.000Z');
    // Never added in.
    assert.equal(mine.body.figures.spent, '0.00');
    const dep = await deputy.request('GET', url());
    assert.equal(dep.status, 200);
    assert.equal('aiSpendThisMonth' in dep.body, false);
  });

  test('GET /resources carries finance figures for readers with tracking on, and only the tracking value for anyone else', async () => {
    let r = await pm.request('GET', `/projects/${projectId}/resources`);
    assert.deepEqual(r.body.finance, { tracking: 'not_required' });
    await settings({});
    await pm.request('POST', url('/spending'), ENTRY);
    await pm.request('POST', url('/spending'), { ...ENTRY, amount: '20', currency: 'USD' });
    await changeRequest('finance_adjustment', 'expenditure', (await t.pool.query(`SELECT id FROM expenditures WHERE currency = 'USD'`)).rows[0].id, { kind: 'conversion' });
    r = await pm.request('GET', `/projects/${projectId}/resources`);
    assert.equal(r.body.finance.tracking, 'enabled');
    assert.equal(r.body.finance.currency, 'MYR');
    assert.equal(r.body.finance.figures.spent, '100.00');
    assert.equal(r.body.finance.pendingAdjustments, 1);
    assert.deepEqual(r.body.finance.notInTotals, [{ currency: 'USD', amount: '20.00' }]);
    const member = await ann.request('GET', `/projects/${projectId}/resources`);
    assert.equal(member.status, 200);
    assert.deepEqual(member.body.finance, { tracking: 'enabled' });
    const grant = await auditor.request('GET', `/projects/${projectId}/resources`);
    assert.deepEqual(grant.body.finance, { tracking: 'enabled' });
  });
});
