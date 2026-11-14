import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { effectiveAnalysisSettings } from './settings.service';

describe('automatic analysis settings', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let deputy: Client;
  let ann: Client;
  let projectId: string;
  const URL_ORG = '/settings/analysis';
  const url = () => `/projects/${projectId}/settings/analysis`;

  beforeEach(async () => {
    t = await startTestApp();
    const ids: Record<string, string> = {};
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['owner', 'pm', 'deputy', 'ann']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
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
    ann = await t.signIn('ann@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const setOrg = (b: Record<string, unknown>, reason: string | null = 'Because') => admin.request('PUT', URL_ORG, { ...b, reason });
  const setProj = (b: Record<string, unknown>, c: Client = pm) => c.request('PUT', url(), { ...b, reason: 'Project need' });

  test('defaults are on and 5 minutes', async () => {
    const o = await admin.request('GET', URL_ORG);
    assert.deepEqual([o.status, o.body.automatic, o.body.quietMinutes, o.body.projectsMayChange], [200, true, 5, false]);
    const p = await pm.request('GET', url());
    assert.deepEqual([p.body.automatic, p.body.quietMinutes, p.body.source, p.body.canEdit], [true, 5, { automatic: 'organisation', quietMinutes: 'organisation' }, false]);
    assert.deepEqual(await effectiveAnalysisSettings(t.pool, projectId), {
      automatic: true, quietMinutes: 5, projectsMayChange: false, source: { automatic: 'organisation', quietMinutes: 'organisation' },
    });
    assert.equal((await pm.request('GET', URL_ORG)).status, 403, 'only the Administrator reads the organisation settings');
  });

  test('Administrator sets 10 and the project inherits', async () => {
    const r = await setOrg({ quietMinutes: 10 });
    assert.equal(r.status, 200);
    assert.equal(r.body.quietMinutes, 10);
    const p = await ann.request('GET', url());
    assert.deepEqual([p.status, p.body.quietMinutes, p.body.source.quietMinutes], [200, 10, 'organisation']);
    assert.equal((await effectiveAnalysisSettings(t.pool, projectId)).quietMinutes, 10);
    // An unchanged value writes no history; a reason is required.
    await setOrg({ quietMinutes: 10 });
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM analysis_settings_changes`)).rows[0].n, 1);
    assert.equal((await setOrg({ automatic: false }, ' ')).status, 400);
    assert.equal((await setOrg({ automatic: false }, null)).status, 400);
    assert.equal((await setOrg({ automatic: 'no' })).status, 400);
  });

  test('project change refused until delegated', async () => {
    const r = await setProj({ quietMinutes: 15 });
    assert.equal(r.status, 403);
    assert.equal(r.body.message, 'The Administrator has not allowed projects to change automatic analysis.');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM project_analysis_settings`)).rows[0].n, 0);
    assert.equal((await ann.request('PUT', url(), { automatic: false, reason: 'x' })).status, 403);
  });

  test('PM sets 15 when delegated; history records reason', async () => {
    await setOrg({ projectsMayChange: true });
    assert.equal((await pm.request('GET', url())).body.canEdit, true);
    const r = await pm.request('PUT', url(), { quietMinutes: 15, automatic: false, reason: 'Long meetings' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.quietMinutes, r.body.automatic, r.body.source], [15, false, { automatic: 'project', quietMinutes: 'project' }]);
    const h = r.body.history as { field: string; oldValue: string | null; newValue: string | null; reason: string; actor: string }[];
    const q = h.find((x) => x.field === 'quiet_minutes');
    assert.deepEqual([q?.oldValue, q?.newValue, q?.reason], [null, '15', 'Long meetings']);
    assert.equal(h.length, 2);
    assert.equal((await effectiveAnalysisSettings(t.pool, projectId)).automatic, false);
    // null returns to the organisation value.
    const back = await pm.request('PUT', url(), { quietMinutes: null, reason: 'Back to default' });
    assert.deepEqual([back.body.quietMinutes, back.body.source.quietMinutes], [5, 'organisation']);
    // The organisation history is separate and the audit trail never carries the reason.
    assert.equal((await admin.request('GET', URL_ORG)).body.history.length, 1);
    const audit = await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'analysis_settings.project_changed'`);
    assert.ok(audit.rowCount);
    assert.ok(!JSON.stringify(audit.rows).includes('Long meetings'));
    assert.equal((await pm.request('PUT', url(), { quietMinutes: 20, reason: '' })).status, 400);
  });

  test('the Administrator can clear a project value whatever the delegation, with a reason; nothing else', async () => {
    await setOrg({ projectsMayChange: true });
    assert.equal((await setProj({ quietMinutes: 15, automatic: false })).status, 200);
    await setOrg({ projectsMayChange: false });
    assert.equal((await admin.request('GET', url())).body.canClear, true);
    assert.equal((await admin.request('PUT', url(), { quietMinutes: 20, reason: 'Set it' })).status, 403, 'the Administrator cannot set a value');
    assert.equal((await admin.request('PUT', url(), { quietMinutes: null, automatic: 7, reason: 'x' })).status, 403);
    assert.equal((await admin.request('PUT', url(), { quietMinutes: null })).status, 400, 'a reason is required');
    const r = await admin.request('PUT', url(), { quietMinutes: null, reason: 'Back to the organisation value' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.own.quietMinutes, null);
    assert.equal(r.body.own.automatic, false, 'only the named value was cleared');
    const last = (await t.pool.query(`SELECT field, from_value, to_value, reason FROM analysis_settings_changes WHERE project_id = $1 AND reason = 'Back to the organisation value'`, [projectId])).rows[0];
    assert.deepEqual(last, { field: 'quiet_minutes', from_value: '15', to_value: null, reason: 'Back to the organisation value' });
    assert.equal((await pm.request('PUT', url(), { automatic: null, reason: 'x' })).status, 403, 'a PM still needs the delegation');
  });

  test('4 and 31 and 7.5 are refused', async () => {
    await setOrg({ projectsMayChange: true });
    for (const bad of [4, 31, 7.5, '10', null]) {
      const o = await setOrg({ quietMinutes: bad });
      assert.equal(o.status, 400, `organisation ${String(bad)}`);
      assert.equal(o.body.message, 'The quiet period must be a whole number of minutes from 5 to 30.');
    }
    for (const bad of [4, 31, 7.5]) {
      const p = await setProj({ quietMinutes: bad });
      assert.equal(p.status, 400, `project ${bad}`);
      assert.equal(p.body.message, 'The quiet period must be a whole number of minutes from 5 to 30.');
    }
    assert.equal((await setOrg({ quietMinutes: 5 })).status, 200);
    assert.equal((await setOrg({ quietMinutes: 30 })).status, 200);
  });

  test('Deputy cannot edit project settings', async () => {
    await setOrg({ projectsMayChange: true });
    const g = await deputy.request('GET', url());
    assert.deepEqual([g.status, g.body.canEdit], [200, false]);
    assert.equal((await setProj({ quietMinutes: 12 }, deputy)).status, 403);
    assert.equal((await setProj({ quietMinutes: 12 }, ann)).status, 403);
  });

  test('the own off setting of a project is the effective one; a Deferred project cannot be edited', async () => {
    await setOrg({ projectsMayChange: true });
    await setProj({ automatic: false });
    assert.equal((await effectiveAnalysisSettings(t.pool, projectId)).automatic, false);
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await setProj({ automatic: true })).status, 403);
  });
});
