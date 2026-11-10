import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { runMigrations } from './migrate';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('notifications schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
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
    userId = await seedUser(pool, 'a@example.org');
    projectId = await seedProject(pool, { status: 'active', members: [{ userId, role: 'pm' }] });
  });

  async function addTrigger(key: string): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO notification_triggers (id, key, kind, project_id, record_kind, record_id, fire_at, decided_at, outcome)
       VALUES ($1, $2, 'reminder', $3, 'task', $4, now(), now(), 'sent')`,
      [id, key, projectId, uuidv7()],
    );
    return id;
  }

  test('defaults are seeded', async () => {
    const { rows } = await pool.query(
      `SELECT id, day_counting, weekdays, lead_days, escalation_days, sweep_minutes,
              projects_may_change_calendar AS cal, projects_may_change_timings AS tim, projects_may_change_digest AS dig
         FROM notification_settings`,
    );
    assert.deepEqual(rows, [
      { id: 1, day_counting: 'working', weekdays: [1, 2, 3, 4, 5], lead_days: [7, 1], escalation_days: 3, sweep_minutes: 15, cal: false, tim: false, dig: false },
    ]);
  });

  test('bounds are enforced', async () => {
    for (const set of [
      `lead_days = '{0}'`, `lead_days = '{31}'`, `lead_days = '{7,7}'`, `lead_days = '{1,2,3,4}'`, `lead_days = '{}'`,
      `escalation_days = 11`, `escalation_days = 0`, `sweep_minutes = 4`, `sweep_minutes = 61`,
      `weekdays = '{}'`, `weekdays = '{0}'`, `weekdays = '{8}'`, `weekdays = '{1,1}'`, `day_counting = 'other'`,
    ]) {
      assert.equal(await sqlState(pool, `UPDATE notification_settings SET ${set}`), '23514', set);
    }
    assert.equal(await sqlState(pool, `UPDATE notification_settings SET lead_days = '{30,2,1}', weekdays = '{1,2,3,4,5,6,7}', escalation_days = 10, sweep_minutes = 60`), 'ok');
    assert.equal(await sqlState(pool, `INSERT INTO notification_settings (id, updated_at) VALUES (2, now())`), '23514');
    assert.equal(await sqlState(pool, `INSERT INTO project_notification_settings (project_id, lead_days, updated_at) VALUES ($1, '{7,7}', now())`, [projectId]), '23514');
    assert.equal(await sqlState(pool, `INSERT INTO project_notification_settings (project_id, lead_days, escalation_days, updated_at) VALUES ($1, '{5}', 2, now())`, [projectId]), 'ok');
  });

  test('trigger keys are unique', async () => {
    await addTrigger('k1');
    const second = await pool.query(
      `INSERT INTO notification_triggers (id, key, kind, project_id, record_kind, record_id, fire_at, decided_at, outcome)
       VALUES ($1, 'k1', 'reminder', $2, 'task', $3, now(), now(), 'sent') ON CONFLICT (key) DO NOTHING`,
      [uuidv7(), projectId, uuidv7()],
    );
    assert.equal(second.rowCount, 0);
  });

  test('history tables are append-only', async () => {
    await addTrigger('k2');
    const outboxId = uuidv7();
    await pool.query(
      `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, created_at)
       VALUES ($1, 'a@example.org', 'S', 'B', 'notice', 'trigger', now())`,
      [outboxId],
    );
    await pool.query(`INSERT INTO email_attempts (id, outbox_id, attempt_no, started_at, outcome) VALUES ($1, $2, 1, now(), 'sent')`, [uuidv7(), outboxId]);
    await pool.query(
      `INSERT INTO notification_settings_changes (id, scope, field, old_value, new_value, reason, actor_id, at)
       VALUES ($1, 'organisation', 'sweep_minutes', '15', '10', 'Faster', $2, now())`,
      [uuidv7(), userId],
    );
    for (const table of ['notification_triggers', 'email_attempts', 'notification_settings_changes']) {
      assert.notEqual(await sqlState(pool, `UPDATE ${table} SET id = id`), 'ok', `${table} update`);
      assert.notEqual(await sqlState(pool, `DELETE FROM ${table}`), 'ok', `${table} delete`);
    }
    // The outbox changes as delivery proceeds.
    assert.equal(await sqlState(pool, `UPDATE email_outbox SET status = 'sent'`), 'ok');
  });

  test('holidays are unique per scope and date while current', async () => {
    const add = (project: string | null, date: string) =>
      sqlState(pool, `INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at) VALUES ($1, $2, $3, 'H', $4, now())`, [uuidv7(), project, date, userId]);
    assert.equal(await add(null, '2026-12-25'), 'ok');
    assert.equal(await add(null, '2026-12-25'), '23505');
    assert.equal(await add(projectId, '2026-12-25'), 'ok');
    assert.equal(await add(projectId, '2026-12-25'), '23505');
    await pool.query(`UPDATE holidays SET removed_by = $1, removed_at = now() WHERE project_id IS NULL`, [userId]);
    assert.equal(await add(null, '2026-12-25'), 'ok');
  });

  test('choices, away dates and outbox values are constrained', async () => {
    assert.equal(await sqlState(pool, `INSERT INTO email_preferences (user_id, project_id, choice, updated_at) VALUES ($1, $2, 'weekly', now())`, [userId, projectId]), '23514');
    assert.equal(await sqlState(pool, `INSERT INTO email_preferences (user_id, project_id, choice, updated_at) VALUES ($1, $2, 'off', now())`, [userId, projectId]), 'ok');
    assert.equal(await sqlState(pool, `INSERT INTO away_periods (id, user_id, starts_on, ends_on, created_at) VALUES ($1, $2, '2026-12-02', '2026-12-01', now())`, [uuidv7(), userId]), '23514');
    assert.equal(await sqlState(pool, `INSERT INTO away_periods (id, user_id, starts_on, ends_on, created_at) VALUES ($1, $2, '2026-12-01', '2026-12-01', now())`, [uuidv7(), userId]), 'ok');
    assert.equal(await sqlState(pool, `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, status, created_at) VALUES ($1, 'a@example.org', 'S', 'B', 'k', 'person', 'bogus', now())`, [uuidv7()]), '23514');
  });
});
