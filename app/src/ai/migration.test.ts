import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const RESTRICT = '23001';
const CHECK = '23514';
const UNIQUE = '23505';

describe('migration 0028 (AI configuration)', { skip: SKIP_NO_DB }, () => {
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
    // Everything before 0028 first, so a settings row and a spend entry exist when 0028 runs.
    const dir = mkdtempSync(join(tmpdir(), 'kainow-mig0028-'));
    for (const f of readdirSync(migrationsDir).filter((n) => /^\d{4}_.+\.sql$/.test(n) && n < '0028')) {
      copyFileSync(join(migrationsDir, f), join(dir, f));
    }
    await runMigrations(pool, dir);
    userId = await seedUser(pool, 'ada@example.org');
    projectId = await seedProject(pool, { status: 'active', members: [{ userId, role: 'pm' }] });
    await pool.query(
      `INSERT INTO ai_spend_settings (id, model_id, input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro,
                                      myr_per_usd_micro, monthly_limit_micro_myr, daily_mode, updated_at)
       VALUES (1, 'gpt-test', 2000000, 500000, 8000000, 4100000, 1000000000, 'not_applied', now())`,
    );
    await pool.query(
      `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, model_id,
                                     input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro,
                                     myr_per_usd_micro, estimate_micro_myr, amount_micro_myr)
       VALUES ($1, $2, 1, now(), now(), 'confirmed', 'extraction', 'gpt-test', 1, 1, 1, 1, 10, 10)`,
      [uuidv7(), uuidv7()],
    );
    await runMigrations(pool, migrationsDir);
  });

  async function model(modelId = 'm-1'): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
                              cache_write_usd_per_million_micro, output_usd_per_million_micro, data_terms, purposes, restricted_ok, state, updated_at)
       VALUES ($1, 'anthropic', $2, 'M', 1, 1, 0, 1, 'terms', '{extraction}', false, 'approved', now())`,
      [id, modelId],
    );
    return id;
  }

  async function connection(modelRef: string, position = 1): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, created_at, created_by)
       VALUES ($1, $2, $3, 'Main', $4, 'unchecked', now(), $5)`,
      [id, projectId, modelRef, position, userId],
    );
    return id;
  }

  const KEY_SQL = `INSERT INTO ai_connection_keys (id, connection_id, ciphertext, nonce, tag, key_id, saved_at, saved_by)
       VALUES ($1, $2, '\\x01', '\\x02', '\\x03', 'k1', now(), $3)`;

  async function key(connectionId: string): Promise<string> {
    const id = uuidv7();
    await pool.query(KEY_SQL, [id, connectionId, userId]);
    return id;
  }

  test('the settings row moves its model and prices into a withdrawn catalogue entry', async () => {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_spend_settings'`);
    const names = cols.rows.map((r) => r.column_name);
    for (const gone of ['model_id', 'input_usd_per_million_micro', 'cached_input_usd_per_million_micro', 'output_usd_per_million_micro']) {
      assert.ok(!names.includes(gone), `${gone} dropped`);
    }
    const { rows } = await pool.query(`SELECT * FROM ai_models`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'openai');
    assert.equal(rows[0].model_id, 'gpt-test');
    assert.equal(rows[0].state, 'withdrawn');
    assert.deepEqual(rows[0].purposes, []);
    assert.equal(rows[0].restricted_ok, false);
    assert.equal(rows[0].data_terms, 'Recorded before sub-project 6 — review before approving');
    assert.equal(rows[0].input_usd_per_million_micro, '2000000');
    assert.equal(rows[0].cached_input_usd_per_million_micro, '500000');
    assert.equal(rows[0].output_usd_per_million_micro, '8000000');
    assert.equal(rows[0].cache_write_usd_per_million_micro, '0');
  });

  test('the new settings columns have the defaults and bounds of D87', async () => {
    const { rows } = await pool.query(`SELECT * FROM ai_spend_settings`);
    assert.equal(rows[0].projects_may_set_limits, false);
    assert.equal(rows[0].projects_may_manage_connections, false);
    assert.equal(rows[0].project_ceiling_mode, 'not_applied');
    assert.equal(rows[0].max_attempts, 3);
    assert.equal(rows[0].timeout_seconds, 120);
    assert.equal(rows[0].concurrency, 2);
    assert.equal(await sqlState(pool, `UPDATE ai_spend_settings SET max_attempts = 6`), CHECK);
    assert.equal(await sqlState(pool, `UPDATE ai_spend_settings SET max_attempts = 0`), CHECK);
    assert.equal(await sqlState(pool, `UPDATE ai_spend_settings SET timeout_seconds = 29`), CHECK);
    assert.equal(await sqlState(pool, `UPDATE ai_spend_settings SET timeout_seconds = 301`), CHECK);
    assert.equal(await sqlState(pool, `UPDATE ai_spend_settings SET concurrency = 11`), CHECK);
    assert.equal(await sqlState(pool, `UPDATE ai_spend_settings SET concurrency = 0`), CHECK);
    assert.equal(await sqlState(pool, `UPDATE ai_spend_settings SET project_ceiling_micro_myr = 5`), CHECK);
    assert.equal(await sqlState(pool, `UPDATE ai_spend_settings SET project_ceiling_mode = 'limit', project_ceiling_micro_myr = 5`), 'ok');
  });

  test('catalogue entries are unique per provider and model, and never deleted', async () => {
    await model('m-1');
    assert.equal(
      await sqlState(
        pool,
        `INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
                                cache_write_usd_per_million_micro, output_usd_per_million_micro, data_terms, state, updated_at)
         VALUES ($1, 'anthropic', 'm-1', 'M', 1, 1, 0, 1, 't', 'approved', now())`,
        [uuidv7()],
      ),
      UNIQUE,
    );
    assert.equal(await sqlState(pool, `UPDATE ai_models SET purposes = '{nonsense}' WHERE model_id = 'm-1'`), CHECK);
    assert.equal(await sqlState(pool, `UPDATE ai_models SET provider = 'other' WHERE model_id = 'm-1'`), CHECK);
    assert.equal(await sqlState(pool, `DELETE FROM ai_models`), RESTRICT);
  });

  test('connections are never deleted; positions are unique per project but reorderable in one transaction', async () => {
    const m = await model();
    const a = await connection(m, 1);
    const b = await connection(m, 2);
    assert.equal(await sqlState(pool, `DELETE FROM ai_connections`), RESTRICT);
    assert.equal(await sqlState(pool, `UPDATE ai_connections SET position = 1 WHERE id = $1`, [b]), UNIQUE);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE ai_connections SET position = 2 WHERE id = $1`, [a]);
      await client.query(`UPDATE ai_connections SET position = 1 WHERE id = $1`, [b]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT position FROM ai_connections WHERE id = $1`, [a]);
    assert.equal(rows[0].position, 2);
  });

  test('keys: one current row, immutable apart from superseded_at (set once), never deleted', async () => {
    const c = await connection(await model());
    const first = await key(c);
    assert.equal(await sqlState(pool, KEY_SQL, [uuidv7(), c, userId]), UNIQUE);
    assert.equal(await sqlState(pool, `UPDATE ai_connection_keys SET ciphertext = '\\x09' WHERE id = $1`, [first]), RESTRICT);
    assert.equal(await sqlState(pool, `UPDATE ai_connection_keys SET saved_at = now() WHERE id = $1`, [first]), RESTRICT);
    assert.equal(await sqlState(pool, `DELETE FROM ai_connection_keys`), RESTRICT);
    assert.equal(await sqlState(pool, `UPDATE ai_connection_keys SET superseded_at = now() WHERE id = $1`, [first]), 'ok');
    assert.equal(await sqlState(pool, `UPDATE ai_connection_keys SET superseded_at = now() WHERE id = $1`, [first]), RESTRICT);
    assert.equal(await sqlState(pool, `UPDATE ai_connection_keys SET superseded_at = NULL WHERE id = $1`, [first]), RESTRICT);
    await key(c); // a new current row is fine once the old one is superseded
  });

  test('event tables are append-only', async () => {
    const m = await model();
    const c = await connection(m);
    await pool.query(
      `INSERT INTO ai_connection_events (id, connection_id, action, actor_id, reason, at) VALUES ($1, $2, 'added', $3, 'first', now())`,
      [uuidv7(), c, userId],
    );
    assert.equal(await sqlState(pool, `UPDATE ai_connection_events SET reason = 'x'`), RESTRICT);
    assert.equal(await sqlState(pool, `DELETE FROM ai_connection_events`), RESTRICT);
    await pool.query(`INSERT INTO ai_model_events (id, model_ref, action, actor_id, reason, at) VALUES ($1, $2, 'approved', $3, 'ok', now())`, [uuidv7(), m, userId]);
    assert.equal(await sqlState(pool, `UPDATE ai_model_events SET reason = 'x'`), RESTRICT);
    assert.equal(await sqlState(pool, `DELETE FROM ai_model_events`), RESTRICT);
    await pool.query(`INSERT INTO project_ai_limit_events (id, project_id, actor_id, reason, at) VALUES ($1, $2, $3, 'set', now())`, [uuidv7(), projectId, userId]);
    assert.equal(await sqlState(pool, `UPDATE project_ai_limit_events SET reason = 'x'`), RESTRICT);
    assert.equal(await sqlState(pool, `DELETE FROM project_ai_limit_events`), RESTRICT);
  });

  test('project limits hold the same bounds', async () => {
    const insert = (cols: string, vals: string) =>
      sqlState(
        pool,
        `INSERT INTO project_ai_limits (project_id, daily_mode, user_monthly_mode, updated_at, ${cols}) VALUES ($1, 'not_applied', 'not_applied', now(), ${vals})`,
        [projectId],
      );
    assert.equal(await insert('max_attempts', '6'), CHECK);
    assert.equal(await insert('timeout_seconds', '29'), CHECK);
    assert.equal(await insert('max_attempts', '2'), 'ok');
  });

  test('spend entries: old rows are not ruled; a ruled entry needs a project; never deleted', async () => {
    const old = await pool.query(`SELECT ruled, project_id FROM ai_spend_entries`);
    assert.equal(old.rows[0].ruled, false);
    assert.equal(old.rows[0].project_id, null);
    const insert = (ruled: boolean, project: string | null) =>
      sqlState(
        pool,
        `INSERT INTO ai_spend_entries (id, request_id, attempt_no, created_at, updated_at, status, purpose, model_id,
           input_usd_per_million_micro, cached_input_usd_per_million_micro, output_usd_per_million_micro, myr_per_usd_micro,
           estimate_micro_myr, amount_micro_myr, ruled, project_id)
         VALUES ($1, $2, 1, now(), now(), 'confirmed', 'extraction', 'm', 1, 1, 1, 1, 10, 10, $3, $4)`,
        [uuidv7(), uuidv7(), ruled, project],
      );
    assert.equal(await insert(true, null), CHECK);
    assert.equal(await insert(true, projectId), 'ok');
    assert.equal(await insert(false, null), 'ok');
    assert.equal(await sqlState(pool, `DELETE FROM ai_spend_entries`), 'P0001');
  });

  test('ten call slots exist', async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n, min(slot) AS lo, max(slot) AS hi FROM ai_call_slots`);
    assert.deepEqual(rows[0], { n: 10, lo: 1, hi: 10 });
  });
});
