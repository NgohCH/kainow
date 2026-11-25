import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

const LIMITED = 'Only counts are shown: you are not a participant in this project.';

// The test clock starts at 2026-11-09T02:00Z: today is Monday 2026-11-09 (UTC+8).
describe('analytics drill-down', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;
  let adminId: string;
  let pmId: string;
  let deptA: string;
  let deptB: string;
  let mine: string;
  let theirs: string;
  let other: string;

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    pmId = await seedUser(t.pool, 'pm@example.org');
    deptA = await seedDepartment(t.pool, 'Alpha Unit');
    deptB = await seedDepartment(t.pool, 'Beta Unit');
    // The Administrator is a Member of "Mine" only.
    mine = await seedProject(t.pool, { status: 'active', name: 'Mine', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }, { userId: adminId, role: 'member' }] });
    theirs = await seedProject(t.pool, { status: 'active', name: 'Theirs', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }] });
    other = await seedProject(t.pool, { status: 'active', name: 'Other', departmentId: deptB, members: [{ userId: pmId, role: 'pm' }] });
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('member@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  async function task(project: string, title: string, dueOn: string, status = 'not_started'): Promise<string> {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, deadline_review_required, authorised_by, authorised_at)
       VALUES ($1, $2, NULL, 0, $6, $3, $4, $5, false, $3, now())`,
      [id, project, pmId, dueOn, status, title],
    );
    return id;
  }
  const drill = (query: string, who: Client = admin) => who.request('GET', `/admin/analytics/drill?${query}`);

  test('member gets 403; unknown level, measure or id is 400; a project outside the scope is 404', async () => {
    assert.equal((await drill('level=org&measure=overdueTasks', member)).status, 403);
    assert.equal((await drill('level=world&measure=overdueTasks')).status, 400);
    assert.equal((await drill('level=org&measure=nope')).status, 400);
    assert.equal((await drill('level=org')).status, 400);
    assert.equal((await drill('level=project&id=not-a-uuid&measure=overdueTasks')).status, 400);
    assert.equal((await drill('level=department&measure=overdueTasks')).status, 400);
    assert.equal((await drill(`level=project&id=${uuidv7()}&measure=overdueTasks`)).status, 404);
    assert.equal((await drill(`level=department&id=${uuidv7()}&measure=overdueTasks`)).status, 404);
    // Outside the filters: Other is owned by Beta Unit.
    assert.equal((await drill(`level=project&id=${other}&measure=overdueTasks&department=${deptA}&ownership=owned`)).status, 404);
    await t.pool.query(`UPDATE projects SET status = 'planned' WHERE id = $1`, [other]);
    assert.equal((await drill(`level=project&id=${other}&measure=overdueTasks&status=active`)).status, 404);
  });

  test('organisation and department levels give counts that match the panel', async () => {
    await task(mine, 'Mine late', '2026-11-02');
    await task(theirs, 'Theirs late', '2026-11-03');
    await task(other, 'Other late', '2026-11-04');
    const org = await drill('level=org&measure=overdueTasks');
    assert.equal(org.status, 200, JSON.stringify(org.body));
    assert.equal(org.body.counts.total, 3);
    assert.deepEqual(
      org.body.counts.breakdown.map((d: any) => [d.name, d.value]),
      [['Alpha Unit', 2], ['Beta Unit', 1]],
    );
    assert.equal(org.body.records, undefined);
    const dept = await drill(`level=department&id=${deptA}&measure=overdueTasks`);
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    assert.equal(dept.body.counts.total, 2);
    assert.deepEqual(dept.body.counts.breakdown.map((p: any) => [p.name, p.value]), [['Mine', 1], ['Theirs', 1]]);
    const panel = await admin.request('GET', '/admin/analytics?panel=problems');
    assert.equal(panel.body.data.organisation.overdueTasks, org.body.counts.total);
  });

  test('non-participant admin gets counts and the limited message', async () => {
    await task(theirs, 'Secret plan', '2026-11-02');
    await task(theirs, 'Other secret', '2026-11-05', 'blocked');
    const r = await drill(`level=project&id=${theirs}&measure=overdueTasks`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.counts.total, 2);
    assert.equal(r.body.records, undefined);
    assert.equal(r.body.limited, LIMITED);
    assert.doesNotMatch(JSON.stringify(r.body), /Secret plan|Other secret/);
  });

  test('participant admin gets records', async () => {
    const late = await task(mine, 'Late work', '2026-11-02');
    await task(mine, 'Future work', '2026-12-02');
    const blocked = await task(mine, 'Stuck work', '2026-12-03', 'blocked');
    const r = await drill(`level=project&id=${mine}&measure=overdueTasks`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.counts.total, 1);
    assert.equal(r.body.limited, undefined);
    assert.deepEqual(r.body.records, [{ id: late, title: 'Late work', assignee: 'pm', dueOn: '2026-11-02', link: `#/projects/${mine}/tasks/${late}` }]);
    const b = await drill(`level=project&id=${mine}&measure=blocked`);
    assert.deepEqual(b.body.records.map((x: any) => x.id), [blocked]);
    assert.equal(b.body.counts.total, 1);

    // Risks are listed for the risk measures.
    const proposal = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, 'risk', 'Proposed', $3, now(), 'approved', $3, now())`,
      [proposal, mine, pmId],
    );
    const risk = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'Flood', 'critical', $4, '2026-11-01', $3, $4, now())`,
      [risk, mine, proposal, pmId],
    );
    const rk = await drill(`level=project&id=${mine}&measure=openHighCriticalRisks`);
    assert.deepEqual(rk.body.records, [{ id: risk, title: 'Flood', assignee: 'pm', dueOn: '2026-11-01', link: `#/projects/${mine}/work/${risk}` }]);

    // Losing the role takes the list away at once: access is rechecked on every request.
    await t.pool.query(`UPDATE memberships SET revoked_at = now(), revoked_by = $2 WHERE project_id = $1 AND user_id = $3`, [mine, pmId, adminId]);
    const after = await drill(`level=project&id=${mine}&measure=overdueTasks`);
    assert.equal(after.body.records, undefined);
    assert.equal(after.body.limited, LIMITED);
  });

  test('Deleted task absent from records and counts', async () => {
    const keep = await task(mine, 'Keep me', '2026-11-02');
    const gone = await task(mine, 'Delete me', '2026-11-03');
    await t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Test' WHERE id = $1`, [gone, pmId]);
    const r = await drill(`level=project&id=${mine}&measure=overdueTasks`);
    assert.equal(r.body.counts.total, 1);
    assert.deepEqual(r.body.records.map((x: any) => x.id), [keep]);
    const org = await drill('level=org&measure=overdueTasks');
    assert.equal(org.body.counts.total, 1);
  });
});
