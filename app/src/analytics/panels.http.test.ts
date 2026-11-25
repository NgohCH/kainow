import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

// The test clock starts at 2026-11-09T02:00Z: today is Monday 2026-11-09 (UTC+8).
describe('analytics progress and problems panels', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;
  let pmId: string;
  let deptA: string;
  let deptB: string;
  let pa: string;
  let pb: string;
  let pn: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    pmId = await seedUser(t.pool, 'pm@example.org');
    deptA = await seedDepartment(t.pool, 'Alpha Unit');
    deptB = await seedDepartment(t.pool, 'Beta Unit');
    pa = await seedProject(t.pool, { status: 'active', name: 'Alpha works', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }] });
    pb = await seedProject(t.pool, { status: 'active', name: 'Beta works', departmentId: deptB, members: [{ userId: pmId, role: 'pm' }] });
    pn = await seedProject(t.pool, { status: 'active', name: 'Nothing works', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }] });
    // Alpha works also draws on Beta Unit.
    await t.pool.query(`INSERT INTO project_departments (project_id, department_id) VALUES ($1, $2)`, [pa, deptB]);
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('member@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  async function task(project: string, dueOn: string, status = 'not_started', completedAt: string | null = null): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, completed_at, deadline_review_required, authorised_by, authorised_at)
       VALUES ($1, $2, NULL, 0, 'Task', $3, $4, $5, $6, false, $3, now())`,
      [id, project, pmId, dueOn, status, completedAt],
    );
    return id;
  }
  const get = (query: string, who: Client = admin) => who.request('GET', `/admin/analytics?${query}`);
  const progress = async (extra = '') => {
    const r = await get(`panel=progress${extra}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  test('member gets 403', async () => {
    assert.equal((await get('panel=progress', member)).status, 403);
    assert.equal((await get('panel=problems', member)).status, 403);
  });

  test('only the four panels; bad filters are 400 with the text', async () => {
    for (const q of ['', 'panel=nope']) assert.equal((await get(q)).status, 400, q);
    const bad = await get('panel=progress&period=last_5w');
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /Choose a period from the list\./);
  });

  test('department roll-up counts each project once; contributed listed apart', async () => {
    await task(pa, '2026-11-02', 'completed', '2026-11-01T02:00:00Z');
    await task(pa, '2026-11-05', 'blocked');
    await task(pb, '2026-11-03', 'completed', '2026-11-04T02:00:00Z');
    const body = await progress();
    assert.equal(body.panel, 'progress');
    assert.equal(body.definitionsVersion, '2');
    assert.equal(body.data.computedAt, t.clock.now().toISOString());
    assert.equal(body.computedAt, t.clock.now().toISOString());
    const depts = body.data.departments as Array<any>;
    const a = depts.find((d) => d.name === 'Alpha Unit');
    const b = depts.find((d) => d.name === 'Beta Unit');
    assert.equal(a.projects, 2);
    assert.equal(b.projects, 1);
    assert.equal(a.blocked, 1);
    assert.equal(a.overdue, 1);
    assert.deepEqual(a.alsoContributesTo, []);
    assert.deepEqual(b.alsoContributesTo.map((p: any) => p.name), ['Alpha works']);
    // Totals add up to the project rows: Alpha works is not counted again under Beta.
    assert.equal(depts.reduce((n, d) => n + d.projects, 0), (body.data.projects as unknown[]).length);
    const rows = body.data.projects as Array<any>;
    assert.deepEqual(rows.map((r) => r.name), ['Alpha works', 'Beta works', 'Nothing works']);
    assert.equal(rows[0].owningDepartment, 'Alpha Unit');
    assert.equal(rows[0].stage.stage, 'Initiation');
    assert.equal(rows[0].completion.percent, 50);
    assert.equal(rows[0].onTime.state, 'measured');
    assert.equal(rows[0].onTime.late, 0);
  });

  test('nothing-due projects listed, not zero', async () => {
    await task(pa, '2026-11-02', 'completed', '2026-11-01T02:00:00Z');
    await task(pn, '2026-11-30');
    const body = await progress();
    assert.deepEqual(body.data.nothingDue.map((p: any) => p.name), ['Beta works', 'Nothing works']);
    assert.equal(body.data.projects.find((p: any) => p.name === 'Nothing works').onTime.state, 'nothing_due');
  });

  test('filters: department, ownership, status and archived', async () => {
    const onlyB = await progress(`&department=${deptB}&ownership=owned`);
    assert.deepEqual(onlyB.data.projects.map((p: any) => p.name), ['Beta works']);
    const contributed = await progress(`&department=${deptB}&ownership=contributed`);
    assert.deepEqual(contributed.data.projects.map((p: any) => p.name), ['Alpha works']);
    const both = await progress(`&department=${deptB}`);
    assert.deepEqual(both.data.projects.map((p: any) => p.name), ['Alpha works', 'Beta works']);
    await t.pool.query(`UPDATE projects SET status = 'planned' WHERE id = $1`, [pb]);
    const active = await progress('&status=active');
    assert.deepEqual(active.data.projects.map((p: any) => p.name), ['Alpha works', 'Nothing works']);
  });

  test('problems: the nine counts, organisation then department then project', async () => {
    await task(pa, '2026-11-05', 'blocked');
    await task(pa, '2026-11-06');
    await task(pb, '2026-11-01');
    const proposal = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, 'risk', 'Proposed', $3, now(), 'approved', $3, now())`,
      [proposal, pa, pmId],
    );
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'Flood', 'critical', '2026-11-01', $3, $4, now())`,
      [uuidv7(), pa, proposal, pmId],
    );
    // One invitation expired inside the period, one still open, one expired before it.
    const invite = (email: string, expiresAt: string) =>
      t.pool.query(
        `INSERT INTO invitations (id, project_id, email, role, starts_on, invited_by, token_hash, issued_at, expires_at, status)
         VALUES ($1, $2, $3, 'member', '2026-11-01', $4, $5, '2026-01-01T00:00:00Z', $6, 'invited')`,
        [uuidv7(), pa, email, pmId, uuidv7(), expiresAt],
      );
    await invite('in@example.org', '2026-11-05T00:00:00Z');
    await invite('open@example.org', '2026-12-05T00:00:00Z');
    await invite('old@example.org', '2026-01-05T00:00:00Z');

    const r = await get('panel=problems');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    const keys = ['overdueTasks', 'blockedTasks', 'openHighCriticalRisks', 'overdueRiskReviews', 'vacantRequiredRoles', 'openEscalations', 'noIndependentEscalation', 'deadlineReviewsPending', 'invitationsExpired'];
    for (const k of keys) assert.equal(typeof d.organisation[k], 'number', k);
    const proj = (name: string) => d.projects.find((p: any) => p.name === name);
    assert.equal(proj('Alpha works').overdueTasks, 2);
    assert.equal(proj('Alpha works').blockedTasks, 1);
    assert.equal(proj('Alpha works').openHighCriticalRisks, 1);
    assert.equal(proj('Alpha works').overdueRiskReviews, 1);
    assert.equal(proj('Alpha works').invitationsExpired, 1);
    assert.equal(proj('Beta works').overdueTasks, 1);
    assert.equal(d.organisation.overdueTasks, 3);
    assert.equal(d.organisation.invitationsExpired, 1);
    const dept = (name: string) => d.departments.find((x: any) => x.name === name);
    assert.equal(dept('Alpha Unit').overdueTasks, 2);
    assert.equal(dept('Beta Unit').overdueTasks, 1);
    // The invitation expired on 5 November: inside this month, outside last month.
    const month = await get('panel=problems&period=this_month');
    assert.equal(month.body.data.organisation.invitationsExpired, 1);
    const last = await get('panel=problems&period=last_month');
    assert.equal(last.body.data.organisation.invitationsExpired, 0);
  });

  test('deleted records are not counted', async () => {
    const id = await task(pa, '2026-11-05');
    const live = await get('panel=problems');
    assert.equal(live.body.data.organisation.overdueTasks, 1);
    await t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Test' WHERE id = $1`, [id, pmId]);
    const gone = await get('panel=problems');
    assert.equal(gone.body.data.organisation.overdueTasks, 0);
  });
});
