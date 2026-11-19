import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

/**
 * Cross-surface consistency (dashboards spec section 14): for one seeded project, the personal header, the project
 * dashboard, the leadership card, the analytics progress row (and its department roll-up and drill-down) and the CSV
 * row give the same task-completion and On-time figures, number for number.
 *
 * The test clock starts at 2026-11-09T02:00Z: today is Monday 2026-11-09 (UTC+8).
 */

/** The figures every surface must agree on. */
interface Figures {
  done: number;
  total: number;
  cancelled: number;
  percent: number;
  due: number;
  dueDone: number;
  late: number;
  onTimePercent: number;
  awaitingReview: number;
  overdue: number;
}

const EXPECTED: Figures = { done: 31, total: 50, cancelled: 4, percent: 62, due: 32, dueDone: 25, late: 5, onTimePercent: 78, awaitingReview: 2, overdue: 7 };

/** The wording the views give (spec 3), built from a surface's own numbers. */
const completionLine = (f: Figures) => `${f.percent}% task completion (${f.done} of ${f.total} tasks)`;
const cancelledLine = (f: Figures) => `${f.cancelled} cancelled`;
const onTimeLine = (f: Figures) => `${f.dueDone} of ${f.due} tasks due so far are done (${f.onTimePercent}%)`;
const awaitingLine = (f: Figures) => `Awaiting deadline review: ${f.awaitingReview}`;

/** Server measures (`completion`, `onTime`) as Figures. */
function fromMeasures(completion: any, onTime: any, overdue: number): Figures {
  assert.equal(completion.state, 'measurable');
  assert.equal(onTime.state, 'measured');
  return {
    done: completion.done,
    total: completion.total,
    cancelled: completion.cancelled,
    percent: completion.percent,
    due: onTime.due,
    dueDone: onTime.done,
    late: onTime.late,
    onTimePercent: onTime.percent,
    awaitingReview: onTime.awaitingReview,
    overdue,
  };
}

/** The data rows of a CSV export, keyed by column (cells hold no commas or quotes here). */
function csvRows(text: string): Array<Record<string, string>> {
  const lines = text.split('\r\n').filter((l) => l !== '' && !l.startsWith('#'));
  const [head, ...rest] = lines.map((l) => l.split(','));
  return rest.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ''])));
}

