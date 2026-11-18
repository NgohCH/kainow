import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { effectivePolicy } from './policy';

const ORG = {
  myrPerUsd: 4.1,
  monthlyLimitMyr: 200,
  daily: { mode: 'not_applied' },
  projectsMaySetLimits: false,
  projectsMayManageConnections: false,
  projectCeiling: { mode: 'not_applied' },
  maxAttempts: 3,
  timeoutSeconds: 120,
  concurrency: 2,
};

const LIMITS = {
  monthlyLimitMyr: '40',
  daily: { mode: 'not_applied' },
  maxAttempts: null,
  timeoutSeconds: null,
  reason: 'Budget agreed for this project',
};

describe('organisation AI policy and project limits over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let deputy: Client;
  let owner: Client;
  let ann: Client;
  let outsider: Client;
  let projectId: string;
  const url = (id = projectId) => `/projects/${id}/ai/limits`;
  const putOrg = (patch: Record<string, unknown> = {}) => admin.request('PUT', '/ai/spend-settings', { ...ORG, ...patch });
  const events = async () => (await t.pool.query(`SELECT * FROM project_ai_limit_events WHERE project_id = $1 ORDER BY at, id`, [projectId])).rows;

  beforeEach(async () => {
    t = await startTestApp();
    const ids: Record<string, string> = {};
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['owner', 'pm', 'deputy', 'ann', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    deputy = await t.signIn('deputy@example.org');
    owner = await t.signIn('owner@example.org');
    ann = await t.signIn('ann@example.org');
    outsider = await t.signIn('outsider@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  test('PUT /ai/spend-settings needs maxAttempts, timeoutSeconds and concurrency within the bounds', async () => {
    const { maxAttempts: _a, ...noAttempts } = ORG;
    const { timeoutSeconds: _t, ...noTimeout } = ORG;
    const { concurrency: _c, ...noConcurrency } = ORG;
    for (const body of [
      noAttempts,
      noTimeout,
      noConcurrency,
      { ...ORG, maxAttempts: 6 },
      { ...ORG, maxAttempts: 0 },
      { ...ORG, timeoutSeconds: 29 },
      { ...ORG, timeoutSeconds: 301 },
      { ...ORG, concurrency: 11 },
      { ...ORG, concurrency: 0 },
    ]) {
      assert.equal((await admin.request('PUT', '/ai/spend-settings', body)).status, 400, JSON.stringify(body));
    }
    const ok = await putOrg({ maxAttempts: 5, timeoutSeconds: 30, concurrency: 10 });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.settings.maxAttempts, ok.body.settings.timeoutSeconds, ok.body.settings.concurrency], [5, 30, 10]);
  });

  test('a PM with delegation off gets 403; with it on the change saves and records its reason and both values', async () => {
    await putOrg();
    const refused = await pm.request('PUT', url(), LIMITS);
    assert.equal(refused.status, 403);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM project_ai_limits`)).rows[0].n, 0);
    assert.equal((await pm.request('GET', url())).body.editable, false);

    await putOrg({ projectsMaySetLimits: true });
    assert.equal((await pm.request('GET', url())).body.editable, true);
    const saved = await pm.request('PUT', url(), LIMITS);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.project.monthlyLimitMyr, '40.000000');
    assert.equal(saved.body.project.saved, true);

    t.clock.advanceSeconds(5);
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '45.5', reason: 'Raised after review' })).status, 200);
    const ev = await events();
    assert.equal(ev.length, 2);
    assert.equal(ev[0].reason, 'Budget agreed for this project');
    assert.equal(ev[0].detail.previous, null);
    assert.equal(ev[0].detail.new.monthlyLimitMyr, '40.000000');
    assert.equal(ev[1].reason, 'Raised after review');
    assert.equal(ev[1].detail.previous.monthlyLimitMyr, '40.000000');
    assert.equal(ev[1].detail.new.monthlyLimitMyr, '45.500000');
    assert.ok(ev.every((e) => e.actor_id));
  });

  test('a reason is required and secrets in it are refused; an unchanged save writes no event', async () => {
    await putOrg({ projectsMaySetLimits: true });
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, reason: ' ' })).status, 400);
    const { reason: _r, ...noReason } = LIMITS;
    assert.equal((await pm.request('PUT', url(), noReason)).status, 400);
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, reason: 'key sk-test-' + 'x'.repeat(40) })).status, 400);
    assert.equal((await pm.request('PUT', url(), LIMITS)).status, 200);
    assert.equal((await pm.request('PUT', url(), LIMITS)).status, 200);
    assert.equal((await events()).length, 1);
  });

  test('a blank monthly limit is saved as no allowance, not unlimited; bounds and shapes are checked', async () => {
    await putOrg({ projectsMaySetLimits: true });
    const blank = await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: null });
    assert.equal(blank.status, 200);
    assert.equal(blank.body.project.monthlyLimitMyr, null);
    assert.equal((await t.pool.query(`SELECT monthly_limit_micro_myr FROM project_ai_limits`)).rows[0].monthly_limit_micro_myr, null);
    const { monthlyLimitMyr: _m, ...noMonthly } = LIMITS;
    for (const body of [
      noMonthly,
      { ...LIMITS, daily: undefined },
      { ...LIMITS, daily: { mode: 'limit' } },
      { ...LIMITS, userMonthly: { mode: 'unlimited' } },
      { ...LIMITS, maxAttempts: 6 },
      { ...LIMITS, maxAttempts: undefined },
      { ...LIMITS, timeoutSeconds: 29 },
      { ...LIMITS, timeoutSeconds: 301 },
      { ...LIMITS, monthlyLimitMyr: '-1' },
    ]) {
      assert.equal((await pm.request('PUT', url(), body)).status, 400, JSON.stringify(body));
    }
    const rich = await pm.request('PUT', url(), {
      ...LIMITS,
      daily: { mode: 'limit', limitMyr: '2' },
      userMonthly: { mode: 'limit', limitMyr: null },
    });
    assert.equal(rich.status, 200);
    assert.deepEqual(rich.body.project.daily, { mode: 'limit', limitMyr: '2.000000' });
    assert.deepEqual(rich.body.project.userMonthly, { mode: 'limit', limitMyr: null });
  });

  test('a Deputy, a Member and an outsider cannot change limits; the Deputy and Owner can read them; a Member cannot', async () => {
    await putOrg({ projectsMaySetLimits: true });
    assert.equal((await deputy.request('PUT', url(), LIMITS)).status, 403);
    assert.equal((await ann.request('PUT', url(), LIMITS)).status, 403);
    assert.equal((await outsider.request('PUT', url(), LIMITS)).status, 404);
    assert.equal((await t.anonymous('PUT', url(), LIMITS)).status, 401);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM project_ai_limits`)).rows[0].n, 0);
    const read = await deputy.request('GET', url());
    assert.equal(read.status, 200);
    assert.equal(read.body.editable, false);
    assert.equal((await owner.request('GET', url())).body.editable, true);
    assert.equal((await ann.request('GET', url())).status, 403);
    assert.equal((await outsider.request('GET', url())).status, 404);
    assert.equal((await admin.request('GET', url())).status, 200);
  });

  test("a delegate's monthly limit above the ceiling is refused with the ceiling in MYR; the Administrator is not held to it", async () => {
    await putOrg({ projectsMaySetLimits: true, projectCeiling: { mode: 'limit', limitMyr: '50' } });
    const refused = await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '50.000001' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, "The Administrator's ceiling for a project's monthly AI limit is MYR 50.000000.");
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '50' })).status, 200, 'equal to the ceiling is allowed');
    t.clock.advanceSeconds(5);
    assert.equal((await admin.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '90' })).status, 200);
    const view = (await pm.request('GET', url())).body;
    assert.deepEqual(view.ceiling, { mode: 'limit', limitMyr: '50.000000' });
    assert.equal(view.project.monthlyLimitMyr, '90.000000');
  });

  test("a delegate's attempts or timeout above the organisation's are refused; the Administrator may set any value within the bounds", async () => {
    await putOrg({ projectsMaySetLimits: true, maxAttempts: 2, timeoutSeconds: 60 });
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, maxAttempts: 3 })).status, 403);
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, timeoutSeconds: 61 })).status, 403);
    const lower = await pm.request('PUT', url(), { ...LIMITS, maxAttempts: 1, timeoutSeconds: 45 });
    assert.equal(lower.status, 200);
    assert.deepEqual(lower.body.sources, { maxAttempts: 'project', timeoutSeconds: 'project' });
    t.clock.advanceSeconds(5);
    const high = await admin.request('PUT', url(), { ...LIMITS, maxAttempts: 5, timeoutSeconds: 300, reason: 'Slow provider' });
    assert.equal(high.status, 200);
    assert.deepEqual([high.body.project.maxAttempts, high.body.project.timeoutSeconds], [5, 300]);
    assert.equal((await admin.request('PUT', url(), { ...LIMITS, maxAttempts: 6, reason: 'Too many' })).status, 400);
  });

  test('editing is refused in a Deferred project, for a delegate and for the Administrator', async () => {
    await putOrg({ projectsMaySetLimits: true });
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await pm.request('PUT', url(), LIMITS)).status, 403);
    assert.equal((await admin.request('PUT', url(), LIMITS)).status, 403);
    assert.equal((await pm.request('GET', url())).status, 200, 'reading stays open');
    assert.equal((await pm.request('GET', url())).body.editable, false);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM project_ai_limits`)).rows[0].n, 0);
  });

  test('ceiling lowered below an existing project limit keeps it; delegate cannot change it', async () => {
    await putOrg({ projectsMaySetLimits: true, projectCeiling: { mode: 'limit', limitMyr: '50' } });
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '40' })).status, 200);
    t.clock.advanceSeconds(5);
    // The Administrator turns delegation off and lowers the ceiling below the project's value.
    await putOrg({ projectsMaySetLimits: false, projectCeiling: { mode: 'limit', limitMyr: '10' } });
    const kept = (await pm.request('GET', url())).body;
    assert.equal(kept.project.monthlyLimitMyr, '40.000000', 'the existing value stays in force');
    assert.equal(kept.editable, false);
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '5' })).status, 403, 'a delegate can no longer change it');
    assert.equal((await t.pool.query(`SELECT monthly_limit_micro_myr::text AS m FROM project_ai_limits`)).rows[0].m, '40000000');
    // Even if delegation returns, a delegate cannot raise it to another value above the ceiling.
    await putOrg({ projectsMaySetLimits: true, projectCeiling: { mode: 'limit', limitMyr: '10' } });
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '45' })).status, 403);
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '8' })).status, 200, 'lowering within the ceiling is allowed');
    // The Administrator can still change it whatever the delegation.
    await putOrg({ projectsMaySetLimits: false });
    assert.equal((await admin.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '12', reason: 'Administrator override' })).status, 200);
  });

  test('a delegate may re-save an unchanged above-ceiling monthly limit while changing daily or userMonthly', async () => {
    await putOrg({ projectsMaySetLimits: true, projectCeiling: { mode: 'limit', limitMyr: '50' } });
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '40' })).status, 200);
    t.clock.advanceSeconds(5);
    await putOrg({ projectsMaySetLimits: true, projectCeiling: { mode: 'limit', limitMyr: '10' } });
    const daily = await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '40', daily: { mode: 'limit', limitMyr: '2' }, reason: 'Add a daily limit' });
    assert.equal(daily.status, 200);
    assert.equal(daily.body.project.monthlyLimitMyr, '40.000000');
    assert.deepEqual(daily.body.project.daily, { mode: 'limit', limitMyr: '2.000000' });
    t.clock.advanceSeconds(5);
    const person = await pm.request('PUT', url(), {
      ...LIMITS,
      monthlyLimitMyr: '40',
      daily: { mode: 'limit', limitMyr: '2' },
      userMonthly: { mode: 'limit', limitMyr: '5' },
      reason: 'Add a personal limit',
    });
    assert.equal(person.status, 200);
    assert.deepEqual(person.body.project.userMonthly, { mode: 'limit', limitMyr: '5.000000' });
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, monthlyLimitMyr: '41', daily: { mode: 'limit', limitMyr: '2' } })).status, 403, 'a different value above the ceiling is still refused');
  });

  test('a delegate may re-save unchanged attempts and timeout above a lowered organisation value, but not change them upward', async () => {
    await putOrg({ projectsMaySetLimits: true, maxAttempts: 5, timeoutSeconds: 200 });
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, maxAttempts: 4, timeoutSeconds: 150 })).status, 200);
    t.clock.advanceSeconds(5);
    await putOrg({ projectsMaySetLimits: true, maxAttempts: 2, timeoutSeconds: 60 });
    const resave = await pm.request('PUT', url(), { ...LIMITS, maxAttempts: 4, timeoutSeconds: 150, daily: { mode: 'limit', limitMyr: '1' }, reason: 'Add a daily limit' });
    assert.equal(resave.status, 200);
    assert.deepEqual([resave.body.project.maxAttempts, resave.body.project.timeoutSeconds], [4, 150]);
    assert.deepEqual(resave.body.sources, { maxAttempts: 'organisation', timeoutSeconds: 'organisation' }, 'the lower organisation value still governs');
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, maxAttempts: 5, timeoutSeconds: 150, daily: { mode: 'limit', limitMyr: '1' } })).status, 403);
    assert.equal((await pm.request('PUT', url(), { ...LIMITS, maxAttempts: 4, timeoutSeconds: 151, daily: { mode: 'limit', limitMyr: '1' } })).status, 403);
  });

  test('without saved organisation settings the project reads the defaults and a delegate cannot edit', async () => {
    const view = await pm.request('GET', url());
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.organisation, { maxAttempts: 3, timeoutSeconds: 120, concurrency: 2, projectsMaySetLimits: false, projectsMayManageConnections: false });
    assert.equal(view.body.project.saved, false);
    assert.equal(view.body.project.monthlyLimitMyr, null);
    assert.equal(view.body.editable, false);
    assert.equal((await pm.request('PUT', url(), LIMITS)).status, 403);
    const policy = await effectivePolicy(t.pool, projectId);
    assert.deepEqual([policy.maxAttempts, policy.timeoutMs, policy.concurrency], [3, 120_000, 2]);
  });
});
