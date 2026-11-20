import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('migration 0030 (resources and finance)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let adaId: string;
  let projectId: string;

  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    adaId = await seedUser(pool, 'ada@example.org');
    const dept = await seedDepartment(pool, 'Dummy Department');
    projectId = await seedProject(pool, { members: [], departmentId: dept });
  });

  const line = (cols: Record<string, unknown>) => {
    const all: Record<string, unknown> = { id: uuidv7(), project_id: projectId, one_off_kind: 'other', description: 'Dummy item', created_by: adaId, ...cols };
    const names = Object.keys(all);
    return sqlState(
      pool,
      `INSERT INTO resource_lines (${names.join(', ')}, created_at, updated_at) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}, now(), now())`,
      names.map((n) => all[n]),
    );
  };

  const changeRequest = (kind: string, target: string, targetId = uuidv7()) =>
    sqlState(
      pool,
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, now())`,
      [uuidv7(), projectId, kind, target, targetId, adaId],
    );

  async function expenditure(): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO expenditures (id, project_id, spent_on, amount, currency, description, recorded_by, recorded_at)
       VALUES ($1, $2, '2026-11-01', 10.00, 'MYR', 'Dummy purchase', $3, now())`,
      [id, projectId, adaId],
    );
    return id;
  }

  async function approvedRequest(kind: string, target: string, targetId: string): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, now())`,
      [id, projectId, kind, target, targetId, adaId],
    );
    return id;
  }

  test('the new tables exist', async () => {
    const want = [
      'resource_categories', 'resource_items', 'resource_catalogue_events', 'resource_catalogue_maintainers', 'resource_lines',
      'resource_line_events', 'resource_settings', 'resource_settings_changes', 'project_finance_settings', 'project_finance_changes',
      'project_finance_state', 'budget_versions', 'expenditures', 'expenditure_adjustments',
    ];
    const have = new Set((await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name as string));
    assert.deepEqual(want.filter((t) => !have.has(t)), []);
  });

  test('a line needs a unit with its quantity, and the reverse', async () => {
    assert.equal(await line({ quantity: '2.50' }), '23514');
    assert.equal(await line({ unit: 'hours' }), '23514');
    assert.equal(await line({ quantity: '2.50', unit: 'hours' }), 'ok');
    assert.equal(await line({ quantity: '0', unit: 'hours' }), '23514');
    assert.equal(await line({ quantity: '1', unit: 'weeks' }), '23514');
  });

  test('a line is an item or a one-off, never both or neither', async () => {
    const itemId = uuidv7();
    await pool.query(
      `INSERT INTO resource_items (id, kind, reference, name, created_by, created_at) VALUES ($1, 'equipment', 'EQ-1', 'Dummy rig', $2, now())`,
      [itemId, adaId],
    );
    assert.equal(await line({ item_id: itemId }), '23514');
    assert.equal(await line({ item_id: itemId, one_off_kind: null }), 'ok');
    assert.equal(await line({ one_off_kind: null }), '23514');
    assert.equal(await line({ one_off_kind: 'vehicle' }), '23514');
  });

  test('a line end date cannot precede its start, or stand without one', async () => {
    assert.equal(await line({ starts_on: '2026-11-10', ends_on: '2026-11-09' }), '23514');
    assert.equal(await line({ starts_on: '2026-11-10', ends_on: '2026-11-10' }), 'ok');
    assert.equal(await line({ ends_on: '2026-11-10' }), '23514');
    assert.equal(await line({ status: 'lost' }), '23514');
  });

  test('change_requests accepts the new kinds and target kinds', async () => {
    assert.equal(await changeRequest('set_budget', 'project_budget', projectId), 'ok');
    assert.equal(await changeRequest('finance_adjustment', 'expenditure'), 'ok');
    assert.equal(await changeRequest('risk_handover', 'risk'), 'ok');
    assert.equal(await changeRequest('set_budget', 'nothing'), '23514');
    assert.equal(await changeRequest('nothing', 'expenditure'), '23514');
  });

  test('expenditures are append-only', async () => {
    const id = await expenditure();
    assert.equal(await sqlState(pool, `UPDATE expenditures SET amount = 11 WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM expenditures WHERE id = $1`, [id]), '23001');
    assert.equal(await sqlState(pool, `TRUNCATE expenditures CASCADE`), '23001');
  });

  test('the other history tables are append-only', async () => {
    const lineId = uuidv7();
    await pool.query(
      `INSERT INTO resource_lines (id, project_id, one_off_kind, description, created_by, created_at, updated_at) VALUES ($1, $2, 'other', 'Dummy', $3, now(), now())`,
      [lineId, projectId, adaId],
    );
    const eventId = uuidv7();
    await pool.query(`INSERT INTO resource_line_events (id, line_id, kind, actor_id, at, detail) VALUES ($1, $2, 'created', $3, now(), '{}')`, [eventId, lineId, adaId]);
    assert.equal(await sqlState(pool, `UPDATE resource_line_events SET reason = 'x' WHERE id = $1`, [eventId]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM resource_line_events WHERE id = $1`, [eventId]), '23001');

    const chId = uuidv7();
    await pool.query(
      `INSERT INTO resource_catalogue_events (id, subject_kind, subject_id, kind, actor_id, at) VALUES ($1, 'item', $2, 'added', $3, now())`,
      [chId, uuidv7(), adaId],
    );
    assert.equal(await sqlState(pool, `DELETE FROM resource_catalogue_events WHERE id = $1`, [chId]), '23001');

    const sId = uuidv7();
    await pool.query(`INSERT INTO resource_settings_changes (id, actor_id, at, reason, previous, next) VALUES ($1, $2, now(), 'why', '{}', '{}')`, [sId, adaId]);
    assert.equal(await sqlState(pool, `UPDATE resource_settings_changes SET reason = 'z' WHERE id = $1`, [sId]), '23001');

    const fId = uuidv7();
    await pool.query(`INSERT INTO project_finance_changes (id, project_id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, now(), 'why', '{}', '{}')`, [fId, projectId, adaId]);
    assert.equal(await sqlState(pool, `UPDATE project_finance_changes SET reason = 'z' WHERE id = $1`, [fId]), '23001');

    const crId = await approvedRequest('set_budget', 'project_budget', projectId);
    const bId = uuidv7();
    await pool.query(`INSERT INTO budget_versions (id, project_id, amount, currency, change_request_id, approved_at) VALUES ($1, $2, 0, 'MYR', $3, now())`, [bId, projectId, crId]);
    assert.equal(await sqlState(pool, `UPDATE budget_versions SET amount = 1 WHERE id = $1`, [bId]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM budget_versions WHERE id = $1`, [bId]), '23001');
  });

  test('expenditure adjustments are append-only and their kinds are checked', async () => {
    const expId = await expenditure();
    const crId = await approvedRequest('finance_adjustment', 'expenditure', expId);
    const insert = (kind: string, id = uuidv7()) =>
      sqlState(
        pool,
        `INSERT INTO expenditure_adjustments (id, expenditure_id, kind, amount, reason, change_request_id, approved_at) VALUES ($1, $2, $3, 5, 'fix', $4, now())`,
        [id, expId, kind, crId],
      );
    assert.equal(await insert('swap'), '23514');
    const id = uuidv7();
    assert.equal(await insert('correction', id), 'ok');
    assert.equal(await sqlState(pool, `UPDATE expenditure_adjustments SET amount = 6 WHERE id = $1`, [id]), '23001');
  });

  test('resource_settings has one row with the defaults', async () => {
    const rows = (await pool.query(`SELECT * FROM resource_settings`)).rows;
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.projects_may_manage_finance, true);
    assert.equal(r.default_currency, 'MYR');
    assert.deepEqual(r.enabled_currencies, ['MYR', 'SGD', 'USD']);
    assert.equal(r.warn_first_pct, 80);
    assert.equal(r.warn_second_pct, 100);
    assert.equal(await sqlState(pool, `INSERT INTO resource_settings DEFAULT VALUES`), '23505');
  });

  test('threshold and currency checks on resource_settings', async () => {
    const set = (sql: string) => sqlState(pool, `UPDATE resource_settings SET ${sql}`);
    assert.equal(await set('warn_first_pct = 100, warn_second_pct = 80'), '23514');
    assert.equal(await set('warn_first_pct = 100, warn_second_pct = 100'), '23514');
    assert.equal(await set('warn_first_pct = 0'), '23514');
    assert.equal(await set('warn_second_pct = 201'), '23514');
    assert.equal(await set(`default_currency = 'SGD'`), 'ok');
    assert.equal(await set(`enabled_currencies = '{MYR,USD}'`), '23514');
    assert.equal(await set('warn_first_pct = 50, warn_second_pct = 120'), 'ok');
  });

  test('project finance settings: currency when enabled, thresholds together and ordered', async () => {
    const insert = (cols: string, vals: unknown[]) =>
      sqlState(pool, `INSERT INTO project_finance_settings (project_id, ${cols}) VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})`, [projectId, ...vals]);
    assert.equal(await insert('tracking', ['enabled']), '23514');
    assert.equal(await insert('tracking, currency, warn_first_pct', ['enabled', 'MYR', 80]), '23514');
    assert.equal(await insert('tracking, currency, warn_first_pct, warn_second_pct', ['enabled', 'MYR', 100, 80]), '23514');
    assert.equal(await insert('tracking, currency, warn_first_pct, warn_second_pct', ['enabled', 'MYR', 70, 90]), 'ok');
  });

  test('a finance state notified level is 0 to 2', async () => {
    assert.equal(await sqlState(pool, `INSERT INTO project_finance_state (project_id, notified_level) VALUES ($1, 3)`, [projectId]), '23514');
    assert.equal(await sqlState(pool, `INSERT INTO project_finance_state (project_id, notified_level) VALUES ($1, 2)`, [projectId]), 'ok');
  });

  test('amount checks on expenditures', async () => {
    const exp = (amount: string, description = 'x') =>
      sqlState(
        pool,
        `INSERT INTO expenditures (id, project_id, spent_on, amount, currency, description, recorded_by, recorded_at) VALUES ($1, $2, '2026-11-01', $3, 'MYR', $4, $5, now())`,
        [uuidv7(), projectId, amount, description, adaId],
      );
    assert.equal(await exp('0'), '23514');
    assert.equal(await exp('-1'), '23514');
    assert.equal(await exp('0.01'), 'ok');
    assert.equal(await exp('1', '  '), '23514');
  });
});
