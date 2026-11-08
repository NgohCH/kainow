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

describe('editing proposals', { skip: SKIP_NO_DB }, () => {
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
  const edit = (key: string, body: object, rId = runId) => api('POST', `/extractions/${rId}/items/${item[key]}/edit`, { sourceVersionId: versionId, ...body });
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

  const get = async (key: string) => (await api('GET', `/extractions/${runId}`)).body.items.find((i: { id: string }) => i.id === item[key]);

  test('needs a signed-in person', async () => {
    const r = await api('POST', `/extractions/${runId}/items/${item.ok}/edit`, { sourceVersionId: versionId, text: 'x' }, false);
    assert.equal(r.status, 401);
  });

  test('an edit shows the new wording and keeps the model\'s original beside it', async () => {
    const r = await edit('ok', { text: '  Ship on Friday 14th  ', owner: 'Ali', due: '2026-11-14' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.text, 'Ship on Friday 14th');
    assert.equal(r.body.item.owner, 'Ali');
    assert.equal(r.body.item.due, '2026-11-14');
    assert.deepEqual(r.body.item.original, { text: 'We agreed to ship on Friday.', owner: null, due: null });
    assert.equal(r.body.item.edited, true);
    const untouched = await get('repeated');
    assert.equal(untouched.edited, false);
    assert.equal(untouched.original, undefined);
    // the model's own row is not changed
    assert.equal((await pool.query('SELECT text FROM extraction_items WHERE id = $1', [item.ok])).rows[0].text, 'We agreed to ship on Friday.');
  });

  test('the latest edit is the wording in force, and every edit is kept', async () => {
    await edit('ok', { text: 'First' });
    clock.advanceSeconds(1);
    await edit('ok', { text: 'Second', owner: 'Sam' });
    const it = await get('ok');
    assert.equal(it.text, 'Second');
    assert.equal(it.owner, 'Sam');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM extraction_item_edits')).rows[0].n, 2);
  });

  test('a blank owner or due clears it, and the quote and its place never change', async () => {
    await edit('ok', { text: 'A', owner: 'Ali', due: 'Fri' });
    clock.advanceSeconds(1);
    const r = await edit('ok', { text: 'A', owner: '  ', due: null });
    assert.equal(r.body.item.owner, null);
    assert.equal(r.body.item.due, null);
    assert.equal(r.body.item.quote, 'We agreed to ship on Friday.');
    assert.equal(r.body.item.quoteStart, 0);
  });

  test('editing sends a decided proposal back to review and is audited without the text', async () => {
    await review('ok', { decision: 'approved' });
    clock.advanceSeconds(1);
    const r = await edit('ok', { text: 'Ship on Monday' });
    assert.equal(r.body.item.reviewStatus, 'pending');
    assert.equal(r.body.item.reviewedBy, null);
    const { rows } = await pool.query("SELECT detail FROM audit_events WHERE action = 'proposal.edited'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail.previousStatus, 'approved');
    assert.deepEqual(rows[0].detail.changed, ['text']);
    assert.ok(!JSON.stringify(rows[0].detail).includes('Monday'));
  });

  test('a repeated-quote approval loses its chosen place when the proposal is edited', async () => {
    await review('repeated', { decision: 'approved', occurrence: 1 });
    clock.advanceSeconds(1);
    const r = await edit('repeated', { text: 'Reworded' });
    assert.equal(r.body.item.reviewStatus, 'pending');
    assert.equal(r.body.item.chosenOccurrence, null);
  });

  test('an edit that changes nothing is refused', async () => {
    assert.equal((await edit('ok', { text: 'We agreed to ship on Friday.' })).status, 409);
    await edit('ok', { text: 'Changed' });
    assert.equal((await edit('ok', { text: 'Changed' })).status, 409);
  });

  test('the wording must be valid', async () => {
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 5 }, { text: 'x'.repeat(2001) }, { text: 'x', owner: 3 }, { text: 'x', owner: 'y'.repeat(201) }, { text: 'x', due: {} }]) {
      assert.equal((await edit('ok', body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM extraction_item_edits')).rows[0].n, 0);
  });

  test('the edit must name the version being reviewed, and the run must be finished', async () => {
    const other = (await api('POST', `/projects/${projectId}/notes`, { title: 'Other', text: 'Different notes' })).body.version.id;
    assert.equal((await api('POST', `/extractions/${runId}/items/${item.ok}/edit`, { text: 'x', sourceVersionId: other })).status, 409);
    assert.equal((await api('POST', `/extractions/${runId}/items/${item.ok}/edit`, { text: 'x' })).status, 400);
    await pool.query("UPDATE extraction_runs SET status = 'running'");
    assert.equal((await edit('ok', { text: 'x' })).status, 409);
    await pool.query("UPDATE extraction_runs SET status = 'succeeded'");
    assert.equal((await edit('ok', { text: 'x' }, '0197c3a0-0000-7000-8000-000000000000')).status, 404);
  });

  test('the database never lets an edit be changed or removed', async () => {
    await edit('ok', { text: 'Changed' });
    await assert.rejects(pool.query("UPDATE extraction_item_edits SET text = 'x'"), /append-only/);
    await assert.rejects(pool.query('DELETE FROM extraction_item_edits'), /append-only/);
    await assert.rejects(pool.query('TRUNCATE extraction_item_edits'), /append-only/);
  });
});
