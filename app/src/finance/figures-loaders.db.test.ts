import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { loadFigures, loadFiguresMany } from './finance.service';

const START = Date.UTC(2026, 10, 20, 2, 0, 0);

/** loadFiguresMany must give exactly what loadFigures gives, project by project (both end in figures()). */
describe('loadFiguresMany parity with loadFigures', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await startTestApp(START);
  });
  afterEach(async () => {
    await t?.close();
  });

  test('a refund, a conversion and an unconverted foreign entry', async () => {
    const pmId = await seedUser(t.pool, 'pm@example.org');
    const rich = await seedProject(t.pool, { status: 'active', name: 'Rich', members: [{ userId: pmId, role: 'pm' }] });
    const plain = await seedProject(t.pool, { status: 'active', name: 'Plain', members: [{ userId: pmId, role: 'pm' }] });
    const off = await seedProject(t.pool, { status: 'active', name: 'Off', members: [{ userId: pmId, role: 'pm' }] });
    await t.pool.query(`INSERT INTO project_finance_settings (project_id, tracking, currency, warn_first_pct, warn_second_pct) VALUES ($1, 'enabled', 'MYR', 50, 90)`, [rich]);
    await t.pool.query(`INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, 'enabled', 'SGD'), ($2, 'not_required', NULL)`, [plain, off]);

    const cr = async (projectId: string, kind: string, targetKind: string, targetId: string) => {
      const id = uuidv7();
      await t.pool.query(
        `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, version, required_approvals, status, submitted_by, submitted_at)
         VALUES ($1, $2, $3, $4, $5, 1, 1, 'authorised', $6, $7)`,
        [id, projectId, kind, targetKind, targetId, pmId, new Date(START)],
      );
      return id;
    };
    const entry = async (projectId: string, amount: string, currency: string) => {
      const id = uuidv7();
      await t.pool.query(
        `INSERT INTO expenditures (id, project_id, spent_on, amount, currency, description, recorded_by, recorded_at) VALUES ($1, $2, '2026-11-18', $3, $4, 'Item', $5, $6)`,
        [id, projectId, amount, currency, pmId, new Date(START)],
      );
      return id;
    };
    await t.pool.query(`INSERT INTO budget_versions (id, project_id, amount, currency, change_request_id, approved_at) VALUES ($1, $2, 1000.00, 'MYR', $3, $4)`, [
      uuidv7(), rich, await cr(rich, 'set_budget', 'project_budget', rich), new Date(START),
    ]);
    await t.pool.query(`INSERT INTO budget_versions (id, project_id, amount, currency, change_request_id, approved_at) VALUES ($1, $2, 8000.00, 'MYR', $3, $4)`, [
      uuidv7(), rich, await cr(rich, 'set_budget', 'project_budget', rich), new Date(START + 5000),
    ]);
    const myr = await entry(rich, '300.00', 'MYR');
    const usdConverted = await entry(rich, '100.00', 'USD');
    await entry(rich, '55.00', 'USD'); // unconverted: Not in totals
    // Plain entries (reporting currency, never adjusted) beside the adjusted and foreign ones: summed in SQL by the fast path.
    for (const amount of ['12.34', '0.66', '1000.00']) await entry(rich, amount, 'MYR');
    await entry(plain, '10.00', 'SGD');
    await entry(plain, '2.50', 'SGD');
    await entry(plain, '7.00', 'USD'); // foreign beside plain ones: Not in totals
    await t.pool.query(
      `INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, refund_on, reason, change_request_id, approved_at) VALUES ($1, $2, 'refund', 120.00, '2026-11-19', 'Returned', $3, $4)`,
      [uuidv7(), myr, await cr(rich, 'finance_adjustment', 'expenditure', myr), new Date(START + 1000)],
    );
    await t.pool.query(
      `INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, rate, rate_on, reason, change_request_id, approved_at) VALUES ($1, $2, 'conversion', 440.00, 4.4, '2026-11-18', 'Rate', $3, $4)`,
      [uuidv7(), usdConverted, await cr(rich, 'finance_adjustment', 'expenditure', usdConverted), new Date(START + 2000)],
    );

    const many = await loadFiguresMany(t.pool, [rich, plain, off]);
    assert.equal(many.has(off), false);
    assert.equal(await loadFigures(t.pool, off), null);
    for (const id of [rich, plain]) assert.deepEqual(many.get(id), await loadFigures(t.pool, id));
    const r = many.get(rich);
    assert.equal(r?.spent, 163300n); // 300 - 120 + 440 + 12.34 + 0.66 + 1000.00
    const p = many.get(plain);
    assert.equal(p?.spent, 1250n);
    assert.deepEqual(p?.notInTotals, [{ currency: 'USD', amount: 700n }]);
    assert.equal(r?.budget, 800000n);
    assert.deepEqual(r?.notInTotals, [{ currency: 'USD', amount: 5500n }]);
    assert.deepEqual(r?.warnThresholds, [50, 90]);
  });
});
