import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';
import { notifyAdmins } from './notify';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const AT = new Date('2026-11-20T04:00:00Z');

describe('notifyAdmins', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
  });
  after(async () => {
    await pool.end();
  });

  test('one urgent, email-on row per Active administrator', async () => {
    const a1 = await seedUser(pool, 'ops-a1@example.org', 'enterprise_administrator');
    const a2 = await seedUser(pool, 'ops-a2@example.org', 'enterprise_administrator');
    const off = await seedUser(pool, 'ops-a3@example.org', 'enterprise_administrator');
    await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [off]);
    await seedUser(pool, 'ops-m@example.org', 'member');

    await notifyAdmins(pool, { kind: 'backup_failed', summary: 'The backup failed.', link: '/admin/operations', now: AT, urgent: true });

    const { rows } = await pool.query(
      `SELECT user_id, kind, urgent, email_off, summary, link, created_at, outbox_id FROM notifications ORDER BY user_id`,
    );
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [a1, a2].sort());
    for (const r of rows) {
      assert.equal(r.kind, 'backup_failed');
      assert.equal(r.urgent, true);
      assert.equal(r.email_off, false);
      assert.equal(r.outbox_id, null);
      assert.equal(r.created_at.toISOString(), AT.toISOString());
    }
  });
});
