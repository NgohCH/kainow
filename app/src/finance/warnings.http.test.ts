import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { evaluateFinanceWarnings } from './warnings';
import { seedProject, seedUser } from '../testing/projects';

// 10:00 on 20 November 2026 in UTC+8.
const START = Date.UTC(2026, 10, 20, 2, 0, 0);
const pct = (n: number) => `Harbour Survey: recorded spending reached ${n}% of the approved budget (advisory).`;
const OVER = 'Harbour Survey: recorded spending is over the approved budget (advisory).';

describe('budget warning notices over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let ids: Record<string, string>;
  let projectId: string;
  let n = 0;
  const url = (path = '') => `/projects/${projectId}/finance${path}`;
  const spend = (amount: string) =>
    pm.request('POST', url('/spending'), { spentOn: '2026-11-18', amount, currency: 'MYR', description: `Entry ${++n}`, reference: '' });
  let tick = 0;
  /** An approved budget version, inserted as Task 8's handler does; a lower one is a later version. */
  const budget = async (amount: string) => {
    const at = new Date(START + ++tick * 1000);
    const cr = uuidv7();
    await t.pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, 'set_budget', 'project_budget', $3, 1, 1, 'authorised', $4, $5)`,
      [cr, projectId, projectId, ids.pm, at],
    );
    await t.pool.query(`INSERT INTO budget_versions (id, project_id, amount, currency, change_request_id, approved_at) VALUES ($1, $2, $3, 'MYR', $4, $5)`, [
      uuidv7(),
      projectId,
      amount,
      cr,
      at,
    ]);
  };
  const notices = async () =>
    (await t.pool.query(`SELECT user_id, kind, summary, link, email_off, urgent FROM notifications WHERE kind = 'budget_warning' ORDER BY created_at, user_id`)).rows;
  const evaluate = async () => {
    const c = await t.pool.connect();
    try {
      await c.query('BEGIN');
      await evaluateFinanceWarnings(c, projectId, new Date(START));
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  };
  const users = (rows: { user_id: string }[]) => rows.map((r) => r.user_id).sort();

  beforeEach(async () => {
    t = await startTestApp(START);
    ids = {};
    for (const p of ['owner', 'pm', 'deputy', 'sponsor', 'ann']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour Survey',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    await t.pool.query(`INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, 'enabled', 'MYR')`, [projectId]);
    await budget('1000.00');
    pm = await t.signIn('pm@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  test('79% gives no notice; 80% gives one to each reader; another entry at 85% gives none; 100% gives the second notice', async () => {
    assert.equal((await spend('790.00')).status, 201);
    assert.deepEqual(await notices(), []);
    assert.equal((await spend('10.00')).status, 201);
    const first = await notices();
    assert.equal(first.length, 4);
    assert.deepEqual(users(first), [ids.deputy, ids.owner, ids.pm, ids.sponsor].sort());
    assert.ok(!users(first).includes(ids.ann), 'a Member without the policy gets nothing');
    for (const r of first) {
      assert.equal(r.summary, pct(80));
      assert.equal(r.link, `#/projects/${projectId}/resources`);
      assert.equal(r.email_off, true);
    }
    await spend('50.00');
    assert.equal((await notices()).length, 4);
    await spend('150.00');
    const all = await notices();
    assert.equal(all.length, 8);
    assert.equal(all.filter((r) => r.summary === pct(100)).length, 4);
  });

  test('a Member who is a finance reader through membersRead still gets no notice', async () => {
    await t.pool.query(`UPDATE project_finance_settings SET members_read = true WHERE project_id = $1`, [projectId]);
    await spend('900.00');
    const rows = await notices();
    assert.equal(rows.length, 4);
    assert.ok(!users(rows).includes(ids.ann));
  });

  test('jumping from 0 to 100% sends only the second notice', async () => {
    await spend('1000.00');
    const rows = await notices();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.summary === pct(100)));
  });

  test('an approved correction down to 50% resets the level; another entry back to 80% notifies again', async () => {
    const e = (await spend('800.00')).body.entry;
    assert.equal((await notices()).length, 4);
    const cr = uuidv7();
    await t.pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, 'finance_adjustment', 'expenditure', $3, 1, 1, 'authorised', $4, $5)`,
      [cr, projectId, e.id, ids.pm, new Date(START)],
    );
    await t.pool.query(
      `INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, reason, change_request_id, approved_at) VALUES ($1, $2, 'correction', 500.00, 'Mis-keyed', $3, $4)`,
      [uuidv7(), e.id, cr, new Date(START + 1000)],
    );
    await spend('1.00'); // evaluates at 50.1%: level falls to 0, no notice
    assert.equal((await notices()).length, 4);
    await spend('300.00'); // 80.1%
    assert.equal((await notices()).length, 8);
  });

  test('a lower approved budget can cross a threshold', async () => {
    await spend('500.00');
    assert.deepEqual(await notices(), []);
    await budget('600.00');
    await evaluate();
    const rows = await notices();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((x) => x.summary === pct(80)));
  });

  test('changing the thresholds evaluates', async () => {
    await spend('500.00');
    assert.deepEqual(await notices(), []);
    const r = await pm.request('PUT', `/projects/${projectId}/settings/finance`, { tracking: 'enabled', currency: 'MYR', warnFirstPct: 40, warnSecondPct: 90, reason: 'Tighter warning' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = await notices();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((x) => x.summary === pct(40)));
  });

  test('a zero budget with spending gives the over-budget wording', async () => {
    await budget('0.00');
    await spend('10.00');
    const rows = (await notices()).filter((r) => r.summary === OVER);
    assert.equal(rows.length, 4);
  });
});
