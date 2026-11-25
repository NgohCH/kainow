import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { todayUtc8 } from '../projects/membership';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { type ProjectMeasures, loadProjectMeasures } from './measures';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const TODAY = '2026-11-19';

describe('loadProjectMeasures', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let pm: string;
  let member: string;
  let project: string;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    pm = await seedUser(pool, 'pm@example.org');
    member = await seedUser(pool, 'member@example.org');
    project = await workingProject();
  });

  const workingProject = () =>
    seedProject(pool, {
      status: 'active',
      members: [
        { userId: pm, role: 'pm' },
        { userId: pm, role: 'owner' },
        { userId: member, role: 'member' },
      ],
    });

  async function task(opts: {
    parent?: string;
    status?: string;
    dueOn?: string;
    completedAt?: string;
    review?: boolean;
    projectId?: string;
  } = {}): Promise<string> {
    const id = uuidv7();
    const depth = opts.parent ? (await pool.query(`SELECT depth FROM tasks WHERE id = $1`, [opts.parent])).rows[0].depth + 1 : 0;
    const status = opts.status ?? 'not_started';
    await pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, completed_at, deadline_review_required, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, 'Task', $5, $6, $7, $8, $9, $10, now())`,
      [id, opts.projectId ?? project, opts.parent ?? null, depth, member, opts.dueOn ?? '2026-11-30', status,
        status === 'completed' ? (opts.completedAt ?? '2026-11-05T02:00:00Z') : null, opts.review ?? false, pm],
    );
    return id;
  }
  const remove = (table: string, id: string) =>
    pool.query(`UPDATE ${table} SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [id, pm]);
  async function hold(table: 'tasks' | 'risks', id: string, state: 'held' | 'cleaned'): Promise<void> {
    const caseId = uuidv7();
    await pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at, cleaned_at)
       VALUES ($1, $2, $3, $4, 'test', 8, $5, $6, now(), CASE WHEN $5 = 'cleaned' THEN now() END)`,
      [caseId, project, table === 'tasks' ? 'task' : 'risk', id, state, state === 'held'],
    );
    await pool.query(`UPDATE ${table} SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
  }
  async function proposal(kind: 'risk' | 'question'): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'Proposed', $4, now(), 'approved', $4, now())`,
      [id, project, kind, pm],
    );
    return id;
  }
  async function risk(severity: string, status: string, reviewOn: string | null = null): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO risks (id, project_id, description, severity, review_on, status, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'Risk', $3, $4, $5, $6, $7, now())`,
      [id, project, severity, reviewOn, status, await proposal('risk'), pm],
    );
    return id;
  }
  async function question(status: string): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, status, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, 'Question?', $3, $4, $5, $3, now())`,
      [id, project, pm, status, await proposal('question')],
    );
    return id;
  }
  const measures = async (today = TODAY, db: Pool = pool): Promise<ProjectMeasures> => {
    const m = (await loadProjectMeasures(db, [project], today)).get(project);
    assert.ok(m);
    return m;
  };

  test('parent with live subtasks is not a leaf; two levels; all-subtasks-Deleted parent is a leaf', async () => {
    const top = await task({ status: 'in_progress' });
    const mid = await task({ parent: top, status: 'in_progress' });
    await task({ parent: mid, status: 'completed' });
    await task({ parent: mid, status: 'not_started' });
    await task({ parent: top, status: 'completed' });
    const emptied = await task({ status: 'completed' });
    await remove('tasks', await task({ parent: emptied, status: 'not_started' }));
    await task({ status: 'cancelled' });
    // Leaves: two grandchildren, one child, the emptied parent (and the cancelled one, counted apart).
    assert.deepEqual((await measures()).completion, { state: 'measurable', done: 3, total: 4, cancelled: 1, percent: 75 });
  });

  test('a parent whose only subtask is held and uncleaned is a leaf; a cleaned held subtask keeps it from being one', async () => {
    const heldParent = await task({ status: 'completed' });
    await hold('tasks', await task({ parent: heldParent, status: 'not_started' }), 'held');
    const cleanedParent = await task({ status: 'completed' });
    await hold('tasks', await task({ parent: cleanedParent, status: 'not_started' }), 'cleaned');
    // Leaves: the held subtask's parent (completed) and the cleaned subtask (not started).
    assert.deepEqual((await measures()).completion, { state: 'measurable', done: 1, total: 2, cancelled: 0, percent: 50 });
  });

  test('Deleted and uncleaned held tasks are not counted; cleaned held are', async () => {
    await task({ status: 'completed' });
    await remove('tasks', await task({ status: 'not_started', dueOn: '2026-11-01' }));
    await hold('tasks', await task({ status: 'blocked', dueOn: '2026-11-01' }), 'held');
    await hold('tasks', await task({ status: 'blocked', dueOn: '2026-11-01' }), 'cleaned');
    const m = await measures();
    assert.deepEqual(m.completion, { state: 'measurable', done: 1, total: 2, cancelled: 0, percent: 50 });
    assert.equal(m.blocked, 1);
    assert.equal(m.overdue, 1);
  });

  test('overdue at the UTC+8 day boundary', async () => {
    await task({ status: 'in_progress', dueOn: '2026-11-13' });
    assert.equal((await measures(todayUtc8(new Date('2026-11-13T15:59:00Z')))).overdue, 0, '23:59 UTC+8 on 13 Nov');
    assert.equal((await measures(todayUtc8(new Date('2026-11-13T16:00:00Z')))).overdue, 1, '00:00 UTC+8 on 14 Nov');
  });

  test('significant risks and overdue reviews', async () => {
    await risk('high', 'open', '2026-11-18');
    await risk('critical', 'mitigating', '2026-11-25');
    await risk('medium', 'open');
    await risk('low', 'accepted', '2026-11-01');
    await risk('high', 'resolved', '2026-11-01');
    await risk('low', 'open', '2026-11-19');
    await remove('risks', await risk('critical', 'open', '2026-11-01'));
    await hold('risks', await risk('high', 'open', '2026-11-01'), 'held');
    const m = await measures();
    assert.deepEqual(m.risks, { bySeverity: { low: 1, medium: 1, high: 1, critical: 1 }, significant: 2, overdueReviews: 2 });
    assert.equal(m.nextRiskReview, '2026-11-19');
  });

  test('questions, due soon, stage, planned end, invitations and next dates', async () => {
    for (const s of ['open', 'open', 'answered', 'resolved', 'withdrawn']) await question(s);
    await remove('questions', await question('open'));
    await task({ dueOn: '2026-11-19' });
    await task({ dueOn: '2026-11-26' });
    await task({ dueOn: '2026-11-27' });
    await task({ dueOn: '2026-11-20', status: 'completed' });
    await pool.query(`UPDATE projects SET planned_end = '2026-11-29' WHERE id = $1`, [project]);
    const invite = (expiresAt: string, status = 'invited') =>
      pool.query(
        `INSERT INTO invitations (id, project_id, email, role, starts_on, invited_by, token_hash, issued_at, expires_at, status)
         VALUES ($1, $2, $3, 'member', '2026-11-19', $4, $5, '2026-11-10T00:00:00Z', $6, $7)`,
        [uuidv7(), project, `${uuidv7().slice(-8)}@example.org`, pm, uuidv7(), expiresAt, status],
      );
    await invite('2026-11-25T00:00:00Z');
    await invite('2026-11-12T00:00:00Z');
    await invite('2026-11-25T00:00:00Z', 'declined');
    const m = (await loadProjectMeasures(pool, [project], TODAY, new Date('2026-11-19T02:00:00Z'))).get(project);
    assert.ok(m);
    assert.deepEqual(m.questions, { open: 2, answered: 1 });
    assert.equal(m.dueSoon, 3, 'seven working days from Thursday 19 Nov reach Monday 30 Nov');
    assert.deepEqual(m.stage, { stage: 'Initiation', substage: null, days: 18 });
    assert.deepEqual(m.plannedEnd, { state: 'ahead', days: 10 });
    assert.equal(m.pendingInvitations, 1);
    assert.equal(m.nextTaskDue, '2026-11-19');
    assert.equal(m.nextRiskReview, null);
    assert.equal(m.projectId, project);
  });

  test('due soon counts seven days by the project calendar, per project', async () => {
    const other = await workingProject();
    for (const projectId of [project, other]) {
      await task({ projectId, dueOn: '2026-11-19' });
      await task({ projectId, dueOn: '2026-11-30' }); // 11 calendar days, the 7th working day
      await task({ projectId, dueOn: '2026-12-01' }); // the 8th
      await task({ projectId, dueOn: '2026-11-30', status: 'completed' });
      await task({ projectId, dueOn: '2026-11-18' }); // overdue, not due soon
    }
    const dueSoon = async () => {
      const all = await loadProjectMeasures(pool, [project, other], TODAY);
      return [all.get(project)?.dueSoon, all.get(other)?.dueSoon];
    };
    assert.deepEqual(await dueSoon(), [2, 2]);
    await pool.query(`INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at) VALUES ($1, $2, '2026-11-25', 'Dummy holiday', $3, now())`, [uuidv7(), project, pm]);
    assert.deepEqual(await dueSoon(), [3, 2], 'a project holiday moves only that project end to 1 Dec');
    await pool.query(`INSERT INTO project_notification_settings (project_id, day_counting) VALUES ($1, 'calendar')`, [other]);
    assert.deepEqual(await dueSoon(), [3, 1], 'plain days: 19 to 26 Nov');
  });

  test('a project whose holidays leave no working day does not break the others', async () => {
    const other = await workingProject();
    for (const projectId of [project, other]) await task({ projectId, dueOn: '2026-11-26' });
    await pool.query(
      `INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at)
       SELECT gen_random_uuid(), $1, d::date, 'Dummy holiday', $2, now() FROM generate_series('2026-11-01'::date, '2027-12-31'::date, '1 day') d`,
      [project, pm],
    );
    const all = await loadProjectMeasures(pool, [project, other], TODAY);
    assert.equal(all.get(project)?.dueSoon, 1, 'plain days for the degenerate project');
    assert.equal(all.get(other)?.dueSoon, 1);
  });

  test('on-time completion uses the deferral day and the UTC+8 completion day', async () => {
    await task({ status: 'completed', dueOn: '2026-11-05', completedAt: '2026-11-05T15:59:00Z' });
    await task({ status: 'completed', dueOn: '2026-11-05', completedAt: '2026-11-05T16:00:00Z' });
    await task({ status: 'in_progress', dueOn: '2026-11-08' });
    await task({ status: 'in_progress', dueOn: '2026-11-12', review: true });
    await pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [project]);
    await pool.query(
      `INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, reason, at) VALUES ($1, $2, 'active', 'deferred', $3, 'Paused', '2026-11-09T16:30:00Z')`,
      [uuidv7(), project, pm],
    );
    const m = await measures();
    assert.deepEqual(m.onTime, { state: 'measured', due: 3, done: 2, late: 1, percent: 66, awaitingReview: 1 }, 'reference day 10 Nov');
    assert.equal(m.flags.deadlineReview, true);
  });

  test('the days in a stage stop at the deferral or closure, and run again once resumed (D138)', async () => {
    const move = (from: string, to: string, at: string) =>
      pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, reason, at) VALUES ($1, $2, $3, $4, $5, 'Why', $6)`, [uuidv7(), project, from, to, pm, at]);
    // Stage began 1 Nov (UTC+8); deferred at 00:30 on 10 Nov (UTC+8); today is 19 Nov.
    await move('active', 'deferred', '2026-11-09T16:30:00Z');
    assert.deepEqual((await measures()).stage, { stage: 'Initiation', substage: null, days: 9 });
    await move('deferred', 'closed', '2026-11-12T02:00:00Z');
    assert.equal((await measures()).stage?.days, 9, 'closed while Deferred: still from the deferral');
    await move('closed', 'active', '2026-11-15T02:00:00Z');
    await pool.query(`UPDATE project_stage_periods SET ended_at = '2026-11-15T02:00:00Z' WHERE project_id = $1`, [project]);
    await pool.query(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, 'Execution', '2026-11-15T02:00:00Z', $3)`, [uuidv7(), project, pm]);
    assert.deepEqual((await measures()).stage, { stage: 'Execution', substage: null, days: 4 });
    await move('active', 'closed', '2026-11-17T02:00:00Z');
    assert.equal((await measures()).stage?.days, 2);
  });

  test('flags: missing role, no independent escalation recipient, deadline review', async () => {
    assert.deepEqual((await measures()).flags, { missingRole: false, noIndependentEscalation: false, deadlineReview: false, escalationsOpen: 0 });
    const lonely = await seedProject(pool, { status: 'active', members: [{ userId: pm, role: 'pm' }] });
    const planned = await seedProject(pool, { status: 'planned', members: [{ userId: pm, role: 'pm' }] });
    const overdue = await task({ status: 'in_progress', dueOn: '2026-11-10' });
    await pool.query(
      `INSERT INTO notification_triggers (id, key, kind, project_id, record_kind, record_id, fire_at, decided_at, outcome)
       VALUES ($1, $2, 'overdue', $3, 'task', $4, now(), now(), 'no_recipient')`,
      [uuidv7(), `task:${overdue}:overdue:2026-11-10:0`, project, overdue],
    );
    await task({ status: 'not_started', review: true, projectId: lonely });
    const all = await loadProjectMeasures(pool, [project, lonely, planned], TODAY);
    assert.deepEqual(all.get(project)?.flags, { missingRole: false, noIndependentEscalation: true, deadlineReview: false, escalationsOpen: 1 });
    assert.deepEqual(all.get(lonely)?.flags, { missingRole: true, noIndependentEscalation: false, deadlineReview: true, escalationsOpen: 0 });
    assert.equal(all.get(planned)?.flags.missingRole, false, 'only an Active project is missing a role');
    assert.equal(all.get(lonely)?.overdue, 0, 'a task awaiting deadline review is not overdue');
    assert.deepEqual(all.get(planned)?.completion, { state: 'not_measurable', cancelled: 0 });
  });

  test('batch loader runs a fixed number of queries for 1 and 20 projects', async () => {
    const ids = [project];
    for (let i = 0; i < 19; i++) ids.push(await workingProject());
    for (const id of ids) await task({ projectId: id, status: 'completed' });
    let count = 0;
    const counting = { query: (...args: unknown[]) => { count++; return (pool.query as (...a: unknown[]) => unknown)(...args); } } as unknown as Pool;
    const one = await loadProjectMeasures(counting, [project], TODAY);
    const single = count;
    count = 0;
    const twenty = await loadProjectMeasures(counting, ids, TODAY);
    assert.equal(count, single, `${single} queries for 1 project, ${count} for 20`);
    assert.equal(one.size, 1);
    assert.equal(twenty.size, 20);
    assert.ok([...twenty.values()].every((m) => m.completion.state === 'measurable' && m.completion.done === 1));
    assert.equal((await loadProjectMeasures(counting, [], TODAY)).size, 0);
  });
});
