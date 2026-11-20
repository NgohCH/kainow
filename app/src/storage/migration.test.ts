import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

/** The values of the single-column CHECK on change_requests.<col>, from the database catalogue. */
async function checkValues(pool: Pool, col: string): Promise<string[]> {
  const { rows } = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.conrelid = 'change_requests'::regclass AND c.contype = 'c' AND cardinality(c.conkey) = 1 AND a.attname = $1`,
    [col],
  );
  return rows.flatMap((r) => [...r.def.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const SQL_IN = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

describe('migration 0031 (external outputs)', { skip: SKIP_NO_DB }, () => {
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

  async function output(): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO outputs (id, project_id, title, status, author_id, created_at) VALUES ($1, $2, 'Status', 'submitted', $3, now())`,
      [id, projectId, userId],
    );
    return id;
  }

  async function outputVersion(outputId: string): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO output_versions (id, output_id, version_no, origin, format, status, sha256, size_bytes, created_by, created_at)
       VALUES ($1, $2, 1, 'upload', 'pdf', 'draft', 'abc', 10, $3, now())`,
      [id, outputId, userId],
    );
    return id;
  }

  async function storedFile(): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO stored_files (id, purpose, project_id, name, state, created_at) VALUES ($1, 'output', $2, 'a.pdf', 'pending', now())`,
      [id, projectId],
    );
    return id;
  }

  async function destination(purpose: string, status: string): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, status, created_by, created_at)
       VALUES ($1, 'local', 'local', $2, 'Library', $3, $4, now())`,
      [id, purpose, status, userId],
    );
    return id;
  }

  const insertRequest = (kind: string, targetId: string) =>
    sqlState(
      pool,
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, submitted_by, submitted_at)
       VALUES ($1, $2, $3, 'output_version', $4, 1, $5, now())`,
      [uuidv7(), projectId, kind, targetId, userId],
    );

  test('migration 0031 creates the storage and output tables', async () => {
    const tables = [
      'report_types', 'storage_settings', 'storage_settings_changes', 'storage_connection_secrets', 'storage_destinations',
      'storage_destination_events', 'storage_folders', 'stored_files', 'stored_file_moves', 'storage_outbox', 'storage_attempts',
      'storage_grants', 'storage_admins', 'storage_admin_events', 'project_output_settings', 'project_output_settings_changes',
      'outputs', 'output_categories', 'output_contributors', 'output_versions', 'output_version_bytes', 'output_events',
      'project_department_transfers',
    ];
    const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const have = new Set(rows.map((r) => r.table_name as string));
    assert.deepEqual(tables.filter((t) => !have.has(t)), []);
  });

  test('seeds report types and storage settings', async () => {
    const types = await pool.query(`SELECT name, position FROM report_types ORDER BY position`);
    assert.deepEqual(types.rows.map((r) => r.name), [
      'Status reports', 'Decisions and actions', 'Risk summaries', 'Specifications', 'Minutes', 'Exports', 'Other',
    ]);
    assert.deepEqual(types.rows.map((r) => r.position), [1, 2, 3, 4, 5, 6, 7]);
    const s = await pool.query(`SELECT * FROM storage_settings`);
    assert.equal(s.rowCount, 1);
    assert.deepEqual(s.rows[0].approved_input_formats, ['txt', 'md', 'docx', 'pdf']);
    assert.deepEqual(s.rows[0].approved_output_formats, ['md', 'docx', 'pdf', 'csv']);
    assert.equal(s.rows[0].directory_lookup, false);
    assert.equal(s.rows[0].scheduled_checks, false);
    assert.equal((await pool.query(`SELECT project_exports_allowed FROM access_settings`)).rows[0].project_exports_allowed, false);
  });

  test('only one approved source area', async () => {
    await destination('source_area', 'approved');
    await destination('source_area', 'proposed');
    await destination('outputs', 'approved');
    assert.equal(
      await sqlState(
        pool,
        `INSERT INTO storage_destinations (id, connector, kind, purpose, label, status, created_by, created_at)
         VALUES ($1, 'local', 'local', 'source_area', 'Second', 'approved', $2, now())`,
        [uuidv7(), userId],
      ),
      '23505',
    );
  });

  test('a folder holds one live grant per person', async () => {
    const dest = await destination('outputs', 'approved');
    const folder = uuidv7();
    await pool.query(
      `INSERT INTO storage_folders (id, destination_id, level, key, item_id, name, created_at) VALUES ($1, $2, 'project', 'k', 'i', 'P', now())`,
      [folder, dest],
    );
    const grant = (state: string) =>
      sqlState(pool, `INSERT INTO storage_grants (id, folder_id, user_id, role, state, updated_at) VALUES ($1, $2, $3, 'read', $4, now())`, [
        uuidv7(), folder, otherId, state,
      ]);
    assert.equal(await grant('granted'), 'ok');
    assert.equal(await grant('pending'), '23505');
    await pool.query(`UPDATE storage_grants SET state = 'revoked'`);
    assert.equal(await grant('pending'), 'ok');
  });

  test('append-only event tables', async () => {
    const o = await output();
    const dest = await destination('outputs', 'proposed');
    const file = await storedFile();
    const admin = uuidv7();
    await pool.query(
      `INSERT INTO storage_admins (id, user_id, designated_by, designated_at, reason) VALUES ($1, $2, $3, now(), 'Covers storage')`,
      [admin, otherId, userId],
    );
    const rows: Array<[string, string, unknown[]]> = [
      ['output_events', `INSERT INTO output_events (id, output_id, kind, at) VALUES ($1, $2, 'submitted', now())`, [uuidv7(), o]],
      [
        'storage_destination_events',
        `INSERT INTO storage_destination_events (id, destination_id, kind, actor_id, at) VALUES ($1, $2, 'proposed', $3, now())`,
        [uuidv7(), dest, userId],
      ],
      ['stored_file_moves', `INSERT INTO stored_file_moves (id, stored_file_id, reason, at) VALUES ($1, $2, 'filed', now())`, [uuidv7(), file]],
      [
        'storage_admin_events',
        `INSERT INTO storage_admin_events (id, admin_id, kind, actor_id, at, reason) VALUES ($1, $2, 'designated', $3, now(), 'Covers storage')`,
        [uuidv7(), admin, userId],
      ],
      [
        'storage_settings_changes',
        `INSERT INTO storage_settings_changes (id, actor_id, at, reason, previous, next) VALUES ($1, $2, now(), 'Why', '{}', '{}')`,
        [uuidv7(), userId],
      ],
      [
        'project_output_settings_changes',
        `INSERT INTO project_output_settings_changes (id, project_id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, now(), 'Why', '{}', '{}')`,
        [uuidv7(), projectId, userId],
      ],
    ];
    for (const [table, insert, params] of rows) {
      assert.equal(await sqlState(pool, insert, params), 'ok', `${table} insert`);
      assert.equal(await sqlState(pool, `UPDATE ${table} SET id = id`), '23001', `${table} update`);
      assert.equal(await sqlState(pool, `DELETE FROM ${table}`), '23001', `${table} delete`);
      assert.equal(await sqlState(pool, `TRUNCATE ${table} CASCADE`), '23001', `${table} truncate`);
    }
  });

  test('output_versions content is immutable', async () => {
    const o = await output();
    const v = await outputVersion(o);
    assert.equal(await sqlState(pool, `UPDATE output_versions SET sha256 = 'x' WHERE id = $1`, [v]), '23001');
    assert.equal(await sqlState(pool, `UPDATE output_versions SET version_no = 2 WHERE id = $1`, [v]), '23001');
    assert.equal(await sqlState(pool, `DELETE FROM output_versions WHERE id = $1`, [v]), '23001');
    const file = await storedFile();
    const request = uuidv7();
    await pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, submitted_by, submitted_at)
       VALUES ($1, $2, 'approve_output', 'output_version', $3, 1, $4, now())`,
      [request, projectId, v, userId],
    );
    assert.equal(
      await sqlState(pool, `UPDATE output_versions SET status = 'approved', stored_file_id = $2, approval_request_id = $3 WHERE id = $1`, [v, file, request]),
      'ok',
    );
    const heldCase = uuidv7();
    await pool.query(
      `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, marked_length, reported_at) VALUES ($1, $2, 'output', $3, 5, now())`,
      [heldCase, projectId, o],
    );
    assert.equal(await sqlState(pool, `UPDATE output_versions SET held_case_id = $2 WHERE id = $1`, [v, heldCase]), 'ok');
  });

  test('change_requests accepts approve_output on output_version and keeps every earlier kind and target', async () => {
    const kinds = await checkValues(pool, 'kind');
    const targets = await checkValues(pool, 'target_kind');
    for (const k of [
      'authorise_proposal', 'amend_task', 'cancel_task', 'supersede_decision', 'withdraw_decision', 'deadline_review',
      'reconcile_completion', 'risk_handover', 'approve_output',
    ]) {
      assert.ok(kinds.includes(k), `kind ${k}`);
    }
    for (const t of ['extraction_item', 'human_proposal', 'task', 'decision', 'risk', 'output_version']) assert.ok(targets.includes(t), `target ${t}`);
    const v = await outputVersion(await output());
    assert.equal(await insertRequest('approve_output', v), 'ok');
    assert.equal(await insertRequest('no_such_kind', v), '23514');
  });

  test('0031 keeps whatever kinds and targets the database held before it', async () => {
    // Everything before 0031 in a scratch copy; then widen the lists as a sibling migration would; then apply 0031.
    const dir = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
    try {
      for (const f of readdirSync(migrationsDir).filter((n) => /^\d{4}_.+\.sql$/.test(n) && n < '0031')) cpSync(join(migrationsDir, f), join(dir, f));
      await resetPublicSchema(pool);
      await runMigrations(pool, dir);
      const kindsBefore = await checkValues(pool, 'kind');
      const targetsBefore = await checkValues(pool, 'target_kind');
      assert.ok(!kindsBefore.includes('approve_output'));
      await pool.query(`ALTER TABLE change_requests DROP CONSTRAINT change_requests_kind_check`);
      await pool.query(
        `ALTER TABLE change_requests ADD CONSTRAINT change_requests_kind_check CHECK (kind IN (${SQL_IN([...kindsBefore, 'set_budget', 'finance_adjustment'])}))`,
      );
      await pool.query(`ALTER TABLE change_requests DROP CONSTRAINT change_requests_target_kind_check`);
      await pool.query(
        `ALTER TABLE change_requests ADD CONSTRAINT change_requests_target_kind_check CHECK (target_kind IN (${SQL_IN([...targetsBefore, 'project_budget', 'expenditure'])}))`,
      );
      await runMigrations(pool, migrationsDir);
      const kinds = await checkValues(pool, 'kind');
      const targets = await checkValues(pool, 'target_kind');
      for (const k of [...kindsBefore, 'set_budget', 'finance_adjustment', 'approve_output']) assert.ok(kinds.includes(k), `kind ${k}`);
      for (const t of [...targetsBefore, 'project_budget', 'expenditure', 'output_version']) assert.ok(targets.includes(t), `target ${t}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('upload versions may hold bytes or a stored file', async () => {
    const source = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'Notes', $2, now(), $3)`, [source, userId, projectId]);
    const file = await storedFile();
    const insert = (n: number, bytes: Buffer | null, stored: string | null, quarantined: boolean) =>
      sqlState(
        pool,
        `INSERT INTO source_versions (id, source_id, version_no, origin, filename, media_type, original_bytes, original_sha256, original_stored_file_id,
                                      text_content, text_sha256, char_count, created_by, created_at, quarantined_at)
         VALUES ($1, $2, $3, 'upload', 'a.pdf', 'application/pdf', $4, 'h', $5, 'text', 't', 4, $6, now(), $7)`,
        [uuidv7(), source, n, bytes, stored, userId, quarantined ? new Date() : null],
      );
    assert.equal(await insert(1, Buffer.from('x'), null, false), 'ok');
    assert.equal(await insert(2, null, file, false), 'ok');
    assert.equal(await insert(3, null, null, false), '23514');
    assert.equal(await insert(4, null, null, true), 'ok');
  });

  test('the store-source job may move a version to a stored file and nothing else may change', async () => {
    const source = uuidv7();
    const version = uuidv7();
    await pool.query(`INSERT INTO sources (id, title, created_by, created_at, project_id) VALUES ($1, 'Notes', $2, now(), $3)`, [source, userId, projectId]);
    await pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, filename, media_type, original_bytes, original_sha256, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'upload', 'a.pdf', 'application/pdf', 'x', 'h', 'text', 't', 4, $3, now())`,
      [version, source, userId],
    );
    const file = await storedFile();
    const textFile = await storedFile();
    assert.equal(await sqlState(pool, `UPDATE source_versions SET text_content = 'other' WHERE id = $1`, [version]), '23001');
    assert.equal(await sqlState(pool, `UPDATE source_versions SET original_bytes = NULL WHERE id = $1`, [version]), '23514', 'bytes cannot go without a stored file');
    assert.equal(await sqlState(pool, `UPDATE source_versions SET text_stored_file_id = $2 WHERE id = $1`, [version, textFile]), 'ok');
    assert.equal(
      await sqlState(pool, `UPDATE source_versions SET original_bytes = NULL, original_stored_file_id = $2 WHERE id = $1`, [version, file]),
      'ok',
    );
    assert.equal(
      await sqlState(pool, `UPDATE source_versions SET original_stored_file_id = $2 WHERE id = $1`, [version, textFile]),
      '23001',
      'a stored file reference is set once',
    );
    assert.equal(await sqlState(pool, `UPDATE source_versions SET original_bytes = 'x' WHERE id = $1`, [version]), '23001', 'bytes cannot come back');
  });

  test('storage connection secrets are append-only: no delete, no truncate, superseded_at set once', async () => {
    const RESTRICT = '23001';
    const id = uuidv7();
    await pool.query(
      `INSERT INTO storage_connection_secrets (id, ciphertext, nonce, tag, key_id, saved_by, saved_at) VALUES ($1, '\\x01', '\\x02', '\\x03', 'k1', $2, now())`,
      [id, userId],
    );
    assert.equal(await sqlState(pool, `UPDATE storage_connection_secrets SET ciphertext = '\\x09' WHERE id = $1`, [id]), RESTRICT);
    assert.equal(await sqlState(pool, `UPDATE storage_connection_secrets SET saved_at = now() WHERE id = $1`, [id]), RESTRICT);
    assert.equal(await sqlState(pool, `DELETE FROM storage_connection_secrets`), RESTRICT);
    assert.equal(await sqlState(pool, `TRUNCATE storage_connection_secrets`), RESTRICT);
    assert.equal(await sqlState(pool, `UPDATE storage_connection_secrets SET superseded_at = now() WHERE id = $1`, [id]), 'ok');
    assert.equal(await sqlState(pool, `UPDATE storage_connection_secrets SET superseded_at = now() WHERE id = $1`, [id]), RESTRICT);
    assert.equal(await sqlState(pool, `UPDATE storage_connection_secrets SET superseded_at = NULL WHERE id = $1`, [id]), RESTRICT);
  });

  test('go-live has the storage step at position 12', async () => {
    const r = await pool.query(`SELECT position FROM golive_steps WHERE key = 'storage'`);
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0].position, 12);
  });

  test('storage outbox rows are normal priority unless marked urgent', async () => {
    const id = uuidv7();
    await pool.query(`INSERT INTO storage_outbox (id, job, subject_id, created_at) VALUES ($1, 'check', $2, now())`, [id, uuidv7()]);
    assert.equal((await pool.query(`SELECT urgent FROM storage_outbox WHERE id = $1`, [id])).rows[0].urgent, false);
  });
});
