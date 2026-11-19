import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

// The test clock starts at 2026-11-09T02:00Z: today is Monday 2026-11-09 (UTC+8). Weeks: 10-19, 10-26, 11-02, 11-09.
describe('analytics trends panel', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pmId: string;
  let pa: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    pmId = await seedUser(t.pool, 'pm@example.org');
    pa = await seedProject(t.pool, { status: 'active', name: 'Alpha works', members: [{ userId: pmId, role: 'pm' }] });
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  async function task(o: { project?: string; dueOn?: string; status?: string; completedAt?: string | null; authorisedAt?: string; deletedAt?: string | null } = {}): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, completed_at, deadline_review_required, authorised_by, authorised_at, deleted_at, deleted_by, delete_reason)
       VALUES ($1, $2, NULL, 0, 'Task', $3, $4, $5, $6, false, $3, $7, $8, CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE $3::uuid END, CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE 'test' END)`,
      [id, o.project ?? pa, pmId, o.dueOn ?? '2026-12-31', o.status ?? 'not_started', o.completedAt ?? null, o.authorisedAt ?? '2026-11-01T02:00:00Z', o.deletedAt ?? null],
    );
    return id;
  }
  const trends = async (extra = '') => {
    const r = await admin.request('GET', `/admin/analytics?panel=trends${extra}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data as { weeks: string[]; series: Record<string, number[]>; note: string };
  };
  const at = (d: { weeks: string[]; series: Record<string, number[]> }, key: string, week: string) => d.series[key][d.weeks.indexOf(week)];

  test('weeks run Monday to the current week; note is the exact copy', async () => {
    const d = await trends('&period=last_4w');
    assert.deepEqual(d.weeks, ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    assert.equal(d.note, 'Trends are worked out from current records: changed due dates use the current date, and deleted records are left out of past weeks.');
    for (const v of Object.values(d.series)) assert.equal(v.length, 4);
    assert.deepEqual(Object.keys(d.series).sort(), [
      'projects_active', 'projects_closed', 'projects_deferred', 'proposals_authorised', 'proposals_rejected', 'tasks_authorised', 'tasks_became_overdue', 'tasks_completed',
    ]);
  });

  test('task due Sunday becomes overdue in the next Monday week', async () => {
    await task({ dueOn: '2026-11-01' });
    await task({ dueOn: '2026-11-02' });
    const d = await trends('&period=last_4w');
    assert.equal(at(d, 'tasks_became_overdue', '2026-10-26'), 0);
    assert.equal(at(d, 'tasks_became_overdue', '2026-11-02'), 2);
    assert.equal(at(d, 'tasks_became_overdue', '2026-11-09'), 0);
  });

  test('task due today or later has not become overdue yet', async () => {
    await task({ dueOn: '2026-11-09' });
    await task({ dueOn: '2026-11-20' });
    const d = await trends('&period=last_4w');
    assert.equal(d.series.tasks_became_overdue.reduce((a, b) => a + b, 0), 0);
  });

  test('task completed on its due day never becomes overdue', async () => {
    await task({ dueOn: '2026-11-01', status: 'completed', completedAt: '2026-11-01T15:00:00Z' });
    await task({ dueOn: '2026-11-01', status: 'completed', completedAt: '2026-11-03T02:00:00Z' });
    const cancelled = await task({ dueOn: '2026-11-01', status: 'cancelled' });
    await t.pool.query(`INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at) VALUES ($1, $2, 'cancelled', 'not_started', 'cancelled', $3, '2026-10-31T02:00:00Z')`, [uuidv7(), cancelled, pmId]);
    const d = await trends('&period=last_4w');
    assert.equal(at(d, 'tasks_became_overdue', '2026-11-02'), 1);
    assert.equal(at(d, 'tasks_completed', '2026-11-02'), 1);
    assert.equal(at(d, 'tasks_completed', '2026-10-26'), 1);
  });

  test('tasks authorised per week; Deleted task drops out of past weeks', async () => {
    await task({ authorisedAt: '2026-11-03T02:00:00Z' });
    await task({ authorisedAt: '2026-11-04T02:00:00Z', dueOn: '2026-11-01' });
    await task({ authorisedAt: '2026-11-04T02:00:00Z', dueOn: '2026-11-01', completedAt: '2026-11-05T02:00:00Z', status: 'completed', deletedAt: '2026-11-06T02:00:00Z' });
    const d = await trends('&period=last_4w');
    assert.equal(at(d, 'tasks_authorised', '2026-11-02'), 2);
    assert.equal(at(d, 'tasks_became_overdue', '2026-11-02'), 1);
    assert.equal(at(d, 'tasks_completed', '2026-11-02'), 0);
  });

  test('proposals authorised and rejected per week', async () => {
    const hp = async (status: 'approved' | 'rejected', reviewedAt: string) => {
      const id = uuidv7();
      await t.pool.query(
        `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
         VALUES ($1, $2, 'risk', 'Proposed', $3, '2026-10-01T00:00:00Z', $4, $3, $5)`,
        [id, pa, pmId, status, reviewedAt],
      );
      return id;
    };
    const approved = await hp('approved', '2026-11-03T02:00:00Z');
    await hp('rejected', '2026-11-04T02:00:00Z');
    await hp('rejected', '2026-10-28T02:00:00Z');
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'Flood', 'high', '2026-12-01', $3, $4, '2026-11-03T02:00:00Z')`,
      [uuidv7(), pa, approved, pmId],
    );
    const d = await trends('&period=last_4w');
    assert.equal(at(d, 'proposals_authorised', '2026-11-02'), 1);
    assert.equal(at(d, 'proposals_rejected', '2026-11-02'), 1);
    assert.equal(at(d, 'proposals_rejected', '2026-10-26'), 1);
  });

  test('transitions into Active, Deferred, Closed counted per week', async () => {
    const tr = (project: string, from: string, to: string, when: string) =>
      t.pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, $3, $4, $5, $6)`, [uuidv7(), project, from, to, pmId, when]);
    await tr(pa, 'planned', 'active', '2026-11-03T02:00:00Z');
    await tr(pa, 'active', 'deferred', '2026-11-04T02:00:00Z');
    await tr(pa, 'active', 'closed', '2026-10-28T02:00:00Z');
    await tr(pa, 'draft', 'planned', '2026-10-28T02:00:00Z');
    const d = await trends('&period=last_4w');
    assert.equal(at(d, 'projects_active', '2026-11-02'), 1);
    assert.equal(at(d, 'projects_deferred', '2026-11-02'), 1);
    assert.equal(at(d, 'projects_closed', '2026-10-26'), 1);
    assert.equal(at(d, 'projects_closed', '2026-11-02'), 0);
    assert.equal(d.series.projects_active.reduce((a, b) => a + b, 0), 1);
  });

  test('closed projects still count under the default filters; Sunday 16:30Z is Monday in UTC+8', async () => {
    const pc = await seedProject(t.pool, { status: 'closed', name: 'Closed works', members: [{ userId: pmId, role: 'pm' }] });
    await t.pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, 'active', 'closed', $3, '2026-11-03T02:00:00Z')`, [uuidv7(), pc, pmId]);
    await task({ project: pc, status: 'completed', completedAt: '2026-11-03T02:00:00Z' });
    await task({ project: pc, status: 'completed', completedAt: '2026-11-01T16:30:00Z' });
    await task({ project: pc, status: 'completed', completedAt: '2026-11-01T15:30:00Z' });
    const d = await trends('&period=last_4w');
    assert.equal(at(d, 'projects_closed', '2026-11-02'), 1);
    assert.equal(at(d, 'tasks_completed', '2026-11-02'), 2);
    assert.equal(at(d, 'tasks_completed', '2026-10-26'), 1);
  });

  test('department filter narrows trends through the project scope', async () => {
    const dept = await seedDepartment(t.pool, 'Beta Unit');
    const pb = await seedProject(t.pool, { status: 'active', name: 'Beta works', departmentId: dept, members: [{ userId: pmId, role: 'pm' }] });
    await task({ authorisedAt: '2026-11-03T02:00:00Z' });
    await task({ project: pb, authorisedAt: '2026-11-03T02:00:00Z' });
    await task({ project: pb, authorisedAt: '2026-11-03T02:00:00Z' });
    assert.equal(at(await trends('&period=last_4w'), 'tasks_authorised', '2026-11-02'), 3);
    assert.equal(at(await trends(`&period=last_4w&department=${dept}&ownership=owned`), 'tasks_authorised', '2026-11-02'), 2);
  });

  test('member gets 403', async () => {
    await seedUser(t.pool, 'member@example.org');
    const m = await t.signIn('member@example.org');
    assert.equal((await m.request('GET', '/admin/analytics?panel=trends')).status, 403);
  });
});
