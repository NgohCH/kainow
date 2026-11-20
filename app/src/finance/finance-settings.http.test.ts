import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const NOT_DELEGATED = "Your organisation's Administrator manages finance settings for projects.";
const FIXED = 'The reporting currency is fixed once figures exist.';
const ENABLE = { tracking: 'enabled', currency: 'MYR', reason: 'Tracking agreed with the Sponsor' };

describe('project finance settings over HTTP', { skip: SKIP_NO_DB }, () => {
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
  const url = (id = projectId) => `/projects/${id}/settings/finance`;
  const delegate = (on: boolean) =>
    t.pool.query(`UPDATE resource_settings SET projects_may_manage_finance = $1 WHERE id`, [on]);
  const changes = async () => (await t.pool.query(`SELECT * FROM project_finance_changes WHERE project_id = $1 ORDER BY at, id`, [projectId])).rows;

  beforeEach(async () => {
    t = await startTestApp();
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

  test('a delegated PM enables tracking with MYR; the change records the reason and both full settings', async () => {
    const before = await pm.request('GET', url());
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.settings, { tracking: 'not_required', currency: null, warnFirstPct: null, warnSecondPct: null, membersRead: false, grantsRead: false });
    assert.equal(before.body.editable, true);
    assert.equal(before.body.delegated, true);
    assert.equal(before.body.currencyFixed, false);

    const saved = await pm.request('PUT', url(), ENABLE);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.settings.tracking, 'enabled');
    assert.equal(saved.body.settings.currency, 'MYR');
    assert.equal(saved.body.changes.length, 1);
    assert.equal(saved.body.changes[0].reason, 'Tracking agreed with the Sponsor');

    const rows = await changes();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, ids.pm);
    assert.deepEqual(rows[0].previous, { tracking: 'not_required', currency: null, warnFirstPct: null, warnSecondPct: null, membersRead: false, grantsRead: false });
    assert.deepEqual(rows[0].next, { tracking: 'enabled', currency: 'MYR', warnFirstPct: null, warnSecondPct: null, membersRead: false, grantsRead: false });
    const audit = await t.pool.query(`SELECT * FROM audit_events WHERE action = 'finance.project_settings_changed'`);
    assert.equal(audit.rows.length, 1);
  });

  test('with delegation off the PM gets 403 with the wording; a non-participant Administrator changes it', async () => {
    await delegate(false);
    const got = await pm.request('GET', url());
    assert.equal(got.body.editable, false);
    assert.equal(got.body.delegated, false);
    const refused = await pm.request('PUT', url(), ENABLE);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, NOT_DELEGATED);
    assert.equal((await changes()).length, 0);

    const adminView = await admin.request('GET', url());
    assert.equal(adminView.status, 200);
    assert.equal(adminView.body.editable, true);
    const saved = await admin.request('PUT', url(), { ...ENABLE, reason: 'Set by the Administrator' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await changes())[0].actor_id, ids.admin);
  });

  test('a Deputy, a Member and an Audit holder read the settings but cannot edit; an outsider gets 404', async () => {
    for (const c of [deputy, ann, auditor]) {
      const r = await c.request('GET', url());
      assert.equal(r.status, 200);
      assert.equal(r.body.editable, false);
    }
    const d = await deputy.request('PUT', url(), ENABLE);
    assert.equal(d.status, 403);
    assert.equal((await ann.request('PUT', url(), ENABLE)).status, 403);
    assert.equal((await auditor.request('PUT', url(), ENABLE)).status, 403);
    assert.equal((await outsider.request('GET', url())).status, 404);
    assert.equal((await outsider.request('PUT', url(), ENABLE)).status, 404);
    assert.equal((await outsider.request('GET', `${url()}/preview`)).status, 404);
    assert.equal((await changes()).length, 0);
  });

  test('the change history (reasons, previous and next) goes to finance readers and the Administrator only', async () => {
    assert.equal((await pm.request('PUT', url(), { ...ENABLE, reason: 'Private reason for the change' })).status, 200);
    for (const c of [pm, deputy, owner, admin]) {
      const r = await c.request('GET', url());
      assert.equal(r.status, 200);
      assert.equal(r.body.changes.length, 1);
      assert.equal(r.body.changes[0].reason, 'Private reason for the change');
    }
    for (const c of [ann, auditor]) {
      const r = await c.request('GET', url());
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.changes, []);
      assert.doesNotMatch(JSON.stringify(r.body), /Private reason/);
    }
    // Widened readers see it too.
    assert.equal((await pm.request('PUT', url(), { membersRead: true, grantsRead: true, reason: 'Widen readers' })).status, 200);
    for (const c of [ann, auditor]) assert.equal((await c.request('GET', url())).body.changes.length, 2);
  });

  test('Deferred refuses changes, even for the Administrator, and editable is false', async () => {
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await pm.request('GET', url())).body.editable, false);
    assert.equal((await admin.request('GET', url())).body.editable, false);
    assert.equal((await pm.request('PUT', url(), ENABLE)).status, 403);
    assert.equal((await admin.request('PUT', url(), ENABLE)).status, 403);
    assert.equal((await changes()).length, 0);
  });

  test('enabling without a currency, with a disabled or unknown currency, or with bad values is a 400', async () => {
    await t.pool.query(`UPDATE resource_settings SET enabled_currencies = ARRAY['MYR','SGD'] WHERE id`);
    for (const body of [
      { tracking: 'enabled', reason: 'r' },
      { tracking: 'enabled', currency: null, reason: 'r' },
      { tracking: 'enabled', currency: 'USD', reason: 'r' },
      { tracking: 'enabled', currency: 'EUR', reason: 'r' },
      { tracking: 'on', currency: 'MYR', reason: 'r' },
      { ...ENABLE, membersRead: 'yes' },
      { ...ENABLE, reason: ' ' },
      { tracking: 'enabled', currency: 'MYR' },
      { ...ENABLE, reason: 'key sk-test-' + 'x'.repeat(40) },
    ]) {
      assert.equal((await pm.request('PUT', url(), body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await changes()).length, 0);
    assert.equal((await pm.request('PUT', url(), { ...ENABLE, currency: 'SGD' })).status, 200);
  });

  test('thresholds inherit the organisation’s or are the project’s own, within D93', async () => {
    await pm.request('PUT', url(), ENABLE);
    let r = await pm.request('GET', url());
    assert.deepEqual(r.body.effective, { thresholds: [80, 100], inherited: true });

    for (const [a, b] of [
      [0, 100],
      [80, 201],
      [100, 100],
      [90, 80],
      [80.5, 100],
      [80, null],
      [null, 100],
    ]) {
      assert.equal((await pm.request('PUT', url(), { warnFirstPct: a, warnSecondPct: b, reason: 'r' })).status, 400, `${a} ${b}`);
    }
    r = await pm.request('PUT', url(), { warnFirstPct: 60, warnSecondPct: 150, reason: 'Tighter early warning' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.effective, { thresholds: [60, 150], inherited: false });

    await t.pool.query(`UPDATE resource_settings SET warn_first_pct = 70, warn_second_pct = 90 WHERE id`);
    r = await pm.request('PUT', url(), { warnFirstPct: null, warnSecondPct: null, reason: 'Back to the organisation’s' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.effective, { thresholds: [70, 90], inherited: true });
    assert.equal((await changes()).length, 3);
  });

  test('an unchanged save is refused with Nothing to change and writes no history', async () => {
    await pm.request('PUT', url(), ENABLE);
    const again = await pm.request('PUT', url(), ENABLE);
    assert.equal(again.status, 400);
    assert.equal(again.body.message, 'Nothing to change.');
    assert.equal((await changes()).length, 1);
  });

  test('readers can be widened to Members and grant holders', async () => {
    const r = await owner.request('PUT', url(), { ...ENABLE, membersRead: true, grantsRead: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.membersRead, true);
    assert.equal(r.body.settings.grantsRead, true);
  });

  test('currency fixed while a budget request is pending', async () => {
    await pm.request('PUT', url(), ENABLE);
    await t.pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, 'set_budget', 'project_budget', $2, 1, 1, 'pending', $3, now())`,
      [uuidv7(), projectId, ids.pm],
    );
    assert.equal((await pm.request('GET', url())).body.currencyFixed, true);
    const refused = await pm.request('PUT', url(), { currency: 'SGD', reason: 'Wrong currency' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, FIXED);
    // Other settings still change, and turning tracking off keeps the currency.
    const off = await pm.request('PUT', url(), { tracking: 'not_required', reason: 'Not needed now' });
    assert.equal(off.status, 200);
    assert.equal(off.body.settings.currency, 'MYR');
  });

  test('currency fixed once spending is recorded; the currency changes freely before', async () => {
    await pm.request('PUT', url(), ENABLE);
    assert.equal((await pm.request('PUT', url(), { currency: 'SGD', reason: 'Changed before any figures' })).status, 200);
    await t.pool.query(
      `INSERT INTO expenditures (id, project_id, spent_on, amount, currency, description, recorded_by, recorded_at)
       VALUES ($1, $2, '2026-11-05', 10.00, 'SGD', 'Survey pegs', $3, now())`,
      [uuidv7(), projectId, ids.pm],
    );
    const refused = await pm.request('PUT', url(), { currency: 'MYR', reason: 'Back' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, FIXED);
  });

  test('the turn-off preview returns counts only, to finance readers and the Administrator', async () => {
    await pm.request('PUT', url(), ENABLE);
    await t.pool.query(
      `INSERT INTO expenditures (id, project_id, spent_on, amount, currency, description, recorded_by, recorded_at)
       VALUES ($1, $2, '2026-11-05', 10.00, 'MYR', 'Survey pegs', $3, now()), ($4, $2, '2026-11-06', 25.50, 'MYR', 'Boat hire', $3, now())`,
      [uuidv7(), projectId, ids.pm, uuidv7()],
    );
    await t.pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, 'set_budget', 'project_budget', $2, 1, 1, 'pending', $3, now())`,
      [uuidv7(), projectId, ids.pm],
    );
    for (const c of [pm, admin]) {
      const r = await c.request('GET', `${url()}/preview`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { entries: 2, budgetVersions: 0, pending: 1 });
    }
    assert.equal((await ann.request('GET', `${url()}/preview`)).status, 403);
  });
});
