import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedUser } from '../testing/projects';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date('2026-11-22T12:00:00Z');

describe('updates schema', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let admin: string;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    admin = await seedUser(pool, 'upd-admin@example.org', 'enterprise_administrator');
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    // update_steps and update_changes are append-only, so the rows of earlier tests stay; only updates' own rows go when unreferenced.
    await pool.query(`DELETE FROM updates u WHERE NOT EXISTS (SELECT 1 FROM update_steps s WHERE s.update_id = u.id) AND NOT EXISTS (SELECT 1 FROM update_changes c WHERE c.update_id = u.id)`);
    await pool.query(`UPDATE updates SET state = 'cancelled', cancelled_by = approved_by, cancelled_at = approved_at, cancel_reason = 'test cleanup' WHERE state IN ('approved', 'preparing', 'ready', 'installing')`);
  });

  const update = async (state: string, tag = 'v1.0.1') => {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO updates (id, from_version, to_version, tag, commit, state, starts_at, expected_minutes, approved_by, approved_at, reason)
       VALUES ($1, '1.0.0', $2, $3, 'abc123', $4, $5, 30, $6, $7, 'Routine update')`,
      [id, tag.slice(1), tag, state, new Date(NOW.getTime() + 3_600_000), admin, NOW],
    );
    return id;
  };
  const sqlstate = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return undefined;
  };

  test('two open updates are refused by updates_one_open', async () => {
    await update('approved');
    assert.equal(await sqlstate(update('preparing', 'v1.0.2')), '23505');
    assert.equal(await sqlstate(update('installing', 'v1.0.3')), '23505');
  });

  test('a cancelled and a new approved update can coexist', async () => {
    await update('cancelled');
    await update('approved', 'v1.0.2');
    await update('succeeded', 'v1.0.3');
    await update('failed_needs_attention', 'v1.0.4');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM updates WHERE state = 'approved'`)).rows[0].n, 1);
  });

  test('an unknown state is refused', async () => {
    assert.equal(await sqlstate(update('bogus')), '23514');
  });

  test('update_changes is append-only', async () => {
    const id = await update('approved');
    const cid = uuidv7();
    await pool.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, detail) VALUES ($1, $2, $3, 'approved', $4, '{}')`, [cid, id, NOW, admin]);
    assert.equal(await sqlstate(pool.query(`UPDATE update_changes SET action = 'cancelled' WHERE id = $1`, [cid])), '23001');
    assert.equal(await sqlstate(pool.query(`DELETE FROM update_changes WHERE id = $1`, [cid])), '23001');
    assert.equal(await sqlstate(pool.query(`TRUNCATE update_changes`)), '23001');
  });

  test('update_steps is append-only: only a running row may be finished', async () => {
    const id = await update('installing');
    const sid = uuidv7();
    await pool.query(`INSERT INTO update_steps (id, update_id, step, started_at, outcome) VALUES ($1, $2, 'backup', $3, 'running')`, [sid, id, NOW]);
    assert.equal(await sqlstate(pool.query(`UPDATE update_steps SET step = 'other' WHERE id = $1`, [sid])), '23001');
    assert.equal(await sqlstate(pool.query(`UPDATE update_steps SET started_at = $2 WHERE id = $1`, [sid, NOW])), '23001');
    assert.equal(await sqlstate(pool.query(`DELETE FROM update_steps WHERE id = $1`, [sid])), '23001');
    assert.equal(await sqlstate(pool.query(`TRUNCATE update_steps`)), '23001');
    await pool.query(`UPDATE update_steps SET finished_at = $2, outcome = 'failed', failure_code = 'backup_failed' WHERE id = $1`, [sid, NOW]);
    // Finished: no further change.
    assert.equal(await sqlstate(pool.query(`UPDATE update_steps SET outcome = 'passed' WHERE id = $1`, [sid])), '23001');
    assert.equal(await sqlstate(pool.query(`DELETE FROM update_steps WHERE id = $1`, [sid])), '23001');
  });

  test('operations_state accepts reason update, and still refuses an unknown reason', async () => {
    await pool.query(`UPDATE operations_state SET protective = true, reason = 'update', since = $1, detail = '{"updateId":"x","version":"1.0.1"}'`, [NOW]);
    assert.equal((await pool.query(`SELECT reason FROM operations_state`)).rows[0].reason, 'update');
    assert.equal(await sqlstate(pool.query(`UPDATE operations_state SET reason = 'nope'`)), '23514');
    await pool.query(`UPDATE operations_state SET protective = false, reason = NULL, since = NULL, detail = NULL`);
  });

  test('release and tick tables take their rows', async () => {
    await pool.query(`INSERT INTO release_checks (id, at, trigger, outcome, newest_tag, newest_commit) VALUES ($1, $2, 'daily', 'found', 'v1.0.1', 'abc')`, [uuidv7(), NOW]);
    await pool.query(`INSERT INTO releases_seen (tag, commit, first_seen_at) VALUES ('v1.0.1', 'abc', $1) ON CONFLICT DO NOTHING`, [NOW]);
    await pool.query(`INSERT INTO updater_ticks (id, at, did, running_tag, key_fingerprint) VALUES ($1, $2, 'checked', 'v1.0.0', 'SHA256:x')`, [uuidv7(), NOW]);
    assert.equal(await sqlstate(pool.query(`INSERT INTO release_checks (id, at, trigger, outcome) VALUES ($1, $2, 'weekly', 'found')`, [uuidv7(), NOW])), '23514');
  });
});
