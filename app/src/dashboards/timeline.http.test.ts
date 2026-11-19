import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import type { TimelineLine } from './timeline';

describe('project timeline endpoint', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let projectId: string;
  const ids: Record<string, string> = {};
  const people: Record<string, Client> = {};

  beforeEach(async () => {
    t = await startTestApp();
    const adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await t.pool.query(`INSERT INTO eligible_domains (id, domain, added_by, added_at) VALUES ($1, 'example.com', $2, now())`, [uuidv7(), adminId]);
    for (const p of ['pm', 'mem', 'stranger']) ids[p] = await seedUser(t.pool, `${p}@example.com`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.mem, role: 'member' },
      ],
    });
    for (const p of ['pm', 'mem', 'stranger']) people[p] = await t.signIn(`${p}@example.com`);
  });
  afterEach(async () => {
    await t?.close();
  });

  const task = async (title: string, dueOn: string, status = 'not_started'): Promise<string> => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $4, now())`,
      [id, projectId, title, ids.pm, dueOn, status],
    );
    return id;
  };
  const get = (query = '', person = 'mem') => people[person].request('GET', `/projects/${projectId}/timeline${query}`);
  const lines = (body: { months: { lines: TimelineLine[] }[] }): TimelineLine[] => body.months.flatMap((m) => m.lines);

  test('no line is inferred: a project with no dates returns only the lines it has', async () => {
    const r = await get();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.range, { from: '2026-08-09', to: '2027-05-09' });
    assert.equal(r.body.today, '2026-11-09');
    assert.deepEqual(lines(r.body).map((l) => [l.kind, l.day]), [['stage', '2026-11-01']]);
  });

  test('one line per due day with count', async () => {
    await task('A', '2026-11-25', 'completed');
    await task('B', '2026-11-25');
    await task('C', '2026-11-25');
    await task('D', '2026-11-26');
    const due = lines((await get()).body).filter((l) => l.kind === 'tasks_due');
    assert.deepEqual(
      due.map((l) => [l.day, l.label]),
      [
        ['2026-11-25', '3 tasks due'],
        ['2026-11-26', '1 task due'],
      ],
    );
    const detail = due[0].detail as { tasks: { title: string; status: string }[]; done: number };
    assert.deepEqual(detail.tasks.map((x) => x.title).sort(), ['A', 'B', 'C']);
    assert.equal(detail.done, 1);
  });

  test('range filters lines; bad range is 400', async () => {
    await task('A', '2026-11-25');
    await task('B', '2027-12-25');
    assert.deepEqual(lines((await get('?from=2026-11-20&to=2026-11-30')).body).map((l) => l.kind), ['tasks_due']);
    assert.equal((await get('?from=2026-12-01&to=2026-11-01')).status, 400);
    assert.equal((await get('?from=nope')).status, 400);
    assert.equal((await get('?from=2020-01-01&to=2026-01-01')).status, 400);
  });

  test('status transitions and archive events appear', async () => {
    await t.pool.query(
      `INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES
        ($1, $3, 'draft', 'planned', $2, '2026-11-02T02:00:00Z'),
        ($4, $3, 'planned', 'active', $2, '2026-11-03T02:00:00Z'),
        ($5, $3, 'active', 'deferred', $2, '2026-11-04T02:00:00Z'),
        ($6, $3, 'deferred', 'active', $2, '2026-11-05T02:00:00Z'),
        ($7, $3, 'active', 'closed', $2, '2026-11-06T02:00:00Z'),
        ($8, $3, 'closed', 'active', $2, '2026-11-07T02:00:00Z')`,
      [uuidv7(), ids.pm, projectId, uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()],
    );
    await t.pool.query(
      `INSERT INTO project_archive_events (id, project_id, kind, actor_id, reason, at) VALUES
        ($1, $3, 'archived', $2, 'Tidy', '2026-11-08T02:00:00Z'), ($4, $3, 'unarchived', $2, 'Needed', '2026-11-09T02:00:00Z')`,
      [uuidv7(), ids.pm, projectId, uuidv7()],
    );
    const r = lines((await get()).body);
    assert.deepEqual(
      r.filter((l) => l.kind === 'status').map((l) => [l.day, l.label]),
      [
        ['2026-11-02', 'Planned'],
        ['2026-11-03', 'Active'],
        ['2026-11-04', 'Deferred'],
        ['2026-11-05', 'Resumed'],
        ['2026-11-06', 'Closed'],
        ['2026-11-07', 'Reopened'],
      ],
    );
    assert.deepEqual(
      r.filter((l) => l.kind === 'archive').map((l) => [l.day, l.label]),
      [
        ['2026-11-08', 'Archived'],
        ['2026-11-09', 'Unarchived'],
      ],
    );
  });

  test('stage periods, planned end and risk review dates', async () => {
    await t.pool.query(`UPDATE project_stage_periods SET ended_at = '2026-11-10T02:00:00Z' WHERE project_id = $1`, [projectId]);
    await t.pool.query(
      `INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, 'Planning', '2026-11-10T02:00:00Z', $3)`,
      [uuidv7(), projectId, ids.pm],
    );
    await t.pool.query(`UPDATE projects SET planned_end = '2027-01-31' WHERE id = $1`, [projectId]);
    const proposal = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, 'risk', 'P', $3, now(), 'approved', $3, now())`,
      [proposal, projectId, ids.pm],
    );
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, review_on, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'Supplier may slip', 'low', '2026-12-05', $3, $4, now())`,
      [uuidv7(), projectId, proposal, ids.pm],
    );
    const r = lines((await get()).body);
    assert.deepEqual(
      r.filter((l) => l.kind === 'stage').map((l) => [l.day, l.label]),
      [
        ['2026-11-01', 'Initiation started'],
        ['2026-11-10', 'Initiation ended'],
        ['2026-11-10', 'Planning started'],
      ],
    );
    assert.deepEqual(r.filter((l) => l.kind === 'planned_end').map((l) => [l.day, l.label]), [['2027-01-31', 'Planned end']]);
    const rr = r.filter((l) => l.kind === 'risk_review');
    assert.deepEqual(rr.map((l) => [l.day, l.label]), [['2026-12-05', '1 risk review due']]);
    assert.equal((rr[0].detail as { risks: { description: string }[] }).risks[0].description, 'Supplier may slip');
  });

  test('Deleted task drops out of a due-day count', async () => {
    await task('Kept', '2026-11-25');
    const gone = await task('Removed', '2026-11-25');
    const only = await task('Only deleted day', '2026-11-27');
    for (const id of [gone, only]) {
      await t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [id, ids.pm]);
    }
    const due = lines((await get()).body).filter((l) => l.kind === 'tasks_due');
    assert.deepEqual(due.map((l) => [l.day, l.label]), [['2026-11-25', '1 task due']]);
    assert.deepEqual((due[0].detail as { tasks: { title: string }[] }).tasks.map((x) => x.title), ['Kept']);
  });

  test('a cleaned held task shows the cleaned label; an uncleaned one is absent', async () => {
    const cleaned = await task('Secret title', '2026-11-25');
    const held = await task('Held title', '2026-11-25');
    for (const [id, state] of [[cleaned, 'cleaned'], [held, 'held']] as const) {
      const caseId = uuidv7();
      await t.pool.query(
        `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at, cleaned_at)
         VALUES ($1, $2, 'task', $3, 'test', 8, $4, $5, now(), CASE WHEN $4 = 'cleaned' THEN now() END)`,
        [caseId, projectId, id, state, state === 'held'],
      );
      await t.pool.query(`UPDATE tasks SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
    }
    const due = lines((await get()).body).filter((l) => l.kind === 'tasks_due');
    assert.deepEqual(due.map((l) => l.label), ['1 task due']);
    assert.deepEqual((due[0].detail as { tasks: { title: string }[] }).tasks.map((x) => x.title), ['Credential removed — under review']);
  });

  test('stranger gets 404; anonymous 401; unknown project 404', async () => {
    assert.equal((await get('', 'stranger')).status, 404);
    assert.equal((await people.mem.request('GET', `/projects/${uuidv7()}/timeline`)).status, 404);
    assert.equal((await t.anonymous('GET', `/projects/${projectId}/timeline`)).status, 401);
  });
});
