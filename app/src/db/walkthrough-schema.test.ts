import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../config';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedProject, seedUser } from '../testing/projects';
import { runMigrations } from './migrate';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;

/** The SQLSTATE a statement fails with, or 'ok' when it succeeds. */
async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('walkthrough schema (0040)', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let user: string;
  let project: string;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    user = await seedUser(pool, 'walkthrough@example.org');
    project = await seedProject(pool, { status: 'active', members: [{ userId: user, role: 'pm' }] });
  });
  after(async () => {
    await pool.end();
  });

  const insertTask = (id: string, description: string | null) =>
    sqlState(
      pool,
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, authorised_by, authorised_at, description)
       VALUES ($1, $2, 0, 'Order samples', $3, '2026-11-30', $3, now(), $4)`,
      [id, project, user, description],
    );
  const insertProposal = (id: string, description: string | null) =>
    sqlState(
      pool,
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, description) VALUES ($1, $2, 'action', 'Order samples', $3, now(), $4)`,
      [id, project, user, description],
    );

  for (const [table, insert] of [['tasks', insertTask], ['human_proposals', insertProposal]] as const) {
    test(`${table}.description is optional, not blank, and at most 4,000 characters unless a credential was removed`, async () => {
      const id = uuidv7();
      assert.equal(await insert(id, null), 'ok');
      const set = (d: string | null) => sqlState(pool, `UPDATE ${table} SET description = $2 WHERE id = $1`, [id, d]);
      assert.equal(await set('x'.repeat(4000)), 'ok');
      assert.equal(await set('x'.repeat(4001)), '23514');
      assert.equal(await set(''), '23514');
      assert.equal(await set('   '), '23514');
      assert.equal(await set(`${'x'.repeat(3995)} [credential removed]`), 'ok');
      assert.equal(await set(null), 'ok');
      assert.equal(await insert(uuidv7(), 'x'.repeat(4001)), '23514');
    });
  }

  test('a person may have one department from the central list, or none', async () => {
    const department = uuidv7();
    assert.equal((await pool.query(`SELECT department_id FROM users WHERE id = $1`, [user])).rows[0].department_id, null);
    await pool.query(`INSERT INTO departments (id, name, status, created_by, created_at) VALUES ($1, 'Dummy Department', 'active', $2, now())`, [department, user]);
    const set = (d: string | null) => sqlState(pool, `UPDATE users SET department_id = $2 WHERE id = $1`, [user, d]);
    assert.equal(await set(uuidv7()), '23503');
    assert.equal(await set(department), 'ok');
    assert.equal(await set(null), 'ok');
  });

  test('a stage change may be a rename, and a rename names its stage', async () => {
    const stage = uuidv7();
    await pool.query(`INSERT INTO project_stages (id, project_id, position, name, added_at) VALUES ($1, $2, 20, 'Pilot', now())`, [stage, project]);
    const insert = (kind: string, stageId: string | null) =>
      sqlState(
        pool,
        `INSERT INTO project_stage_changes (id, project_id, kind, stage_id, actor_id, at, reason, previous, next) VALUES ($1, $2, $3, $4, $5, now(), 'Agreed', '[]', '[]')`,
        [uuidv7(), project, kind, stageId, user],
      );
    for (const kind of ['added', 'retired', 'restored', 'renamed']) {
      assert.equal(await insert(kind, stage), 'ok', kind);
      assert.equal(await insert(kind, null), '23514', `${kind} needs a stage`);
    }
    assert.equal(await insert('reordered', null), 'ok');
    assert.equal(await insert('moved', stage), '23514');
  });

  test('stage names still differ within a project, ignoring case; names holding a removed credential may match', async () => {
    const insert = (name: string) =>
      sqlState(pool, `INSERT INTO project_stages (id, project_id, position, name, added_at) VALUES ($1, $2, 30, $3, now())`, [uuidv7(), project, name]);
    assert.equal(await insert('Field trial'), 'ok');
    assert.equal(await insert('FIELD TRIAL'), '23505');
    assert.equal(await insert('Trial [credential removed]'), 'ok');
    assert.equal(await insert('Trial [credential removed]'), 'ok');
  });
});
