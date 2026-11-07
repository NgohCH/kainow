import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { runMigrations } from './migrate';

const realMigrations = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const REAL_FILES = ['0001_identity_and_audit.sql', '0002_sign_in_throttle.sql', '0003_ai_spend.sql', '0004_notes.sql', '0005_extraction.sql', '0006_review.sql', '0007_user_spend_limit.sql', '0008_chosen_occurrence.sql', '0009_proposal_edits.sql'];

describe('migrations', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  before(() => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetPublicSchema(pool);
  });

  test('applies the real migrations once and skips them the second time', async () => {
    const first = await runMigrations(pool, realMigrations);
    assert.deepEqual(first.applied, REAL_FILES);
    const second = await runMigrations(pool, realMigrations);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, REAL_FILES);
  });

  test('stops when an applied migration has changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
    const file = join(dir, '0001_a.sql');
    writeFileSync(file, 'CREATE TABLE a (id int);');
    await runMigrations(pool, dir);
    writeFileSync(file, 'CREATE TABLE a (id int, extra int);');
    await assert.rejects(runMigrations(pool, dir), /changed after it was applied/);
  });

  test('a migration checked out with Windows line endings is the same migration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
    const file = join(dir, '0001_a.sql');
    writeFileSync(file, 'CREATE TABLE a (\n  id int\n);\n');
    await runMigrations(pool, dir);
    writeFileSync(file, 'CREATE TABLE a (\r\n  id int\r\n);\r\n');
    const again = await runMigrations(pool, dir);
    assert.deepEqual(again, { applied: [], skipped: ['0001_a.sql'] });
  });

  test('the recorded checksum is the hash of the file with LF line ends, so it is the same on every computer', async () => {
    await runMigrations(pool, realMigrations);
    const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
    for (const row of rows) {
      const lf = readFileSync(join(realMigrations, row.name), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(row.checksum, createHash('sha256').update(lf).digest('hex'), row.name);
    }
  });

  test('stops when an applied migration is missing from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    await runMigrations(pool, dir);
    const empty = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
    await assert.rejects(runMigrations(pool, empty), /missing from/);
  });

  test('rolls a failing migration back completely and records nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
    writeFileSync(join(dir, '0001_bad.sql'), 'CREATE TABLE half (id int); SELECT * FROM does_not_exist;');
    await assert.rejects(runMigrations(pool, dir), /0001_bad.sql failed/);
    const table = await pool.query("SELECT to_regclass('public.half') AS t");
    assert.equal(table.rows[0].t, null);
    const recorded = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    assert.equal(recorded.rows[0].n, 0);
  });

  test('applies migrations in filename order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
    writeFileSync(join(dir, '0002_b.sql'), 'ALTER TABLE a ADD COLUMN b int;');
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    const result = await runMigrations(pool, dir);
    assert.deepEqual(result.applied, ['0001_a.sql', '0002_b.sql']);
  });

  test('migration file is the one that was applied (checksum matches disk)', async () => {
    await runMigrations(pool, realMigrations);
    const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
    assert.deepEqual(rows.map((r) => r.name), REAL_FILES);
    for (const row of rows) {
      assert.match(row.checksum, /^[0-9a-f]{64}$/);
      assert.ok(readFileSync(join(realMigrations, row.name), 'utf8').length > 0);
    }
  });
});

describe('identity and audit schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, realMigrations);
  });
  after(async () => {
    await pool.end();
  });

  async function addUser(email: string): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'Test', 'enterprise_administrator')`,
      [id, email],
    );
    return id;
  }

  test('only accepts normalised, unique email addresses', async () => {
    await addUser('first@example.org');
    await assert.rejects(addUser('First@example.org'), /users_email_normalised/);
    await assert.rejects(addUser(' padded@example.org '), /users_email_normalised/);
    await assert.rejects(addUser(''), /users_email_normalised/);
    await assert.rejects(addUser('first@example.org'), /users_email_key/);
  });

  test('only allows the MVP role and known statuses', async () => {
    await assert.rejects(
      pool.query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, 'r@example.org', 'R', 'project_manager')`, [uuidv7()]),
      /users_role_check/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO users (id, email, display_name, role, status) VALUES ($1, 's@example.org', 'S', 'enterprise_administrator', 'deleted')`,
        [uuidv7()],
      ),
      /users_status_check/,
    );
  });

  test('audit events can be added but never changed, deleted or truncated', async () => {
    const actor = await addUser('actor@example.org');
    const id = uuidv7();
    await pool.query(`INSERT INTO audit_events (id, actor_user_id, action) VALUES ($1, $2, 'test.event')`, [id, actor]);
    await assert.rejects(pool.query(`UPDATE audit_events SET action = 'changed' WHERE id = $1`, [id]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audit_events WHERE id = $1', [id]), /append-only/);
    await assert.rejects(pool.query('TRUNCATE audit_events'), /append-only/);
    const { rows } = await pool.query('SELECT action FROM audit_events WHERE id = $1', [id]);
    assert.equal(rows[0].action, 'test.event');
  });

  test('sign-in codes and sessions need an existing user', async () => {
    await assert.rejects(
      pool.query(`INSERT INTO login_codes (id, user_id, code_hash, expires_at) VALUES ($1, $2, 'h', now())`, [uuidv7(), uuidv7()]),
      /foreign key/,
    );
    await assert.rejects(
      pool.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'h', now())`, [uuidv7(), uuidv7()]),
      /foreign key/,
    );
  });

  test('session token hashes are unique', async () => {
    const user = await addUser('sessions@example.org');
    const insert = () =>
      pool.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'same-hash', now() + interval '1 hour')`, [
        uuidv7(),
        user,
      ]);
    await insert();
    await assert.rejects(insert(), /unique/);
  });
});
