import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { aiReady } from '../testing/ai-runners';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { NOTE_BAD_RESPONSE, NOTE_RATE_LIMITED } from './chooser';

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

const FORBIDDEN_KEYS = new Set(['question', 'text', 'title', 'prompt', 'body', 'apiKey']);

function keysOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, found);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.push(k);
      keysOf(v, found);
    }
  }
  return found;
}

const MYR = (n: number) => BigInt(Math.round(n * 1_000_000));

describe('AI usage views', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let owner: Client;
  let sponsor: Client;
  let deputy: Client;
  let ann: Client;
  let auditor: Client;
  let outsider: Client;
  let ids: Record<string, string> = {};
  let projectId: string;
  let connA: string;
  let connB: string;
  const usage = (c: Client, id = projectId) => c.request('GET', `/projects/${id}/ai/usage`);

  /** A spend entry as the guarded call would have left it (created now, by the fake clock). */
  const entry = async (o: {
    connection?: string | null;
    project?: string | null;
    actor?: string | null;
    status?: 'reserved' | 'uncertain' | 'confirmed' | 'released';
    myr?: number;
    request?: string;
    attemptNo?: number;
    purpose?: string;
    note?: string | null;
    ruled?: boolean;
    at?: Date;
  }) => {
    const project = o.project === undefined ? projectId : o.project;
    const status = o.status ?? 'confirmed';
    const amount = status === 'released' ? 0n : MYR(o.myr ?? 1);
    const at = o.at ?? new Date(t.clock.now());
    await t.pool.query(
      `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, actor_user_id, model_id, provider,
                                     input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro,
                                     myr_per_usd_micro, estimate_micro_myr, amount_micro_myr, note, project_id, connection_id, ruled)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, 'gpt-6.1-sol', 'openai', 1, 1, 1, 1, $8, $9, $10, $11, $12, $13)`,
      [
        uuidv7(),
        o.request ?? uuidv7(),
        o.attemptNo ?? 1,
        at,
        status,
        o.purpose ?? 'extraction',
        o.actor === undefined ? ids.ann : o.actor,
        (status === 'released' ? MYR(o.myr ?? 1) : amount).toString(),
        amount.toString(),
        o.note ?? null,
        project,
        o.connection === undefined ? connA : o.connection,
        o.ruled ?? project !== null,
      ],
    );
  };

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['owner', 'pm', 'sponsor', 'deputy', 'ann', 'auditor', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), projectId, ids.auditor, ids.pm, ids.admin],
    );
    connA = await aiReady(t.pool, projectId, { label: 'Primary' });
    connB = await aiReady(t.pool, projectId, { label: 'Backup', provider: 'anthropic', modelId: 'claude-test-model' });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    deputy = await t.signIn('deputy@example.org');
    ann = await t.signIn('ann@example.org');
    auditor = await t.signIn('auditor@example.org');
    outsider = await t.signIn('outsider@example.org');
    assert.equal((await admin.request('PUT', '/ai/spend-settings', ORG)).status, 200);
  });
  afterEach(async () => {
    await t?.close();
  });

  test('leak test 3: only the PM, Owner and Sponsor open the project route, and no response carries content or a key', async () => {
    await entry({ myr: 2 });
    await entry({ actor: null, purpose: 'discussion_analysis', myr: 1 });
    assert.equal((await usage(deputy)).status, 403);
    assert.equal((await usage(ann)).status, 403);
    assert.equal((await usage(auditor)).status, 403);
    assert.equal((await usage(admin)).status, 404, 'an Administrator who is not a member is not a participant');
    assert.equal((await usage(outsider)).status, 404);
    assert.equal((await usage(pm, uuidv7())).status, 404);
    for (const c of [pm, owner, sponsor]) assert.equal((await usage(c)).status, 200);

    assert.equal((await outsider.request('GET', '/ai/usage')).status, 403);
    assert.equal((await pm.request('GET', '/ai/usage')).status, 403);
    assert.equal((await admin.request('GET', '/ai/usage')).status, 200);

    const bodies = [(await usage(pm)).body, (await admin.request('GET', '/ai/usage')).body, (await ann.request('GET', '/ai/usage/mine')).body];
    for (const body of bodies) {
      const bad = keysOf(body).filter((k) => FORBIDDEN_KEYS.has(k));
      assert.deepEqual(bad, [], `content keys in ${JSON.stringify(body).slice(0, 200)}`);
      assert.doesNotMatch(JSON.stringify(body), /sk-test-/);
    }
  });

  test('uncertain amounts are reported separately and included in totals', async () => {
    await entry({ status: 'confirmed', myr: 1 });
    await entry({ status: 'uncertain', myr: 0.5 });
    await entry({ status: 'reserved', myr: 0.25 });
    await entry({ status: 'released', myr: 3, note: 'never sent' });
    const r = await usage(pm);
    assert.equal(r.status, 200);
    assert.equal(r.body.month.confirmedMyr, '1.000000');
    assert.equal(r.body.month.uncertainMyr, '0.500000');
    assert.equal(r.body.month.reservedMyr, '0.250000');
    assert.equal(r.body.month.usedMyr, '1.750000', 'uncertain and reserved are inside the total');
    assert.equal(r.body.month.limitMyr, '1000.000000');
    assert.equal(r.body.month.remainingMyr, '998.250000', 'remaining agrees with what reserve() would see');
    assert.equal(r.body.day.dailyLimitApplies, false);
    const ann1 = r.body.byPerson.find((p: { userId: string }) => p.userId === ids.ann);
    assert.deepEqual([ann1.name, ann1.confirmedMyr, ann1.uncertainMyr, ann1.reservedMyr], ['ann', '1.000000', '0.500000', '0.250000']);
    assert.equal(ann1.attempts, 3, 'a released reservation that was never sent is not an attempt');
    const mine = await ann.request('GET', '/ai/usage/mine');
    assert.equal(mine.body.projects[0].uncertainMyr, '0.500000');
    assert.equal(mine.body.projects[0].requests, 3);
    const org = (await admin.request('GET', '/ai/usage')).body;
    assert.equal(org.month.uncertainMyr, '0.500000');
    assert.equal(org.byProject[0].name, 'Alpha Project');
    assert.equal(org.byPerson[0].name, 'ann');
  });

  test('system-initiated usage is grouped by purpose', async () => {
    await entry({ actor: null, purpose: 'discussion_analysis', myr: 2 });
    await entry({ actor: null, purpose: 'discussion_analysis', myr: 1 });
    await entry({ actor: null, purpose: 'extraction', myr: 0.5, status: 'uncertain' });
    await entry({ myr: 4 });
    const r = (await usage(owner)).body;
    assert.deepEqual(
      r.system.map((s: { purpose: string; confirmedMyr: string; uncertainMyr: string }) => [s.purpose, s.confirmedMyr, s.uncertainMyr]),
      [
        ['discussion_analysis', '3.000000', '0.000000'],
        ['extraction', '0.000000', '0.500000'],
      ],
    );
    assert.equal(r.byPerson.length, 1);
  });

  test('fallbacks count attempts after the first on a different connection', async () => {
    const r1 = uuidv7();
    await entry({ request: r1, attemptNo: 1, connection: connA, status: 'uncertain', myr: 0.5 });
    await entry({ request: r1, attemptNo: 2, connection: connB, status: 'confirmed', myr: 0.3 });
    const r2 = uuidv7();
    await entry({ request: r2, attemptNo: 1, connection: connA, status: 'confirmed', myr: 0.2, note: NOTE_BAD_RESPONSE });
    await entry({ request: r2, attemptNo: 2, connection: connA, status: 'confirmed', myr: 0.2 });
    const r3 = uuidv7();
    await entry({ request: r3, attemptNo: 1, connection: connA, status: 'released', myr: 0.4, note: NOTE_RATE_LIMITED });
    await entry({ request: r3, attemptNo: 2, connection: connB, status: 'confirmed', myr: 0.1 });
    await entry({ attemptNo: 1, connection: connA, status: 'released', note: 'never sent' });

    const rows = (await usage(pm)).body.byConnection as Array<Record<string, any>>;
    const a = rows.find((x) => x.connectionId === connA)!;
    const b = rows.find((x) => x.connectionId === connB)!;
    assert.deepEqual([a.label, a.provider, a.modelId], ['Primary', 'openai', 'gpt-6.1-sol']);
    assert.deepEqual([a.attempts, a.failures, a.fallbacks, a.chargedFailures], [4, 3, 0, 2], 'a retry on the same connection is not a fallback; never-sent is not an attempt');
    assert.deepEqual([a.confirmedMyr, a.uncertainMyr], ['0.400000', '0.500000']);
    assert.deepEqual([b.label, b.attempts, b.failures, b.fallbacks, b.chargedFailures], ['Backup', 2, 0, 2, 0]);
    assert.equal(b.confirmedMyr, '0.400000');
  });

  test('pre-project entries appear only in the Administrator view as beforeProjects', async () => {
    await entry({ myr: 1 });
    await entry({ project: null, connection: null, myr: 7, ruled: false });
    await entry({ project: null, connection: null, myr: 2, status: 'uncertain', ruled: false });
    const org = (await admin.request('GET', '/ai/usage')).body;
    assert.equal(org.beforeProjects.confirmedMyr, '7.000000');
    assert.equal(org.beforeProjects.uncertainMyr, '2.000000');
    assert.equal(org.month.usedMyr, '10.000000', 'organisation totals include them');
    assert.deepEqual(org.byProject.map((p: { name: string; confirmedMyr: string }) => [p.name, p.confirmedMyr]), [['Alpha Project', '1.000000']]);

    const project = (await usage(pm)).body;
    assert.equal(project.month.usedMyr, '1.000000');
    assert.equal(JSON.stringify(project).includes('beforeProjects'), false);
    const mine = (await ann.request('GET', '/ai/usage/mine')).body;
    assert.equal(mine.projects.length, 1);
    assert.equal(JSON.stringify(mine).includes('beforeProjects'), false);
  });

  test('mine shows remaining personal allowance at both levels when both apply', async () => {
    assert.equal((await admin.request('PUT', '/ai/spend-settings', { ...ORG, userMonthly: { mode: 'limit', limitMyr: 5 } })).status, 200);
    await t.pool.query(`UPDATE project_ai_limits SET user_monthly_mode = 'limit', user_monthly_limit_micro_myr = 3000000 WHERE project_id = $1`, [projectId]);
    await entry({ myr: 1 });
    await entry({ status: 'uncertain', myr: 0.5 });
    await entry({ actor: ids.pm, myr: 2 });
    const mine = (await ann.request('GET', '/ai/usage/mine')).body;
    assert.equal(mine.projects.length, 1);
    const p = mine.projects[0];
    assert.deepEqual([p.projectId, p.name, p.requests, p.attempts], [projectId, 'Alpha Project', 2, 2]);
    assert.deepEqual([p.confirmedMyr, p.uncertainMyr, p.reservedMyr], ['1.000000', '0.500000', '0.000000']);
    assert.deepEqual(p.remaining, { organisationPersonal: '3.500000', projectPersonal: '1.500000' });
    assert.ok(p.month.start.endsWith('Z') && p.month.start < p.month.end);

    const other = (await pm.request('GET', '/ai/usage/mine')).body.projects[0];
    assert.deepEqual(other.remaining, { organisationPersonal: '3.000000', projectPersonal: '1.000000' });

    await admin.request('PUT', '/ai/spend-settings', ORG);
    await t.pool.query(`UPDATE project_ai_limits SET user_monthly_mode = 'not_applied', user_monthly_limit_micro_myr = NULL WHERE project_id = $1`, [projectId]);
    assert.deepEqual((await ann.request('GET', '/ai/usage/mine')).body.projects[0].remaining, {});
    assert.deepEqual((await outsider.request('GET', '/ai/usage/mine')).body, { projects: [] });
  });

  test('GET /ai/spend?projectId= is the header meter: the project for a manager, the person own remaining for others', async () => {
    await admin.request('PUT', '/ai/spend-settings', { ...ORG, userMonthly: { mode: 'limit', limitMyr: 5 } });
    await entry({ myr: 1 });
    const plain = await admin.request('GET', '/ai/spend');
    assert.equal(plain.status, 200);
    assert.deepEqual(Object.keys(plain.body).sort(), ['configured', 'day', 'mine', 'month', 'settings']);
    assert.equal((await ann.request('GET', '/ai/spend')).status, 403);

    const mgr = await pm.request('GET', `/ai/spend?projectId=${projectId}`);
    assert.equal(mgr.status, 200);
    assert.equal(mgr.body.meter.kind, 'project');
    assert.equal(mgr.body.meter.usedMyr, '1.000000');
    assert.equal(mgr.body.meter.remainingMyr, '999.000000');
    assert.equal(mgr.body.settings, null);

    const member = await ann.request('GET', `/ai/spend?projectId=${projectId}`);
    assert.equal(member.status, 200);
    assert.equal(member.body.meter.kind, 'personal');
    assert.equal(member.body.meter.remainingMyr, '4.000000');
    assert.equal(member.body.project, null, 'a plain member does not get the project totals');

    assert.equal((await outsider.request('GET', `/ai/spend?projectId=${projectId}`)).status, 404);
  });
});
