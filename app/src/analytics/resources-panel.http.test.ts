import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

/** A small RFC 4180 reader for the data lines (after the # lines). */
function parseCsv(text: string): { meta: string[]; rows: string[][] } {
  const lines = text.split('\r\n');
  const meta = lines.filter((l) => l.startsWith('#'));
  const rows = lines
    .filter((l) => !l.startsWith('#') && l !== '')
    .map((l) => {
      const cells: string[] = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (quoted) {
          if (ch === '"' && l[i + 1] === '"') {
            cell += '"';
            i++;
          } else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          cells.push(cell);
          cell = '';
        } else cell += ch;
      }
      cells.push(cell);
      return cells;
    });
  return { meta, rows };
}

const LIMITED = 'Only counts are shown: you are not a participant in this project.';

// The test clock starts at 2026-11-09T02:00Z: today is Monday 2026-11-09 (UTC+8); the default period is 2026-08-24 to 2026-11-09.
describe('analytics Resources and finance panel', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let member: Client;
  let adminId: string;
  let pmId: string;
  let deptA: string;
  let deptB: string;
  let alpha: string;
  let beta: string;
  let gamma: string;
  let zeta: string;
  let projector: string;
  let ladder: string;

  async function line(
    project: string,
    o: { item?: string | null; status?: string; startsOn?: string | null; endsOn?: string | null; neededBy?: string | null; description?: string } = {},
  ): Promise<string> {
    const id = uuidv7();
    const item = o.item === undefined ? null : o.item;
    await t.pool.query(
      `INSERT INTO resource_lines (id, project_id, item_id, one_off_kind, description, quantity, unit, starts_on, ends_on, needed_by, notes, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 2, 'items', $6, $7, $8, 'Private notes', $9, $10, now(), now())`,
      [id, project, item, item ? null : 'other', item ? '' : (o.description ?? 'One-off hire'), o.startsOn ?? null, o.endsOn ?? null, o.neededBy ?? null, o.status ?? 'needed', pmId],
    );
    return id;
  }
  const finishedAt = (lineId: string, at: string) =>
    t.pool.query(
      `INSERT INTO resource_line_events (id, line_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, 'status_changed', $3, $4, NULL, $5)`,
      [uuidv7(), lineId, pmId, new Date(at), JSON.stringify({ previous: { status: 'in_use' }, next: { status: 'finished' } })],
    );
  async function finance(project: string, currency: string, budget: string | null, spent: string | null) {
    await t.pool.query(`INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, 'enabled', $2)`, [project, currency]);
    const cr = async (kind: string, targetKind: string) => {
      const id = uuidv7();
      await t.pool.query(
        `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
         VALUES ($1, $2, $3, $4, $5, 1, 1, 'authorised', $6, now())`,
        [id, project, kind, targetKind, project, pmId],
      );
      return id;
    };
    if (budget) {
      await t.pool.query(`INSERT INTO budget_versions (id, project_id, amount, currency, change_request_id, approved_at) VALUES ($1, $2, $3, $4, $5, now())`, [
        uuidv7(), project, budget, currency, await cr('set_budget', 'project_budget'),
      ]);
    }
    if (spent) {
      await t.pool.query(
        `INSERT INTO expenditures (id, project_id, spent_on, amount, currency, description, reference, recorded_by, recorded_at)
         VALUES ($1, $2, '2026-11-02', $3, $4, 'Survey pegs from Dummy Supplier', 'INV-77', $5, now())`,
        [uuidv7(), project, spent, currency, pmId],
      );
    }
  }

  beforeEach(async () => {
    t = await startTestApp();
    adminId = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    pmId = await seedUser(t.pool, 'pm@example.org');
    deptA = await seedDepartment(t.pool, 'Alpha Unit');
    deptB = await seedDepartment(t.pool, 'Beta Unit');
    // The Administrator is a Member of Alpha only.
    alpha = await seedProject(t.pool, { status: 'active', name: 'Alpha works', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }, { userId: adminId, role: 'member' }] });
    beta = await seedProject(t.pool, { status: 'active', name: 'Beta works', departmentId: deptA, members: [{ userId: pmId, role: 'pm' }] });
    gamma = await seedProject(t.pool, { status: 'active', name: '=Gamma yard', departmentId: deptB, members: [{ userId: pmId, role: 'pm' }] });
    zeta = await seedProject(t.pool, { status: 'planned', name: 'Zeta plan', departmentId: deptB, members: [{ userId: pmId, role: 'pm' }] });
    projector = uuidv7();
    ladder = uuidv7();
    await t.pool.query(
      `INSERT INTO resource_items (id, kind, reference, name, created_by, created_at) VALUES ($1, 'equipment', 'P-04', 'Dummy projector', $3, now()), ($2, 'equipment', 'L-01', 'Dummy ladder', $3, now())`,
      [projector, ladder, pmId],
    );
    // Alpha: Needed past its needed-by date and overlapping; Arranged; In use; two Finished (one inside the period, one before it).
    await line(alpha, { item: projector, startsOn: '2026-11-20', endsOn: '2026-11-30', neededBy: '2026-11-05' });
    await line(alpha, { item: ladder, status: 'arranged', startsOn: '2026-12-01', endsOn: '2026-12-02' });
    await line(alpha, { status: 'in_use' });
    await finishedAt(await line(alpha, { status: 'finished' }), '2026-09-10T04:00:00Z');
    await finishedAt(await line(alpha, { status: 'finished' }), '2026-05-01T04:00:00Z');
    // Beta and Gamma overlap Alpha's projector line; Gamma also has a Cancelled ladder line that overlaps nothing.
    await line(beta, { item: projector, status: 'arranged', startsOn: '2026-11-25', endsOn: '2026-12-05' });
    await line(gamma, { item: projector, startsOn: '2026-11-28' });
    await line(gamma, { item: ladder, status: 'cancelled', startsOn: '2026-12-01', endsOn: '2026-12-02' });
    await finance(alpha, 'MYR', '1000.00', '850.00');
    await finance(beta, 'MYR', null, null);
    await finance(gamma, 'USD', '500.00', '600.00');
    admin = await t.signIn('admin@example.org');
    member = await t.signIn('member@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const panel = async (query = '') => (await admin.request('GET', `/admin/analytics?panel=resources${query ? `&${query}` : ''}`)).body.data;
  const exportOf = (query: string, who: Client = admin) => who.raw('GET', `/admin/analytics/export?panel=resources&${query}`);
  const drill = (query: string, who: Client = admin) => who.request('GET', `/admin/analytics/drill?${query}`);

  test('analytics.view is required, on the panel, the export and the drill-down', async () => {
    assert.equal((await member.request('GET', '/admin/analytics?panel=resources')).status, 403);
    assert.equal((await exportOf('table=lines', member)).status, 403);
    assert.equal((await drill('level=org&measure=linesNeeded', member)).status, 403);
  });

  test('the lines table: organisation, department and project rows', async () => {
    const r = await admin.request('GET', '/admin/analytics?panel=resources');
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.deepEqual(d.lines.organisation, { needed: 2, arranged: 2, inUse: 1, finishedInPeriod: 1, neededByPassed: 1, overlapping: 3 });
    const a = d.lines.projects.find((p: any) => p.name === 'Alpha works');
    assert.deepEqual(
      { needed: a.needed, arranged: a.arranged, inUse: a.inUse, finishedInPeriod: a.finishedInPeriod, neededByPassed: a.neededByPassed, overlapping: a.overlapping },
      { needed: 1, arranged: 1, inUse: 1, finishedInPeriod: 1, neededByPassed: 1, overlapping: 1 },
    );
    assert.equal(a.owningDepartment, 'Alpha Unit');
    const dept = d.lines.departments.find((x: any) => x.name === 'Alpha Unit');
    assert.equal(dept.projects, 2);
    assert.equal(dept.arranged, 2);
    const zero = d.lines.projects.find((p: any) => p.name === 'Zeta plan');
    assert.equal(zero.needed + zero.arranged + zero.inUse, 0);
    assert.ok(d.computedAt);
    assert.equal(r.body.definitionsVersion, '1');
    // The period moves "Finished in the period" and nothing else.
    const early = await panel('period=last_4w');
    assert.equal(early.lines.organisation.finishedInPeriod, 0);
    assert.equal(early.lines.organisation.needed, 2);
  });

  test('filters by department and status', async () => {
    const byDept = await panel(`department=${deptB}&ownership=owned`);
    assert.deepEqual(byDept.lines.projects.map((p: any) => p.name), ['=Gamma yard', 'Zeta plan']);
    assert.equal(byDept.lines.organisation.needed, 1);
    assert.equal(byDept.lines.organisation.overlapping, 1);
    // Only Gamma is in scope for the projector now: nothing is shared inside the scope.
    assert.deepEqual(byDept.sharedItems, []);
    assert.equal(byDept.notRequired, 1);
    assert.deepEqual(byDept.finance.map((g: any) => g.currency), ['USD']);

    const planned = await panel('status=planned');
    assert.deepEqual(planned.lines.projects.map((p: any) => p.name), ['Zeta plan']);
    assert.equal(planned.lines.organisation.needed, 0);
    assert.equal(planned.finance.length, 0);
    assert.equal(planned.notRequired, 1);
    assert.equal((await admin.request('GET', '/admin/analytics?panel=resources&status=nope')).status, 400);
  });

  test('shared items: projects and earliest overlap, ordered by projects then reference', async () => {
    await t.pool.query(`UPDATE resource_lines SET status = 'arranged' WHERE item_id = $1 AND project_id = $2`, [ladder, gamma]);
    await line(beta, { item: ladder, startsOn: '2026-12-02' });
    const d = await panel();
    assert.deepEqual(d.sharedItems, [
      { itemId: ladder, reference: 'L-01', name: 'Dummy ladder', projects: 3, earliestOverlap: '2026-12-01' },
      { itemId: projector, reference: 'P-04', name: 'Dummy projector', projects: 3, earliestOverlap: '2026-11-25' },
    ]);
    // An ended line is not current or future.
    await t.pool.query(`UPDATE resource_lines SET ends_on = '2026-11-01', starts_on = '2026-10-01' WHERE item_id = $1 AND project_id = $2`, [projector, beta]);
    assert.equal((await panel()).sharedItems.find((s: any) => s.reference === 'P-04').projects, 2);
  });

  test('finance is grouped per currency and never mixed; not-required projects are counted apart', async () => {
    const d = await panel();
    assert.deepEqual(
      d.finance.map((g: any) => [g.currency, g.projectsTracking, g.budgetNotProvided, g.totalBudget, g.totalSpent, g.atFirst, g.atSecond]),
      [
        ['MYR', 2, 1, '1000.00', '850.00', 1, 0],
        ['USD', 1, 0, '500.00', '600.00', 1, 1],
      ],
    );
    assert.deepEqual(d.finance[0].projects.map((p: any) => [p.name, p.budget, p.spent, p.level]), [
      ['Alpha works', '1000.00', '850.00', 1],
      ['Beta works', null, '0.00', 0],
    ]);
    assert.equal(d.notRequired, 1);
    // Summary figures only.
    assert.doesNotMatch(JSON.stringify(d), /Survey pegs|Dummy Supplier|INV-77/);
  });

  test('CSV: one export per table, with # headers, escaping and an audit record', async () => {
    assert.equal((await exportOf('')).status, 400);
    assert.equal((await exportOf('table=entries')).status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'analytics.exported'`)).rows[0].n, 0);

    const lines = await exportOf('table=lines');
    assert.equal(lines.status, 200, lines.text);
    assert.match(lines.headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(lines.headers.get('content-disposition'), 'attachment; filename="kainow-resources-lines-2026-11-09.csv"');
    const parsed = parseCsv(lines.text);
    assert.equal(parsed.meta[0], '# Panel: Resources and finance: Resource lines');
    assert.ok(parsed.meta.some((m) => m.startsWith('# Period: Last 12 weeks, 2026-08-24 to 2026-11-09')));
    assert.ok(parsed.meta.some((m) => m.startsWith('# Measure definitions version: 1')));
    assert.deepEqual(parsed.rows[0], ['Level', 'Name', 'Owning department', 'Projects', 'Needed', 'Arranged', 'In use', 'Finished in the period', 'Needed-by passed', 'Lines with overlaps']);
    assert.deepEqual(parsed.rows.find((r) => r[0] === 'Project' && r[1] === 'Alpha works'), ['Project', 'Alpha works', 'Alpha Unit', '', '1', '1', '1', '1', '1', '1']);
    // A project named "=Gamma yard" is guarded against formula injection.
    assert.ok(parsed.rows.some((r) => r[1] === "'=Gamma yard"));
    assert.deepEqual(parsed.rows.find((r) => r[0] === 'Organisation')?.slice(3), ['4', '2', '2', '1', '1', '1', '3']);

    const shared = parseCsv((await exportOf('table=sharedItems')).text).rows;
    assert.deepEqual(shared, [['Reference', 'Name', 'Projects', 'Earliest overlap'], ['P-04', 'Dummy projector', '3', '2026-11-25']]);

    const fin = await exportOf('table=finance');
    const rows = parseCsv(fin.text).rows;
    assert.equal(rows[0][0], 'Currency');
    assert.deepEqual(rows.find((r) => r[0] === 'USD' && r[1] === 'Currency total'), ['USD', 'Currency total', 'All USD projects', '', '1', '0', '500.00', 'USD', '600.00', 'USD', '1', '1', '', '', '', '']);
    assert.equal(rows[0].length, 16);
    assert.ok(rows.every((r) => r.length === 16));
    assert.deepEqual(rows.find((r) => r[0] === 'MYR' && r[2] === 'Beta works'), ['MYR', 'Project', 'Beta works', 'Alpha Unit', '', '', 'Not provided', 'MYR', '0.00', 'MYR', '', '', 'Not provided', 'No', '0', 'None']);
    assert.deepEqual(rows.find((r) => r[0] === 'USD' && r[1] === 'Project')?.slice(12, 15), ['120', 'Over budget', '2']);
    assert.deepEqual(rows.find((r) => r[1] === 'Not required')?.slice(4, 9), ['1', '', 'Not required', '', 'Not required']);
    assert.doesNotMatch(fin.text, /Survey pegs|Dummy Supplier|INV-77/);

    const audit = (await t.pool.query(`SELECT actor_user_id, detail FROM audit_events WHERE action = 'analytics.exported' ORDER BY id`)).rows;
    assert.equal(audit.length, 3);
    assert.deepEqual(audit.map((a) => a.detail.table).sort(), ['finance', 'lines', 'sharedItems']);
    const one = audit.find((a) => a.detail.table === 'lines');
    assert.equal(one.actor_user_id, adminId);
    assert.deepEqual(Object.keys(one.detail).sort(), ['filters', 'panel', 'table']);
    assert.equal(one.detail.panel, 'resources');
    assert.doesNotMatch(JSON.stringify(one.detail), /Alpha works|P-04/);
  });

  test('definitions list the new measures', async () => {
    const r = await admin.request('GET', '/admin/analytics/definitions');
    for (const key of ['resourceLines', 'finishedInPeriod', 'neededByPassed', 'resourceOverlap', 'sharedItems', 'financeSummary', 'financeNotRequired']) {
      assert.ok(r.body.measures.some((m: any) => m.key === key), key);
    }
  });

  test('drill-down: counts for everyone; line detail only where the Administrator is a participant', async () => {
    const org = await drill('level=org&measure=linesNeeded');
    assert.equal(org.status, 200, JSON.stringify(org.body));
    assert.equal(org.body.counts.total, 2);

    // Not a participant in Beta: counts and the limited notice only.
    const theirs = await drill(`level=project&id=${beta}&measure=linesOverlapping`);
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(theirs.body.counts.total, 1);
    assert.equal(theirs.body.limited, LIMITED);
    assert.equal(theirs.body.lines, undefined);
    assert.equal(theirs.body.records, undefined);

    // A participant in Alpha: the line's Resources-tab fields.
    const mine = await drill(`level=project&id=${alpha}&measure=linesNeededByPassed`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.counts.total, 1);
    assert.equal(mine.body.limited, undefined);
    assert.equal(mine.body.lines.length, 1);
    assert.equal(mine.body.lines[0].item.reference, 'P-04');
    assert.equal(mine.body.lines[0].neededByPassed, true);
    assert.equal(mine.body.lines[0].notes, 'Private notes');
    const finished = await drill(`level=project&id=${alpha}&measure=linesFinished`);
    assert.equal(finished.body.lines.length, 1);

    // Finance: counts only, even for a participant.
    const fin = await drill(`level=project&id=${alpha}&measure=financeAtFirst`);
    assert.equal(fin.body.counts.total, 1);
    assert.equal(fin.body.lines, undefined);
    assert.equal(fin.body.records, undefined);
    const dept = await drill(`level=department&id=${deptB}&measure=financeAtSecond`);
    assert.equal(dept.body.counts.total, 1);
    assert.deepEqual(dept.body.counts.breakdown.map((b: any) => [b.name, b.value]), [['=Gamma yard', 1]]);
    assert.equal(dept.body.notRequired, 1);
    const zetaDrill = await drill(`level=project&id=${zeta}&measure=financeBudgetNotProvided`);
    assert.equal(zetaDrill.body.notRequired, 1);
    // Not required has no finance figure: the total is null, never 0.
    assert.equal(zetaDrill.body.counts.total, null);
    assert.equal((await drill('level=org&measure=financeAtFirst')).body.notRequired, 1);
    assert.equal((await drill('level=org&measure=linesNeeded')).body.notRequired, undefined);
    assert.equal((await drill(`level=org&measure=financeBudgetNotProvided`)).body.counts.total, 1);
    // A project outside the filters is not found.
    assert.equal((await drill(`level=project&id=${zeta}&measure=linesNeeded&status=active`)).status, 404);
  });
});
