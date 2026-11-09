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

describe('changes schema', { skip: SKIP_NO_DB }, () => {
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

  async function addTask(status = 'in_progress', pid = projectId): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, 'Task', $3, '2026-12-01', $4, $3, now())`,
      [id, pid, userId, status],
    );
    return id;
  }

  async function addRequest(taskId: string, status = 'pending', required = 1): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, status, submitted_by, submitted_at)
       VALUES ($1, $2, 'amend_task', 'task', $3, $5, $4, $6, now())`,
      [id, projectId, taskId, status, required, userId],
    );
    return id;
  }

  test('the approval policy starts as one approval with no project overrides', async () => {
    const { rows } = await pool.query(`SELECT required, projects_may_override FROM approval_policy`);
    assert.deepEqual(rows, [{ required: 1, projects_may_override: false }]);
  });

  test('one open change request per record', async () => {
    const taskId = await addTask();
    const first = await addRequest(taskId);
    assert.equal(await sqlState(pool, `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, status, submitted_by, submitted_at)
      VALUES ($1, $2, 'cancel_task', 'task', $3, 1, 'pending', $4, now())`, [uuidv7(), projectId, taskId, userId]), '23505');
    await pool.query(`UPDATE change_requests SET status = 'withdrawn' WHERE id = $1`, [first]);
    assert.equal(await addRequest(taskId).then(() => 'ok'), 'ok');
  });

  test('approval counts stay between 1 and 3', async () => {
    assert.equal(await sqlState(pool, `UPDATE approval_policy SET required = 4`), '23514');
    assert.equal(await sqlState(pool, `UPDATE approval_policy SET required = 0`), '23514');
    assert.equal(await sqlState(pool, `UPDATE projects SET required_approvals = 0`), '23514');
    assert.equal(await sqlState(pool, `UPDATE projects SET required_approvals = 3`), 'ok');
    assert.equal(await sqlState(pool, `INSERT INTO change_requests (id, project_id, kind, target_kind, target_id, required_approvals, status, submitted_by, submitted_at)
      VALUES ($1, $2, 'amend_task', 'task', $1, 4, 'pending', $3, now())`, [uuidv7(), projectId, userId]), '23514');
  });

  test('only one approval policy row exists', async () => {
    assert.equal(await sqlState(pool, `INSERT INTO approval_policy (id, updated_at) VALUES (2, now())`), '23514');
  });

  test('a person approves a version once', async () => {
    const requestId = await addRequest(await addTask());
    const approve = (version: number) =>
      sqlState(pool, `INSERT INTO approvals (id, request_id, version, approver_id, at) VALUES ($1, $2, $3, $4, now())`, [uuidv7(), requestId, version, userId]);
    assert.equal(await approve(1), 'ok');
    assert.equal(await approve(1), '23505');
    assert.equal(await approve(2), 'ok');
  });

  test('history tables refuse updates', async () => {
    const requestId = await addRequest(await addTask());
    await pool.query(`INSERT INTO change_request_versions (request_id, version, terms, author_id, at) VALUES ($1, 1, '{}', $2, now())`, [requestId, userId]);
    await pool.query(`INSERT INTO approvals (id, request_id, version, approver_id, at) VALUES ($1, $2, 1, $3, now())`, [uuidv7(), requestId, userId]);
    assert.notEqual(await sqlState(pool, `UPDATE change_request_versions SET reason = 'x'`), 'ok');
    assert.notEqual(await sqlState(pool, `DELETE FROM change_request_versions`), 'ok');
    assert.notEqual(await sqlState(pool, `UPDATE approvals SET version = 2`), 'ok');
    assert.notEqual(await sqlState(pool, `DELETE FROM approvals`), 'ok');
    await pool.query(`INSERT INTO approval_policy_changes (id, field, old_value, new_value, reason, actor_id, at) VALUES ($1, 'required', '1', '2', 'Because', $2, now())`, [uuidv7(), userId]);
    assert.notEqual(await sqlState(pool, `UPDATE approval_policy_changes SET reason = 'x'`), 'ok');
  });

  test('a decision has exactly one origin', async () => {
    const taskId = await addTask();
    const requestId = await addRequest(taskId);
    const proposalId = uuidv7();
    await pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'decision', 'D', $3, now())`,
      [proposalId, projectId, userId],
    );
    const add = (proposal: string | null, request: string | null) =>
      sqlState(
        pool,
        `INSERT INTO decisions (id, project_id, statement, origin_proposal_id, origin_request_id, authorised_by, authorised_at)
         VALUES ($1, $2, 'S', $3, $4, $5, now())`,
        [uuidv7(), projectId, proposal, request, userId],
      );
    assert.equal(await add(proposalId, requestId), '23514');
    assert.equal(await add(null, null), '23514');
    assert.equal(await add(null, requestId), 'ok');
    assert.equal(await sqlState(pool, `UPDATE decisions SET status = 'superseded'`), 'ok');
    assert.equal(await sqlState(pool, `UPDATE decisions SET status = 'gone'`), '23514');
  });

  test('a task event may record a review requirement with detail', async () => {
    const taskId = await addTask();
    const add = (kind: string) =>
      sqlState(pool, `INSERT INTO task_events (id, task_id, kind, detail, actor_id, at) VALUES ($1, $2, $3, '{"a":1}', $4, now())`, [uuidv7(), taskId, kind, userId]);
    for (const kind of ['amended', 'cancelled', 'review_required', 'deadline_reviewed', 'reconciled']) assert.equal(await add(kind), 'ok');
    assert.equal(await add('nonsense'), '23514');
  });

  test('one current disposition per record, and one open delegation per project', async () => {
    const recordId = await addTask();
    const choose = () =>
      sqlState(
        pool,
        `INSERT INTO closure_dispositions (id, project_id, record_kind, record_id, disposition, reason, chosen_by, chosen_at)
         VALUES ($1, $2, 'task', $3, 'keep', 'Later', $4, now())`,
        [uuidv7(), projectId, recordId, userId],
      );
    assert.equal(await choose(), 'ok');
    assert.equal(await choose(), '23505');
    await pool.query(`UPDATE closure_dispositions SET replaced_at = now()`);
    assert.equal(await choose(), 'ok');

    const delegate = () =>
      sqlState(pool, `INSERT INTO closure_delegations (id, project_id, pm_user_id, delegated_by, reason, at) VALUES ($1, $2, $3, $3, 'Away', now())`, [uuidv7(), projectId, userId]);
    assert.equal(await delegate(), 'ok');
    assert.equal(await delegate(), '23505');
    await pool.query(`UPDATE closure_delegations SET revoked_by = $1, revoked_at = now()`, [userId]);
    assert.equal(await delegate(), 'ok');
  });

  test('migration marks outstanding work in paused projects', async () => {
    const open = await addTask('in_progress');
    const blocked = await addTask('blocked');
    const done = await addTask('completed');
    const cancelled = await addTask('cancelled');
    const marked = async () =>
      (await pool.query(`SELECT id FROM tasks WHERE deadline_review_required ORDER BY id`)).rows.map((r) => r.id as string);

    assert.equal((await pool.query(`SELECT mark_deadline_review($1, $2) AS n`, [projectId, userId])).rows[0].n, 2);
    assert.deepEqual(await marked(), [open, blocked].sort());
    const events = await pool.query(`SELECT task_id, actor_id FROM task_events WHERE kind = 'review_required'`);
    assert.equal(events.rowCount, 2);
    assert.ok(events.rows.every((r) => r.actor_id === userId));
    assert.ok(![done, cancelled].some((id) => events.rows.some((r) => r.task_id === id)));

    // Running it again marks nothing and adds no events.
    assert.equal((await pool.query(`SELECT mark_deadline_review($1, $2) AS n`, [projectId, userId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM task_events WHERE kind = 'review_required'`)).rows[0].n, 2);
  });
});
