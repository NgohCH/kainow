import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { COVERAGE_NOTE, MEASURE_DEFINITIONS } from '../dashboards/measures';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { PROBLEM_KEYS } from './panels.service';

/** A small RFC 4180 reader for the data lines (after the # lines). */
function parseCsv(text: string): { meta: string[]; rows: string[][] } {
  const lines = text.split('\r\n');
  const meta = lines.filter((l) => l.startsWith('#'));
  const body = lines.filter((l) => !l.startsWith('#')).join('\r\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { meta, rows };
}

// The test clock starts at 2026-11-09T02:00Z: today is Monday 2026-11-09 (UTC+8).
describe('analytics definitions and CSV export', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;
  let pmId: string;
  let deptA: string;
  let pa: string;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    pmId = await seedUser(t.pool, 'pm@example.org');
    deptA = await seedDepartment(t.pool, 'Alpha Unit');
    const deptB = await seedDepartment(t.pool, 'Beta Unit');
    pa = await seedProject(t.pool, { status: 'active', name: 'Alpha works', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }] });
    await seedProject(t.pool, { status: 'active', name: '=Beta works', departmentId: deptB, members: [{ userId: pmId, role: 'pm' }] });
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('member@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  async function task(project: string, dueOn: string, status = 'not_started', completedAt: string | null = null) {
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, completed_at, deadline_review_required, authorised_by, authorised_at)
       VALUES ($1, $2, NULL, 0, 'Task', $3, $4, $5, $6, false, $3, now())`,
      [uuidv7(), project, pmId, dueOn, status, completedAt],
    );
  }
  const exportOf = (query: string, who: Client = admin) => who.raw('GET', `/admin/analytics/export?${query}`);

  test('definitions: version, measures and the event catalogue', async () => {
    assert.equal((await member.request('GET', '/admin/analytics/definitions')).status, 403);
    const r = await admin.request('GET', '/admin/analytics/definitions');
    assert.equal(r.status, 200);
    assert.equal(r.body.version, '1');
    assert.deepEqual(r.body.measures, MEASURE_DEFINITIONS);
    assert.ok(r.body.events.some((e: any) => e.name === 'analytics.exported' && e.table === 'audit_events'));
    assert.ok(r.body.events.some((e: any) => e.name === 'granted' && e.table === 'leadership_grant_events'));
  });

  test('member gets 403; an unknown panel or bad filter is 400', async () => {
    assert.equal((await exportOf('panel=progress', member)).status, 403);
    assert.equal((await exportOf('panel=nope')).status, 400);
    assert.equal((await exportOf('panel=progress&period=last_5w')).status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'analytics.exported'`)).rows[0].n, 0);
  });

  test('export off is 403', async () => {
    await t.pool.query(`UPDATE access_settings SET analytics_export_allowed = false`);
    const r = await exportOf('panel=progress');
    assert.equal(r.status, 403);
    assert.match(r.text, /Analytics export is turned off\./);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'analytics.exported'`)).rows[0].n, 0);
    await t.pool.query(`UPDATE access_settings SET analytics_export_allowed = true`);
    assert.equal((await exportOf('panel=progress')).status, 200);
  });

  test('export writes analytics.exported without data', async () => {
    await task(pa, '2026-11-02');
    const r = await exportOf(`panel=problems&period=last_4w&department=${deptA}&status=active`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="kainow-problems-2026-11-09.csv"');
    const rows = (await t.pool.query(`SELECT actor_user_id, detail FROM audit_events WHERE action = 'analytics.exported'`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, admin.userId);
    const detail = rows[0].detail;
    assert.deepEqual(Object.keys(detail).sort(), ['filters', 'panel']);
    assert.equal(detail.panel, 'problems');
    assert.deepEqual(detail.filters, {
      period: 'last_4w', from: '2026-10-19', to: '2026-11-09', departmentId: deptA, statuses: ['active'], ownership: 'both', includeArchived: false,
    });
    assert.doesNotMatch(JSON.stringify(detail), /Alpha works|Alpha Unit|overdue/i);
  });

  test('header lines start with # and carry version, computedAt and coverage', async () => {
    const r = await exportOf('panel=progress');
    const { meta, rows } = parseCsv(r.text);
    assert.deepEqual(meta, [
      '# Panel: Project progress',
      '# Filters: department: all; status: Planned, Active, Deferred; ownership: owned and contributed; include archived: no',
      '# Period: Last 12 weeks, 2026-08-24 to 2026-11-09',
      '# Measure definitions version: 1',
      `# Computed at: ${new Date(t.clock.now().getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} (UTC+8)`,
      `# Coverage: ${COVERAGE_NOTE}`,
    ]);
    assert.ok(r.text.startsWith('# Panel'));
    assert.ok(rows.length > 0);
    // A project named "=Beta works" is guarded against formula injection.
    assert.match(r.text, /\r\nProject,'=Beta works,/);
  });

  test('CSV row equals the panel row', async () => {
    await task(pa, '2026-11-02', 'completed', '2026-11-01T02:00:00Z');
    await task(pa, '2026-11-05', 'blocked');
    await task(pa, '2026-11-06');

    // Problems: the nine counts, organisation, department and project rows.
    const panel = (await admin.request('GET', '/admin/analytics?panel=problems')).body.data;
    const { rows } = parseCsv((await exportOf('panel=problems')).text);
    const [header, ...data] = rows;
    assert.deepEqual(header.slice(0, 4), ['Level', 'Name', 'Owning department', 'Projects']);
    assert.equal(header.length, 4 + PROBLEM_KEYS.length);
    const p = panel.projects.find((x: any) => x.name === 'Alpha works');
    const line = data.find((r) => r[0] === 'Project' && r[1] === 'Alpha works') as string[];
    assert.deepEqual(line, ['Project', 'Alpha works', 'Alpha Unit', '', ...PROBLEM_KEYS.map((k) => String(p[k]))]);
    const org = data.find((r) => r[0] === 'Organisation') as string[];
    assert.deepEqual(org.slice(4), PROBLEM_KEYS.map((k) => String(panel.organisation[k])));
    const dept = data.find((r) => r[0] === 'Department' && r[1] === 'Alpha Unit') as string[];
    const d = panel.departments.find((x: any) => x.name === 'Alpha Unit');
    assert.deepEqual(dept.slice(3), [String(d.projects), ...PROBLEM_KEYS.map((k) => String(d[k]))]);

    // Progress: the project row's figures.
    const prog = (await admin.request('GET', '/admin/analytics?panel=progress')).body.data;
    const pr = prog.projects.find((x: any) => x.name === 'Alpha works');
    const csv = parseCsv((await exportOf('panel=progress')).text).rows;
    const col = (name: string) => csv[0].indexOf(name);
    const row = csv.find((r) => r[0] === 'Project' && r[1] === 'Alpha works') as string[];
    assert.equal(row[col('Owning department')], 'Alpha Unit');
    assert.equal(row[col('Status')], 'Active');
    assert.equal(row[col('Stage template')], 'General');
    assert.equal(row[col('Stage')], pr.stage.stage);
    assert.equal(row[col('Days in stage')], String(pr.stage.days));
    assert.equal(row[col('Completed tasks')], String(pr.completion.done));
    assert.equal(row[col('Eligible tasks')], String(pr.completion.total));
    assert.equal(row[col('Task completion %')], String(pr.completion.percent));
    assert.equal(row[col('Due so far')], String(pr.onTime.due));
    assert.equal(row[col('Late')], String(pr.onTime.late));
    assert.equal(row[col('On-time completion %')], String(pr.onTime.percent));
    assert.equal(row[col('Planned end')], 'No planned end date');
    assert.equal(row[col('Overdue')], String(pr.overdue));
    assert.equal(row[col('Blocked')], String(pr.blocked));
    const nothing = csv.find((r) => r[0] === 'Project' && r[1] === "'=Beta works") as string[];
    assert.equal(nothing[col('Task completion %')], 'Progress not yet measurable');
    assert.equal(nothing[col('On-time completion %')], 'Nothing due yet');

    // Trends: one row per week, the same numbers.
    const tr = (await admin.request('GET', '/admin/analytics?panel=trends&period=last_4w')).body.data;
    const tcsv = parseCsv((await exportOf('panel=trends&period=last_4w')).text).rows;
    assert.equal(tcsv[0][0], 'Week starting');
    assert.equal(tcsv.length - 1, tr.weeks.length);
    const last = tcsv[tcsv.length - 1];
    assert.equal(last[0], tr.weeks[tr.weeks.length - 1]);
    assert.equal(last[tcsv[0].indexOf('Tasks authorised')], String(tr.series.tasks_authorised[tr.weeks.length - 1]));

    // System: area, measure, count.
    const sys = (await admin.request('GET', '/admin/analytics?panel=system')).body.data;
    const scsv = parseCsv((await exportOf('panel=system')).text).rows;
    assert.deepEqual(scsv[0], ['Area', 'Measure', 'Count']);
    assert.deepEqual(scsv.find((r) => r[1] === 'Emails failed in the period'), ['Emails', 'Emails failed in the period', String(sys.emails.failed)]);
  });
});
