import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedAiModel } from '../testing/ai-connections';
import { seedProject, seedUser } from '../testing/projects';

// The test clock starts at 2026-11-09T02:00Z (Monday 10:00 UTC+8); the default period is the last 12 weeks.
describe('analytics system problems panel', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let createdJobTable = false;

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    await seedUser(t.pool, 'member@example.org');
    admin = await t.signIn('admin@example.org');
  });
  afterEach(async () => {
    if (createdJobTable) await t.pool.query(`DROP TABLE pgboss.job`);
    createdJobTable = false;
    await t?.close();
  });

  const system = async (extra = '') => {
    const r = await admin.request('GET', `/admin/analytics?panel=system${extra}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  async function email(status: string, at: string, nextAttemptAt: string | null = null) {
    await t.pool.query(
      `INSERT INTO email_outbox (id, to_address, subject, text_body, kind, initiated_by, status, next_attempt_at, created_at)
       VALUES ($1, 'someone@example.org', 'Subject', 'Body', 'digest', 'system', $2, $3, $4)`,
      [uuidv7(), status, nextAttemptAt, at],
    );
  }
  async function jobTable() {
    await t.pool.query(`CREATE SCHEMA IF NOT EXISTS pgboss`);
    const exists = (await t.pool.query(`SELECT to_regclass('pgboss.job') IS NOT NULL AS ok`)).rows[0].ok as boolean;
    assert.equal(exists, false, 'the test creates its own job table');
    await t.pool.query(
      `CREATE TABLE pgboss.job (name text NOT NULL, state text NOT NULL, created_on timestamptz NOT NULL DEFAULT now(), start_after timestamptz NOT NULL DEFAULT now(), completed_on timestamptz)`,
    );
    createdJobTable = true;
  }
  const job = (name: string, state: string, o: { createdOn?: string; startAfter?: string; completedOn?: string | null } = {}) =>
    t.pool.query(`INSERT INTO pgboss.job (name, state, created_on, start_after, completed_on) VALUES ($1, $2, $3, $4, $5)`, [
      name, state, o.createdOn ?? '2026-11-09T01:00:00Z', o.startAfter ?? o.createdOn ?? '2026-11-09T01:00:00Z', o.completedOn ?? null,
    ]);

  test('member gets 403', async () => {
    const member = await t.signIn('member@example.org');
    assert.equal((await member.request('GET', '/admin/analytics?panel=system')).status, 403);
  });

  test('failed and uncertain emails in the period counted', async () => {
    await email('failed', '2026-11-02T01:00:00Z');
    await email('failed', '2026-11-03T01:00:00Z');
    await email('uncertain', '2026-11-04T01:00:00Z');
    await email('failed', '2026-01-01T01:00:00Z');
    await email('sent', '2026-11-04T01:00:00Z');
    await email('retry_wait', '2026-11-08T01:00:00Z', '2026-11-09T05:00:00Z');
    await email('retry_wait', '2026-01-02T01:00:00Z', '2026-11-09T05:00:00Z');
    const body = await system();
    assert.equal(body.panel, 'system');
    assert.deepEqual(body.data.emails, { failed: 2, uncertain: 1, retryWaiting: 2 });
    assert.equal(body.data.computedAt, t.clock.now().toISOString());
    const month = await system('&period=last_month');
    assert.deepEqual(month.data.emails, { failed: 0, uncertain: 0, retryWaiting: 2 });
  });

  test('job waiting 16 minutes counted, 14 not; failed jobs by queue in the period', async () => {
    await jobTable();
    await job('ai', 'created', { createdOn: '2026-11-09T01:44:00Z' });
    await job('email', 'retry', { createdOn: '2026-11-09T01:00:00Z', startAfter: '2026-11-09T01:30:00Z' });
    await job('ai', 'created', { createdOn: '2026-11-09T01:50:00Z' });
    await job('ai', 'active', { createdOn: '2026-11-08T01:00:00Z' });
    await job('ai', 'created', { createdOn: '2026-11-08T01:00:00Z', startAfter: '2026-11-10T01:00:00Z' });
    await job('ai', 'failed', { completedOn: '2026-11-05T01:00:00Z' });
    await job('ai', 'failed', { completedOn: '2026-11-06T01:00:00Z' });
    await job('email', 'failed', { completedOn: '2026-11-06T01:00:00Z' });
    await job('email', 'failed', { completedOn: '2026-01-06T01:00:00Z' });
    await job('email', 'completed', { completedOn: '2026-11-06T01:00:00Z' });
    const body = await system();
    assert.equal(body.data.jobs.waitingOver15m, 2);
    assert.deepEqual(body.data.jobs.failedByQueue, { ai: 2, email: 1 });
  });

  test('no job table gives zeros', async () => {
    const body = await system();
    assert.deepEqual(body.data.jobs, { failedByQueue: {}, waitingOver15m: 0 });
  });

  test('credential cases count only, no text in body; key not installed', async () => {
    const pm = await seedUser(t.pool, 'pm@example.org');
    const p = await seedProject(t.pool, { status: 'active', name: 'Secret project NAME-XYZ', members: [{ userId: pm, role: 'pm' }] });
    for (const [state, closed] of [['held', false], ['cleaned', false], ['released', true]] as const) {
      await t.pool.query(
        `INSERT INTO quarantine_cases (id, project_id, item_kind, item_id, reporter_id, reason, marked_length, state, reported_at, closed_at, closed_by, close_reason)
         VALUES ($1, $2, 'task', $3, $4, 'REASON-TEXT-ABC', 12, $5, now(), $6, $7, $8)`,
        [uuidv7(), p, uuidv7(), pm, state, closed ? new Date() : null, closed ? pm : null, closed ? 'done' : null],
      );
    }
    const r = await admin.request('GET', '/admin/analytics?panel=system');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.security, { casesAwaitingReview: 2, protectedKeyInstalled: false });
    assert.doesNotMatch(JSON.stringify(r.body), /REASON-TEXT-ABC|NAME-XYZ/);
    assert.equal(r.body.data.links.security, '#/security/cases');
  });

  test('AI: active projects blocked by reason, and rejected keys; filters are ignored', async () => {
    const pm = await seedUser(t.pool, 'pm@example.org');
    const p1 = await seedProject(t.pool, { status: 'active', name: 'One', members: [{ userId: pm, role: 'pm' }] });
    await seedProject(t.pool, { status: 'active', name: 'Two', members: [{ userId: pm, role: 'pm' }] });
    await seedProject(t.pool, { status: 'planned', name: 'Three', members: [{ userId: pm, role: 'pm' }] });
    const model = (await seedAiModel(t.pool)).id;
    await t.pool.query(
      `INSERT INTO ai_connections (id, project_id, model_ref, label, position, state, rejected_at, rejected_status, created_at)
       VALUES ($1, $2, $3, 'Main', 1, 'key_rejected', now(), 401, now())`,
      [uuidv7(), p1, model],
    );
    const body = await system('&status=closed');
    assert.deepEqual(body.data.ai, { blockedByReason: { protected_key_missing: 2 }, keyRejected: 1 });
    assert.equal(body.data.links.ai, '#/ai');
  });
});
