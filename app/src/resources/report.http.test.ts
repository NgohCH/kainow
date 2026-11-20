import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { uuidv7 } from '../common/uuid7';
import { seedProject, seedUser } from '../testing/projects';

const START = Date.UTC(2026, 10, 9, 15, 50, 0);

describe('project resources report over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let ann: Client;
  let outsider: Client;
  let projectId: string;
  const url = (q = '') => `/projects/${projectId}/resources/report${q}`;
  const csv = (c: Client) => c.raw('GET', url('?format=csv'));

  beforeEach(async () => {
    t = await startTestApp(START);
    const ids: Record<string, string> = {};
    for (const p of ['pm', 'ann', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour Survey',
      members: [{ userId: ids.pm, role: 'pm' }, { userId: ids.ann, role: 'member' }],
    });
    pm = await t.signIn('pm@example.org');
    ann = await t.signIn('ann@example.org');
    outsider = await t.signIn('outsider@example.org');
    await t.pool.query(
      `INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, 'enabled', 'MYR')
       ON CONFLICT (project_id) DO UPDATE SET tracking = 'enabled', currency = 'MYR'`,
      [projectId],
    );
    const line = (body: Record<string, unknown>) => pm.request('POST', `/projects/${projectId}/resources/lines`, body);
    assert.equal((await line({ oneOffKind: 'other', description: 'Hired drone', notes: '=SUM(A1)' })).status, 201);
    assert.equal((await line({ oneOffKind: 'equipment', description: 'Winch, heavy', quantity: '2', unit: 'items', startsOn: '2026-12-03', endsOn: '2026-12-14', neededBy: '2026-11-01' })).status, 201);
    const spent = await pm.request('POST', `/projects/${projectId}/finance/spending`, { spentOn: '2026-11-05', amount: '100.00', currency: 'MYR', description: 'Drone deposit' });
    assert.equal(spent.status, 201, JSON.stringify(spent.body));
  });
  afterEach(async () => {
    await t?.close();
  });

  test('JSON: a Member has no finance; the PM has it; an outsider gets 404', async () => {
    const m = await ann.request('GET', url());
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal('finance' in m.body, false);
    assert.equal(m.body.header.note, 'Usage records, not bookings');
    assert.equal(m.body.header.project, 'Harbour Survey');
    assert.equal(m.body.lines.length, 2);
    assert.deepEqual(m.body.neededByPassed.map((l: { description: string }) => l.description), ['Winch, heavy']);
    const p = await pm.request('GET', url());
    assert.equal(p.status, 200);
    assert.equal(p.body.finance.entries.length, 1);
    assert.equal(p.body.finance.figures.spent, '100.00');
    assert.equal((await outsider.request('GET', url())).status, 404);
    assert.equal((await outsider.raw('GET', url('?format=csv'))).status, 404);
  });

  test('CSV: header lines, words for missing values, formula guard, currency beside amounts, filename', async () => {
    const r = await csv(pm);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(r.headers.get('content-disposition'), `attachment; filename="resources-${projectId}-2026-11-09.csv"`);
    const text = r.text;
    assert.ok(text.startsWith('# Report: Project resources\r\n'));
    assert.match(text, /# Project: Harbour Survey\r\n/);
    assert.match(text, /# Note: Usage records, not bookings\r\n/);
    for (const s of ['lines', 'people', 'finance']) assert.match(text, new RegExp(`# Section: ${s}\r\n`));
    assert.match(text, /Not provided/);
    assert.match(text, /Period not provided/);
    assert.match(text, /,'=SUM\(A1\)\r\n/);
    assert.match(text, /"Winch, heavy"/);
    assert.match(text, /Row,Name,Date,Amount,Amount currency,Counted amount,Counted currency,Details/);
    assert.match(text, /\r\nEntry,Drone deposit,2026-11-05,100\.00,MYR,100\.00,MYR,/);
    assert.match(text, /\r\nSummary,Approved budget,,Not provided,MYR,/);
  });

  test('CSV for a Member has no finance section; tracking off shows Not required for readers', async () => {
    const m = (await csv(ann)).text;
    assert.doesNotMatch(m, /# Section: finance/);
    await t.pool.query(`UPDATE project_finance_settings SET tracking = 'not_required' WHERE project_id = $1`, [projectId]);
    const j = await pm.request('GET', url());
    assert.equal(j.body.finance.historyOnly, true);
    const text = (await csv(pm)).text;
    assert.match(text, /\r\nSummary,Financial tracking,,,,,,Not required\r\n/);
    assert.match(text, /Financial tracking is not required for this project\. Earlier entries are kept here for reference\./);
  });

  test('overlap names only a project the viewer can open; the other is counted, with no leak in JSON or CSV', async () => {
    const owner = await seedUser(t.pool, 'other@example.org');
    const annId = (await t.pool.query(`SELECT id FROM users WHERE email = 'ann@example.org'`)).rows[0].id as string;
    const item = uuidv7();
    await t.pool.query(`INSERT INTO resource_items (id, kind, reference, name, created_by, created_at, status) VALUES ($1, 'equipment', 'P-04', 'Dummy projector', $2, now(), 'active')`, [item, owner]);
    const hidden = await seedProject(t.pool, { status: 'active', name: 'Hidden Yard', members: [{ userId: owner, role: 'pm' }] });
    const open = await seedProject(t.pool, { status: 'active', name: 'Open Works', members: [{ userId: owner, role: 'pm' }, { userId: annId, role: 'member' }] });
    for (const [pid, qty, notes] of [[hidden, 7, 'Secret hidden notes'], [open, 9, 'Open notes']] as const) {
      await t.pool.query(
        `INSERT INTO resource_lines (id, project_id, item_id, description, quantity, unit, starts_on, ends_on, notes, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, '', $4, 'items', '2026-12-05', '2026-12-10', $5, 'needed', $6, now(), now())`,
        [uuidv7(), pid, item, qty, notes, owner],
      );
    }
    assert.equal((await pm.request('POST', `/projects/${projectId}/resources/lines`, { itemId: item, quantity: '1', unit: 'items', startsOn: '2026-12-03', endsOn: '2026-12-14' })).status, 201);
    const json = await ann.request('GET', url());
    const mine = json.body.lines.find((l: { item: unknown }) => l.item);
    assert.deepEqual(mine.overlap, { named: [{ projectId: open, name: 'Open Works' }], others: 1 });
    const csv = (await ann.raw('GET', url('?format=csv'))).text;
    assert.match(csv, /,Open Works,1,/);
    for (const body of [JSON.stringify(json.body), csv]) assert.doesNotMatch(body, /Hidden Yard|Secret hidden notes|7\.00/);
    assert.doesNotMatch(csv, /Open notes/);
  });

  test('the audit event holds the project and section names only', async () => {
    await csv(ann);
    t.clock.advanceSeconds(1);
    await csv(pm);
    const rows = (await t.pool.query(`SELECT actor_user_id, detail FROM audit_events WHERE action = 'resources.report_exported' ORDER BY occurred_at, id`)).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].detail, { projectId, sections: ['lines', 'people'] });
    assert.deepEqual(rows[1].detail, { projectId, sections: ['lines', 'people', 'finance'] });
    assert.doesNotMatch(JSON.stringify(rows), /drone|Winch|100\.00/i);
    await pm.request('GET', url());
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'resources.report_exported'`)).rows[0].n, 2);
  });
});
