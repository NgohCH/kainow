import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('migration 0027 (history, deletion, quarantine)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let userId: string;
  let otherId: string;
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
    userId = await seedUser(pool, 'ada@example.org');
    otherId = await seedUser(pool, 'bo@example.org');
    projectId = await seedProject(pool, { status: 'active', members: [{ userId, role: 'pm' }] });
  });

  async function source(): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'Notes', $2, now(), $3)`,
      [id, userId, projectId],
    );
    return id;
  }

  async function version(sourceId: string, text = 'the password is Xy7!pass'): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'paste', $3, 'h', $4, $5, now())`,
      [id, sourceId, text, text.length, userId],
    );
    return id;
  }

  /** Inserts a case in the given state; a released case was closed an hour ago, in an earlier transaction. */
  async function quarantineCase(state: string): Promise<string> {
    const id = uuidv7();
    const closed = state === 'released' || state === 'released_unchanged';
    await pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, reason, marked_length, state, reported_at, closed_at, closed_by, close_reason)
       VALUES ($1, $2, 'source', $3, $4, 'looks like a password', 11, $5, now() - interval '2 hours', $6, $7, $8)`,
      [id, projectId, uuidv7(), userId, state, closed ? new Date(Date.now() - 3600_000) : null, closed ? userId : null, closed ? 'done' : null],
    );
    return id;
  }

  /** Runs sql in one transaction with the quarantine setting set to caseId (or not set when null). */
  async function inTransaction(caseId: string | null, sql: string, params: unknown[] = []): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (caseId) await client.query(`SELECT set_config('kainow.quarantine_write', $1, true)`, [caseId]);
      await client.query(sql, params);
      await client.query('COMMIT');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      return (err as { code?: string }).code ?? 'unknown';
    } finally {
      client.release();
    }
  }

  test('source_versions refuse update without the quarantine setting', async () => {
    const v = await version(await source());
    assert.equal(await sqlState(pool, `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [v]), '23001');
    await quarantineCase('held');
    // A setting that names no case, or is not an id at all, opens nothing.
    assert.equal(await inTransaction(uuidv7(), `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [v]), '23001');
    assert.equal(await inTransaction('nonsense', `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [v]), '23001');
  });

  test('source_versions accept update with a held case set', async () => {
    const v = await version(await source());
    const held = await quarantineCase('held');
    assert.equal(await inTransaction(held, `UPDATE source_versions SET text_content = '[credential removed]' WHERE id = $1`, [v]), 'ok');
    assert.equal((await pool.query(`SELECT text_content FROM source_versions WHERE id = $1`, [v])).rows[0].text_content, '[credential removed]');
    const cleaned = await quarantineCase('cleaned');
    assert.equal(await inTransaction(cleaned, `UPDATE source_versions SET text_content = 'again' WHERE id = $1`, [v]), 'ok');
    // The setting is transaction-local: the next statement outside it is refused again.
    assert.equal(await sqlState(pool, `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [v]), '23001');
  });

  test('a closed case does not open the exception', async () => {
    const v = await version(await source());
    const closed = await quarantineCase('released');
    assert.equal(await inTransaction(closed, `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [v]), '23001');
    const unchanged = await quarantineCase('released_unchanged');
    assert.equal(await inTransaction(unchanged, `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [v]), '23001');
  });

  test('a case closed in this very transaction still opens the exception, and not afterwards', async () => {
    const v = await version(await source());
    const cased = await quarantineCase('cleaned');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('kainow.quarantine_write', $1, true)`, [cased]);
      await client.query(
        `UPDATE quarantine_cases SET state = 'released_unchanged', closed_at = now(), closed_by = $2, close_reason = 'false alarm' WHERE id = $1`,
        [cased, userId],
      );
      await client.query(`UPDATE source_versions SET text_content = 'restored' WHERE id = $1`, [v]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    assert.equal((await pool.query(`SELECT text_content FROM source_versions WHERE id = $1`, [v])).rows[0].text_content, 'restored');
    assert.equal(await inTransaction(cased, `UPDATE source_versions SET text_content = 'x' WHERE id = $1`, [v]), '23001');
  });

  test('delete is refused even with the setting', async () => {
    const v = await version(await source());
    const held = await quarantineCase('held');
    assert.equal(await inTransaction(held, `DELETE FROM source_versions WHERE id = $1`, [v]), '23001');
    assert.equal(await inTransaction(held, `TRUNCATE source_versions CASCADE`), '23001');
    await pool.query(`INSERT INTO quarantine_events (id, case_id, project_id, action, at) VALUES ($1, $2, $3, 'reported', now())`, [uuidv7(), held, projectId]);
    assert.equal(await inTransaction(held, `DELETE FROM quarantine_events`), '23001');
  });

  test('history tables accept the held case update but never a delete', async () => {
    const held = await quarantineCase('held');
    await pool.query(
      `INSERT INTO source_events (id, source_id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, $3, 'deleted', $4, 'old', now())`,
      [uuidv7(), await source(), projectId, userId],
    );
    assert.equal(await sqlState(pool, `UPDATE source_events SET reason = 'x'`), '23001');
    assert.equal(await inTransaction(held, `UPDATE source_events SET reason = '[credential removed]'`), 'ok');
    assert.equal(await inTransaction(held, `DELETE FROM source_events`), '23001');
    assert.equal(await inTransaction(held, `TRUNCATE source_events`), '23001');
  });

  test('deleted columns are all or nothing', async () => {
    const id = await source();
    assert.equal(await sqlState(pool, `UPDATE sources SET deleted_at = now() WHERE id = $1`, [id]), '23514');
    assert.equal(await sqlState(pool, `UPDATE sources SET deleted_by = $2, deleted_at = now() WHERE id = $1`, [id, userId]), '23514');
    assert.equal(
      await sqlState(pool, `UPDATE sources SET status = 'deleted', deleted_by = $2, deleted_at = now(), delete_reason = 'duplicate' WHERE id = $1`, [id, userId]),
      'ok',
    );
    assert.equal(await sqlState(pool, `UPDATE sources SET delete_reason = '   ' WHERE id = $1`, [id]), '23514');
    for (const table of ['tasks', 'decisions', 'questions', 'risks']) {
      const cols = (
        await pool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name IN ('deleted_at','deleted_by','delete_reason','held_case_id')`,
          [table],
        )
      ).rows.map((r) => r.column_name as string);
      assert.deepEqual(cols.sort(), ['delete_reason', 'deleted_at', 'deleted_by', 'held_case_id']);
      const found = await pool.query(`SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [table, `${table}_deleted_together`]);
      assert.equal(found.rowCount, 1, `${table} has the all-or-nothing check`);
    }
  });

  test('upload with withheld original needs quarantined_at', async () => {
    const sid = await source();
    let versionNo = 0;
    const insert = (quarantinedAt: string | null, withBytes: boolean) =>
      sqlState(
        pool,
        `INSERT INTO source_versions (id, source_id, version_no, origin, filename, media_type, original_bytes, original_sha256, text_content, text_sha256, char_count, created_by, created_at, quarantined_at)
         VALUES ($1, $2, $3, 'upload', 'a.pdf', 'application/pdf', $4, 'abc', 'text', 'h', 4, $5, now(), $6)`,
        [uuidv7(), sid, ++versionNo, withBytes ? Buffer.from('pdf') : null, userId, quarantinedAt],
      );
    assert.equal(await insert(null, false), '23514');
    assert.equal(await insert(new Date().toISOString(), false), 'ok');
    assert.equal(await insert(null, true), 'ok');
  });

  test('security reviewer cannot be designated by themselves', async () => {
    assert.equal(
      await sqlState(pool, `INSERT INTO security_reviewer_events (id, user_id, kind, actor_id, reason, at) VALUES ($1, $2, 'designated', $2, 'me', now())`, [uuidv7(), userId]),
      '23514',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO security_reviewer_events (id, user_id, kind, actor_id, reason, at) VALUES ($1, $2, 'designated', $3, 'trusted', now())`, [uuidv7(), userId, otherId]),
      'ok',
    );
    assert.equal(await sqlState(pool, `UPDATE security_reviewer_events SET reason = 'x'`), '23001');
  });

  test('quarantine grant cannot be decided by its requester', async () => {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO quarantine_grants (id, requester_id, purpose, hours, requested_at) VALUES ($1, $2, 'check the key was rotated', 24, now())`,
      [id, userId],
    );
    const approve = `UPDATE quarantine_grants SET decision = 'approved', decided_by = $2, decided_at = now(), expires_at = now() + interval '24 hours' WHERE id = $1`;
    assert.equal(await sqlState(pool, approve, [id, userId]), '23514');
    assert.equal(await sqlState(pool, approve, [id, otherId]), 'ok');
  });

  test('only restored_at of a quarantine original may change', async () => {
    const held = await quarantineCase('held');
    const id = uuidv7();
    await pool.query(
      `INSERT INTO quarantine_originals (id, case_id, table_name, row_key, column_name, ciphertext, nonce, tag, key_id, cleaned_sha256)
       VALUES ($1, $2, 'tasks', '{"id":"x"}', 'title', $3, $4, $5, 'k', 'sha')`,
      [id, held, Buffer.from('c'), Buffer.alloc(12), Buffer.alloc(16)],
    );
    assert.equal(await sqlState(pool, `UPDATE quarantine_originals SET ciphertext = $2 WHERE id = $1`, [id, Buffer.from('d')]), '23001');
    assert.equal(await inTransaction(held, `UPDATE quarantine_originals SET ciphertext = $2 WHERE id = $1`, [id, Buffer.from('d')]), '23001');
    assert.equal(await sqlState(pool, `UPDATE quarantine_originals SET restored_at = now() WHERE id = $1`, [id]), 'ok');
    assert.equal(await sqlState(pool, `DELETE FROM quarantine_originals WHERE id = $1`, [id]), '23001');
  });

  test('one open record deletion delegation per project; task events take deleted and restored', async () => {
    const insert = (revoked: boolean) =>
      sqlState(
        pool,
        `INSERT INTO record_deletion_delegations (id, project_id, pm_user_id, delegated_by, reason, at, revoked_by, revoked_at, revoke_reason)
         VALUES ($1, $2, $3, $4, 'covering', now(), $5, $6, $7)`,
        [uuidv7(), projectId, userId, otherId, revoked ? otherId : null, revoked ? new Date() : null, revoked ? 'ended' : null],
      );
    assert.equal(await insert(false), 'ok');
    assert.equal(await insert(false), '23505');
    assert.equal(await insert(true), 'ok');
    const def = (await pool.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'task_events_kind_check'`)).rows[0].d as string;
    assert.match(def, /'deleted'/);
    assert.match(def, /'restored'/);
  });
});
