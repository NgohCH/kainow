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

  test('one urgent notice and one queued email per Active administrator', async () => {
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
      assert.equal(r.email_off, true);
      assert.ok(r.outbox_id);
      assert.equal(r.created_at.toISOString(), AT.toISOString());
    }
    const out = await pool.query(
      `SELECT id, to_user_id, to_address, kind, status, initiated_by, text_body FROM email_outbox ORDER BY to_user_id`,
    );
    assert.deepEqual(out.rows.map((r) => r.to_user_id).sort(), [a1, a2].sort());
    for (const r of out.rows) {
      assert.equal(r.status, 'queued');
      assert.equal(r.initiated_by, 'system');
      assert.equal(r.kind, 'backup_failed');
      assert.match(r.text_body, /The backup failed\./);
      assert.match(r.text_body, /\/admin\/operations/);
    }
    assert.deepEqual(rows.map((r) => r.outbox_id).sort(), out.rows.map((r) => r.id).sort());
  });
  test('given a Pool, a failure part-way writes nothing (one transaction)', async () => {
    const admins = (await pool.query(`SELECT id FROM users WHERE status = 'active' AND role = 'enterprise_administrator' ORDER BY id`)).rows;
    assert.ok(admins.length >= 2);
    const last = admins[admins.length - 1].id as string;
    await pool.query(`CREATE FUNCTION ops_notify_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id = '${last}' AND NEW.summary = 'Atomic check.' THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ops_notify_fail BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION ops_notify_fail()`);
    try {
      await assert.rejects(notifyAdmins(pool, { kind: 'backup_failed', summary: 'Atomic check.', link: null, now: AT, urgent: true }));
    } finally {
      await pool.query('DROP TRIGGER ops_notify_fail ON notifications');
      await pool.query('DROP FUNCTION ops_notify_fail()');
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE summary = 'Atomic check.'`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE '%Atomic check.%'`)).rows[0].n, 0);
  });
});
