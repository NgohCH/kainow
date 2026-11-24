import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { GENERAL_TEMPLATE_ID, STARTER_TEMPLATES } from '../projects/stage-templates';
import { STAGES } from '../projects/lifecycle';
import { SUBSTAGES } from '../projects/projects.service';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { runMigrations } from './migrate';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

/** A copy of the migrations before 0037, so a project can exist before stage templates arrive. */
function migrationsBefore0037(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
  for (const f of readdirSync(migrationsDir)) {
    if (/^\d{4}_.+\.sql$/.test(f) && f < '0037') copyFileSync(join(migrationsDir, f), join(dir, f));
  }
  return dir;
}

async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('stage templates schema (0037)', { skip: SKIP_NO_DB }, () => {
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
    await runMigrations(pool, migrationsBefore0037());
    userId = uuidv7();
    projectId = uuidv7();
    await pool.query(`INSERT INTO users (id, email, display_name, role, status, created_at) VALUES ($1, 'a@example.org', 'A', 'member', 'active', now())`, [userId]);
    const dept = uuidv7();
    await pool.query(`INSERT INTO departments (id, name, created_by, created_at) VALUES ($1, 'Registry', $2, now())`, [dept, userId]);
    await pool.query(
      `INSERT INTO projects (id, name, purpose, owning_department_id, status, created_by, created_at)
       VALUES ($1, 'Existing', 'Purpose', $2, 'active', $3, '2026-10-31T16:00:00Z')`,
      [projectId, dept, userId],
    );
    await pool.query(`INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, 'Planning', now(), $3)`, [uuidv7(), projectId, userId]);
    const result = await runMigrations(pool, migrationsDir);
    assert.ok(result.applied.includes('0037_stage_templates.sql'));
  });

  test('the seven starter templates are seeded in spec order with their stages, as in stage-templates.ts', async () => {
    const templates = (await pool.query(`SELECT id, name, status, position, created_by, description FROM stage_templates ORDER BY position`)).rows;
    assert.deepEqual(templates.map((t) => t.name), ['General', 'Software development', 'Product sales', 'Research project', 'Syllabus development', 'Marketing campaign', 'Event']);
    assert.deepEqual(templates.map((t) => t.position), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(templates.every((t) => t.status === 'active' && t.created_by === null && t.description === null));
    for (const starter of STARTER_TEMPLATES) {
      const row = templates.find((t) => t.id === starter.id);
      assert.equal(row?.name, starter.name, `${starter.name} has its fixed id`);
      const stages = (await pool.query(`SELECT name, substages FROM stage_template_stages WHERE template_id = $1 ORDER BY position`, [starter.id])).rows;
      assert.deepEqual(stages, starter.stages, starter.name);
    }
  });

  test("General's stages and substages are exactly today's five", async () => {
    const stages = (await pool.query(`SELECT name, substages FROM stage_template_stages WHERE template_id = $1 ORDER BY position`, [GENERAL_TEMPLATE_ID])).rows;
    assert.deepEqual(stages.map((s) => s.name), [...STAGES]);
    for (const s of stages) assert.deepEqual(s.substages, [...SUBSTAGES[s.name]]);
    assert.deepEqual(stages[0].substages, ['Define Purpose', 'Identify Participants', 'Confirm Accountability']);
    assert.deepEqual(stages[2].substages, ['In Progress', 'Monitoring & Follow-up']);
  });

  test('an existing project gets a copy of General and records it as its template', async () => {
    const rows = (
      await pool.query(`SELECT position, name, substages, status, added_by, added_at, retired_at FROM project_stages WHERE project_id = $1 ORDER BY position`, [projectId])
    ).rows;
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((r) => r.name), [...STAGES]);
    assert.deepEqual(rows.map((r) => r.position), [1, 2, 3, 4, 5]);
    assert.deepEqual(rows[1].substages, ['Define Scope', 'Break Down Work', 'Identify Resources', 'Approve Plan']);
    for (const r of rows) {
      assert.equal(r.status, 'active');
      assert.equal(r.added_by, userId);
      assert.equal(r.added_at.toISOString(), '2026-10-31T16:00:00.000Z');
      assert.equal(r.retired_at, null);
    }
    assert.equal((await pool.query(`SELECT stage_template_id FROM projects WHERE id = $1`, [projectId])).rows[0].stage_template_id, GENERAL_TEMPLATE_ID);
  });

  test('a stage period accepts a stage name outside the old five; past periods keep theirs', async () => {
    await pool.query(`UPDATE project_stage_periods SET ended_at = now() WHERE project_id = $1`, [projectId]);
    assert.equal(
      await sqlState(pool, `INSERT INTO project_stage_periods (id, project_id, stage, started_at, started_by) VALUES ($1, $2, 'Data collection', now(), $3)`, [uuidv7(), projectId, userId]),
      'ok',
    );
    assert.deepEqual((await pool.query(`SELECT stage FROM project_stage_periods WHERE project_id = $1 ORDER BY started_at`, [projectId])).rows.map((r) => r.stage), ['Planning', 'Data collection']);
  });

  test('names are unique among active templates ignoring case, and within a template and a project', async () => {
    const insert = (name: string, status = 'active') =>
      sqlState(pool, `INSERT INTO stage_templates (id, name, status, position, created_at) VALUES ($1, $2, $3, 8, now())`, [uuidv7(), name, status]);
    assert.equal(await insert('GENERAL'), '23505');
    assert.equal(await insert('general', 'retired'), 'ok', 'a retired template may share a name');
    assert.equal(await insert('x'.repeat(81)), '23514');
    assert.equal(await insert('  '), '23514');
    assert.equal(
      await sqlState(pool, `INSERT INTO stage_template_stages (id, template_id, position, name) VALUES ($1, $2, 9, 'closure')`, [uuidv7(), GENERAL_TEMPLATE_ID]),
      '23505',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO project_stages (id, project_id, position, name, added_at) VALUES ($1, $2, 9, 'PLANNING', now())`, [uuidv7(), projectId]),
      '23505',
    );
    assert.equal(
      await sqlState(pool, `INSERT INTO project_stages (id, project_id, position, name, status, added_at) VALUES ($1, $2, 9, 'Pilot', 'paused', now())`, [uuidv7(), projectId]),
      '23514',
    );
  });
});