describe('dashboard consistency', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let leader: Client;
  let pmId: string;
  let memId: string;
  let leaderId: string;
  let dept: string;
  let project: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    pmId = await seedUser(t.pool, 'pm@example.org');
    memId = await seedUser(t.pool, 'mem@example.org');
    leaderId = await seedUser(t.pool, 'leader@example.org');
    dept = await seedDepartment(t.pool, 'Alpha Unit');
    project = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour works',
      departmentId: dept,
      members: [{ userId: pmId, role: 'pm' }, { userId: pmId, role: 'owner' }, { userId: memId, role: 'member' }],
    });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    leader = await t.signIn('leader@example.org');
    const g = await admin.request('POST', '/admin/leadership-grants', { userId: leaderId, scope: { kind: 'projects', projectIds: [project] }, startsOn: '2026-11-09', reason: 'Oversight' });
    assert.equal(g.status, 201, JSON.stringify(g.body));
  });
  afterEach(async () => {
    await t?.close();
  });

  let n = 0;
  async function task(opts: { status?: string; dueOn: string; completedOn?: string; review?: boolean; parentId?: string }): Promise<string> {
    const id = uuidv7();
    n += 1;
    const status = opts.status ?? 'not_started';
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, completed_at, deadline_review_required, authorised_by, authorised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '2026-11-01T02:00:00Z')`,
      [
        id, project, opts.parentId ?? null, opts.parentId ? 1 : 0, `Task ${n}`, memId, opts.dueOn, status,
        status === 'completed' ? `${opts.completedOn as string}T02:00:00Z` : null, opts.review ?? false, pmId,
      ],
    );
    return id;
  }
  const many = async (count: number, opts: Parameters<typeof task>[0]): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(await task(opts));
    return out;
  };
  async function remove(id: string): Promise<void> {
    await t.pool.query(`UPDATE tasks SET deleted_at = now(), deleted_by = $2, delete_reason = 'Entered in error' WHERE id = $1`, [id, pmId]);
  }
  async function hold(id: string, state: 'held' | 'cleaned'): Promise<void> {
    const caseId = uuidv7();
    await t.pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reason, marked_length, state, waiting_for_key, reported_at, cleaned_at)
       VALUES ($1, $2, 'task', $3, 'Reported', 8, $4, $5, now(), CASE WHEN $4 = 'cleaned' THEN now() END)`,
      [caseId, project, id, state, state === 'held'],
    );
    await t.pool.query(`UPDATE tasks SET held_case_id = $2 WHERE id = $1`, [id, caseId]);
  }

  /**
   * 50 eligible leaves: 31 Completed (25 due before today, 5 of them late; 6 due later, one of them a cleaned held
   * record), 7 open and overdue (one a parent whose only subtask is Deleted), 2 awaiting deadline review and 10 due
   * later (2 of them subtasks of a parent, which is not a leaf). Plus 4 Cancelled leaves, and Deleted and uncleaned
   * held tasks of every kind that must count nowhere.
   */
  async function seed(): Promise<void> {
    await many(20, { status: 'completed', dueOn: '2026-11-02', completedOn: '2026-11-01' });
    await many(5, { status: 'completed', dueOn: '2026-11-02', completedOn: '2026-11-06' });
    const later = await many(6, { status: 'completed', dueOn: '2026-11-20', completedOn: '2026-11-05' });
    await hold(later[0], 'cleaned');
    const overdue = [
      ...(await many(4, { dueOn: '2026-11-03' })),
      ...(await many(2, { status: 'in_progress', dueOn: '2026-11-04' })),
      ...(await many(1, { status: 'blocked', dueOn: '2026-11-05' })),
    ];
    // A parent whose subtasks are all Deleted counts as a leaf.
    await remove(await task({ dueOn: '2026-11-03', parentId: overdue[0] }));
    await many(2, { dueOn: '2026-11-03', review: true });
    await many(8, { dueOn: '2026-11-25' });
    const parent = await task({ status: 'in_progress', dueOn: '2026-11-30' });
    await many(2, { dueOn: '2026-11-25', parentId: parent });
    await many(4, { status: 'cancelled', dueOn: '2026-11-02' });

    // Counted nowhere: Deleted and uncleaned held tasks, completed, open, overdue and cancelled.
    for (const opts of [
      { status: 'completed', dueOn: '2026-11-02', completedOn: '2026-11-06' },
      { dueOn: '2026-11-03' },
      { status: 'cancelled', dueOn: '2026-11-02' },
      { dueOn: '2026-11-04', review: true },
    ]) {
      await remove(await task(opts));
      await hold(await task(opts), 'held');
    }
    await remove(await task({ dueOn: '2026-11-03', parentId: parent }));
    await hold(await task({ status: 'completed', dueOn: '2026-11-25', completedOn: '2026-11-04', parentId: parent }), 'held');
  }

  const ok = async (r: Promise<{ status: number; body: any }>) => {
    const x = await r;
    assert.equal(x.status, 200, JSON.stringify(x.body));
    return x.body;
  };

  test('task completion and On-time are identical', async () => {
    await seed();

    const me = await ok(pm.request('GET', '/dashboard/me'));
    const mine = me.projects.find((p: any) => p.id === project);
    const personal = fromMeasures(mine.header.completion, mine.expanded.onTime, mine.header.flags.overdue);

    const dash = await ok(pm.request('GET', `/projects/${project}/dashboard`));
    const projectView = fromMeasures(dash.measures.completion, dash.measures.onTime, dash.measures.overdue);

    const summary = await ok(leader.request('GET', '/dashboard/leadership'));
    const card = summary.cards.find((c: any) => c.id === project);
    const leadership = fromMeasures(card.taskCompletion, card.onTime, card.overdue);

    const progress = await ok(admin.request('GET', '/admin/analytics?panel=progress'));
    const row = progress.data.projects.find((r: any) => r.id === project);
    const analytics = fromMeasures(row.completion, row.onTime, row.overdue);

    // The department roll-up holds one project, so it equals the project row.
    const roll = progress.data.departments.find((d: any) => d.id === dept);
    const rollFigures: Figures = {
      done: roll.tasksDone,
      total: roll.tasksTotal,
      cancelled: EXPECTED.cancelled, // a roll-up gives no cancelled count
      percent: roll.completionPercent,
      due: roll.onTimeDue,
      dueDone: roll.onTimeDone,
      late: roll.onTimeLate,
      onTimePercent: roll.onTimePercent,
      awaitingReview: EXPECTED.awaitingReview, // nor an awaiting-review count
      overdue: roll.overdue,
    };

    const drill = async (measure: string) => (await ok(admin.request('GET', `/admin/analytics/drill?level=project&id=${project}&measure=${measure}`))).counts.total;
    const c = await drill('completion');
    const o = await drill('onTime');
    const drilled: Figures = {
      done: c.done,
      total: c.total,
      cancelled: c.cancelled,
      percent: Math.floor((c.done * 100) / c.total),
      due: o.due,
      dueDone: o.done,
      late: o.late,
      onTimePercent: Math.floor((o.done * 100) / o.due),
      awaitingReview: o.awaitingReview,
      overdue: await drill('overdueTasks'),
    };

    const exported = await admin.raw('GET', '/admin/analytics/export?panel=progress');
    assert.equal(exported.status, 200, exported.text);
    const rows = csvRows(exported.text);
    const line = rows.find((r) => r.Level === 'Project' && r.Name === 'Harbour works') as Record<string, string>;
    const deptLine = rows.find((r) => r.Level === 'Department' && r.Name === 'Alpha Unit') as Record<string, string>;
    const csv: Figures = {
      done: Number(line['Completed tasks']),
      total: Number(line['Eligible tasks']),
      cancelled: Number(line['Cancelled tasks']),
      percent: Number(line['Task completion %']),
      due: Number(line['Due so far']),
      dueDone: Number(line.Done),
      late: Number(line.Late),
      onTimePercent: Number(line['On-time completion %']),
      awaitingReview: Number(line['Awaiting deadline review']),
      overdue: Number(line.Overdue),
    };
    assert.deepEqual(
      [deptLine['Completed tasks'], deptLine['Eligible tasks'], deptLine['Task completion %'], deptLine['Due so far'], deptLine.Done, deptLine.Late, deptLine['On-time completion %'], deptLine.Overdue].map(Number),
      [31, 50, 62, 32, 25, 5, 78, 7],
    );

    const surfaces: Record<string, Figures> = { personal, projectView, leadership, analytics, rollFigures, drilled, csv };
    for (const [name, f] of Object.entries(surfaces)) {
      assert.deepEqual(f, EXPECTED, name);
      assert.equal(completionLine(f), '62% task completion (31 of 50 tasks)', name);
      assert.equal(cancelledLine(f), '4 cancelled', name);
      assert.equal(onTimeLine(f), '25 of 32 tasks due so far are done (78%)', name);
      assert.equal(awaitingLine(f), 'Awaiting deadline review: 2', name);
    }
  });

  test('a change to one record moves every surface together', async () => {
    await seed();
    // One overdue task is finished late today: 32 of 50, and 26 of 32 due so far (6 late).
    const id = (await t.pool.query(`SELECT id FROM tasks WHERE project_id = $1 AND status = 'blocked' AND deleted_at IS NULL AND held_case_id IS NULL`, [project])).rows[0].id;
    await t.pool.query(`UPDATE tasks SET status = 'completed', completed_at = '2026-11-09T01:00:00Z' WHERE id = $1`, [id]);
    const want = { done: 32, total: 50, percent: 64, due: 32, dueDone: 26, late: 6, onTimePercent: 81 };

    const pick = (f: Figures) => ({ done: f.done, total: f.total, percent: f.percent, due: f.due, dueDone: f.dueDone, late: f.late, onTimePercent: f.onTimePercent });
    const me = await ok(pm.request('GET', '/dashboard/me'));
    const mine = me.projects.find((p: any) => p.id === project);
    assert.deepEqual(pick(fromMeasures(mine.header.completion, mine.expanded.onTime, 0)), want);
    const dash = await ok(pm.request('GET', `/projects/${project}/dashboard`));
    assert.deepEqual(pick(fromMeasures(dash.measures.completion, dash.measures.onTime, 0)), want);
    const card = (await ok(leader.request('GET', '/dashboard/leadership'))).cards[0];
    assert.deepEqual(pick(fromMeasures(card.taskCompletion, card.onTime, 0)), want);
    const row = (await ok(admin.request('GET', '/admin/analytics?panel=progress'))).data.projects.find((r: any) => r.id === project);
    assert.deepEqual(pick(fromMeasures(row.completion, row.onTime, 0)), want);
    const line = csvRows((await admin.raw('GET', '/admin/analytics/export?panel=progress')).text).find((r) => r.Level === 'Project') as Record<string, string>;
    assert.deepEqual(
      [line['Completed tasks'], line['Eligible tasks'], line['Task completion %'], line['Due so far'], line.Done, line.Late, line['On-time completion %']].map(Number),
      [32, 50, 64, 32, 26, 6, 81],
    );
  });
});
