import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp } from '../bootstrap';
import { loadConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedWorkingProject } from '../testing/projects';
import { CaptureSender, FakeClock, testEnv } from '../testing/fakes';
import { UsersService } from '../users/users.service';

const EMAIL = 'admin@example.org';
const TEXT = 'We agreed to ship on Friday.\nok. ok.\nRisk: vendor late.';

describe('reviewing proposals', { skip: SKIP_NO_DB }, () => {
  let projectId: string;
  let app: INestApplication;
  let pool: Pool;
  let base: string;
  let cookie: string;
  let csrf: string;
  let runId: string;
  let versionId: string;
  let clock: FakeClock;
  const item: Record<string, string> = {};

  async function api(method: string, path: string, body?: unknown, signedIn = true): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(signedIn ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }
  const review = (key: string, body: object, rId = runId) => api('POST', `/extractions/${rId}/items/${item[key]}/review`, { sourceVersionId: versionId, ...body });

  beforeEach(async () => {
    const sender = new CaptureSender();
    clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
    const config = loadConfig(testEnv(testDatabaseUrl() as string));
    pool = new Pool({ connectionString: config.databaseUrl });
    await resetPublicSchema(pool);
    await runMigrations(pool, config.migrationsDir);
    await new UsersService(pool, clock.now).create({ email: EMAIL, displayName: 'Admin' });
    app = await createApp(config, { codeSender: sender, clock: clock.now, logger: false, extractionQueue: { enqueue: async () => undefined } });
    await app.listen(0);
    base = await app.getUrl();
    await fetch(`${base}/auth/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
    const verify = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: sender.lastCode(EMAIL) }) });
    cookie = (verify.headers.getSetCookie()[0] ?? '').split(';')[0];
    csrf = ((await verify.json()) as { csrfToken: string }).csrfToken;
    projectId = await seedWorkingProject(pool, (await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])).rows[0].id);

    const created = (await api('POST', `/projects/${projectId}/notes`, { title: 'T', text: TEXT })).body;
    versionId = created.version.id;
    const userId = (await pool.query('SELECT id FROM users')).rows[0].id;
    runId = uuidv7();
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at)
                      VALUES ($1,$2,$3,'succeeded',3,1,now(),now())`, [runId, versionId, userId]);
    const rows: Array<[string, string, string, number | null, number | null, number]> = [
      ['ok', 'We agreed to ship on Friday.', 'We agreed to ship on Friday.', 0, 28, 1],
      ['repeated', 'ok.', 'ok.', 29, 32, 2],
      ['invented', 'Not in the notes', 'Not in the notes', null, null, 0],
    ];
    for (const [i, [key, text, quote, s, e, m]] of rows.entries()) {
      item[key] = uuidv7();
      await pool.query(`INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at)
                        VALUES ($1,$2,$3,$4,'decision',$5,$6,$7,$8,$9,now())`, [item[key], runId, versionId, i, text, quote, s, e, m]);
    }
  });
  afterEach(async () => {
    await app?.close();
    await pool?.end();
  });

  test('needs a signed-in person', async () => {
    const r = await api('POST', `/extractions/${runId}/items/${item.ok}/review`, { decision: 'approved', sourceVersionId: versionId }, false);
    assert.equal(r.status, 401);
  });

  test('approving records who and when, and is audited', async () => {
    const r = await review('ok', { decision: 'approved' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.reviewStatus, 'approved');
    assert.ok(r.body.item.reviewedBy && r.body.item.reviewedAt);
    const { rows } = await pool.query("SELECT action, detail FROM audit_events WHERE action LIKE 'proposal.%'");
    assert.deepEqual(rows.map((x) => x.action), ['proposal.approved']);
    assert.equal(rows[0].detail.previousStatus, 'pending');
    assert.equal(rows[0].detail.sourceVersionId, versionId);
  });

  test('a decision can be changed, and the audit trail keeps both', async () => {
    await review('ok', { decision: 'approved' });
    clock.advanceSeconds(1); // two events at the same instant would have no defined order
    assert.equal((await review('ok', { decision: 'rejected' })).body.item.reviewStatus, 'rejected');
    const { rows } = await pool.query("SELECT action, detail FROM audit_events WHERE action LIKE 'proposal.%' ORDER BY occurred_at, id");
    assert.deepEqual(rows.map((x) => [x.action, x.detail.previousStatus]), [['proposal.approved', 'pending'], ['proposal.rejected', 'approved']]);
  });

  test('a decision is refused if it names a different version than the proposal belongs to', async () => {
    const other = (await api('POST', `/projects/${projectId}/notes`, { title: 'Other', text: 'Different notes' })).body.version.id;
    const r = await api('POST', `/extractions/${runId}/items/${item.ok}/review`, { decision: 'approved', sourceVersionId: other });
    assert.equal(r.status, 409);
    assert.match(JSON.stringify(r.body), /different version/);
    assert.equal((await pool.query("SELECT review_status FROM extraction_items WHERE id = $1", [item.ok])).rows[0].review_status, 'pending');
  });

  test('the version being reviewed must be stated, and the decision must be valid', async () => {
    assert.equal((await api('POST', `/extractions/${runId}/items/${item.ok}/review`, { decision: 'approved' })).status, 400);
    assert.equal((await review('ok', { decision: 'maybe' })).status, 400);
    assert.equal((await review('ok', { decision: 'pending' })).status, 400);
    assert.equal((await api('POST', `/extractions/${runId}/items/${item.ok}/review`, {})).status, 400);
  });

  test('a quote that is not in the notes can be rejected but never approved', async () => {
    assert.equal((await review('invented', { decision: 'approved' })).status, 409);
    assert.equal((await review('invented', { decision: 'approved', occurrence: 0 })).status, 409);
    assert.equal((await review('invented', { decision: 'rejected' })).status, 200);
  });

  test('a quote that appears more than once needs the reviewer to choose which place is meant', async () => {
    assert.equal((await review('repeated', { decision: 'approved' })).status, 409);
    for (const bad of ['1', true, -1, 2, 1.5, null]) {
      assert.equal((await review('repeated', { decision: 'approved', occurrence: bad })).status, 400, `occurrence ${String(bad)}`);
    }
    assert.equal((await pool.query('SELECT review_status FROM extraction_items WHERE id = $1', [item.repeated])).rows[0].review_status, 'pending');
    const r = await review('repeated', { decision: 'approved', occurrence: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.chosenOccurrence, 1);
    const { rows } = await pool.query("SELECT detail FROM audit_events WHERE action = 'proposal.approved'");
    assert.equal(rows[0].detail.occurrence, 1);
  });

  test('every place a repeated quote occurs is listed, so the reviewer can choose', async () => {
    const run = (await api('GET', `/extractions/${runId}`)).body;
    const by = (key: string) => run.items.find((i: { id: string }) => i.id === item[key]);
    assert.deepEqual(by('repeated').occurrences, [{ start: 29, end: 32 }, { start: 33, end: 36 }]);
    assert.equal(by('ok').occurrences, undefined);
    assert.equal(by('repeated').chosenOccurrence, null);
  });

  test('a quote that appears once needs no choice, and a choice other than the only place is refused', async () => {
    const r = await review('ok', { decision: 'approved' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.chosenOccurrence, null);
    assert.equal((await review('ok', { decision: 'approved', occurrence: 1 })).status, 400);
    assert.equal((await review('ok', { decision: 'approved', occurrence: 0 })).status, 200);
  });

  test('changing a repeated quote to rejected forgets the chosen place; approving again needs a new choice', async () => {
    await review('repeated', { decision: 'approved', occurrence: 0 });
    clock.advanceSeconds(1);
    const rejected = await review('repeated', { decision: 'rejected', occurrence: 1 });
    assert.equal(rejected.body.item.reviewStatus, 'rejected');
    assert.equal(rejected.body.item.chosenOccurrence, null);
    assert.equal((await review('repeated', { decision: 'approved' })).status, 409);
  });

  test('the database allows a chosen place only on an approved proposal whose quote repeats', async () => {
    const set = (id: string, status: string, chosen: number | null) =>
      pool.query(
        `UPDATE extraction_items SET review_status = $2, chosen_occurrence = $3,
                reviewed_by = CASE WHEN $2 = 'pending' THEN NULL ELSE (SELECT id FROM users LIMIT 1) END,
                reviewed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END WHERE id = $1`,
        [id, status, chosen],
      );
    await assert.rejects(set(item.repeated, 'approved', null), /chosen_occurrence/);
    await assert.rejects(set(item.repeated, 'approved', 2), /chosen_occurrence/);
    await assert.rejects(set(item.repeated, 'rejected', 0), /chosen_occurrence/);
    await assert.rejects(set(item.ok, 'approved', 0), /chosen_occurrence/);
    await set(item.repeated, 'approved', 1);
  });

  test('a proposal from an unfinished run cannot be reviewed, and ids must match', async () => {
    await pool.query("UPDATE extraction_runs SET status = 'running'");
    assert.equal((await review('ok', { decision: 'approved' })).status, 409);
    await pool.query("UPDATE extraction_runs SET status = 'succeeded'");
    assert.equal((await review('ok', { decision: 'approved' }, '0197c3a0-0000-7000-8000-000000000000')).status, 404);
    assert.equal((await api('POST', `/extractions/${runId}/items/nope/review`, { decision: 'approved', sourceVersionId: versionId })).status, 404);
  });

  test('the content of a proposal cannot change, even by direct database access', async () => {
    await assert.rejects(pool.query("UPDATE extraction_items SET text = 'edited'"), /only the review decision/);
    await assert.rejects(pool.query("UPDATE extraction_items SET quote_start = 1 WHERE id = $1", [item.ok]), /only the review decision/);
    await assert.rejects(pool.query('DELETE FROM extraction_items'), /never deleted/);
    await assert.rejects(pool.query("UPDATE extraction_items SET review_status = 'approved' WHERE id = $1", [item.invented]), /violates check constraint/);
  });

  test('run details show each proposal and its review state', async () => {
    await review('ok', { decision: 'approved' });
    const view = (await api('GET', `/extractions/${runId}`)).body;
    assert.deepEqual(view.items.map((i: any) => i.reviewStatus), ['approved', 'pending', 'pending']);
    assert.equal(view.run.sourceVersionId, versionId);
    assert.deepEqual([view.source.title, view.source.versionNo], ['T', 1]);
  });
  test('the run says what the viewer may do, and why not', async () => {
    const perms = async () => (await api('GET', `/extractions/${runId}`)).body.permissions;
    assert.deepEqual(await perms(), { approve: true, reject: true, edit: true, note: null });

    await pool.query(`UPDATE memberships SET revoked_at = now() WHERE project_id = $1 AND role = 'member'`, [projectId]);
    assert.deepEqual(await perms(), {
      approve: false,
      reject: true,
      edit: true,
      note: 'The project is missing a required role, so proposals cannot be approved until it is repaired.',
    });

    await pool.query(`DELETE FROM memberships WHERE project_id = $1 AND role = 'owner'`, [projectId]);
    const reviewRefusal = 'Only the Owner or a Sponsor can approve or reject proposals, and only while the project is Planned or Active.';
    assert.deepEqual(await perms(), { approve: false, reject: false, edit: true, note: reviewRefusal });

    await pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.deepEqual(await perms(), { approve: false, reject: false, edit: false, note: reviewRefusal });
  });
});
