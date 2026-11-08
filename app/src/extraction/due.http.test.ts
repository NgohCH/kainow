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
import { CaptureSender, FakeClock, testEnv } from '../testing/fakes';
import { UsersService } from '../users/users.service';

const EMAIL = 'admin@example.org';
const TEXT = 'We agreed to ship on Friday.\nok. ok.\nRisk: vendor late.';
const NEEDS_DATE = 'This action needs a due date, a date range or the event it waits on before it can be approved.';

describe('due readings, meeting dates and the approval rule', { skip: SKIP_NO_DB }, () => {
  let app: INestApplication;
  let pool: Pool;
  let base: string;
  let cookie: string;
  let csrf: string;
  let runId: string;
  let sourceId: string;
  let versionId: string;
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
  const view = async () => (await api('GET', `/extractions/${runId}`)).body;
  const get = async (key: string) => (await view()).items.find((i: { id: string }) => i.id === item[key]);
  const setMeeting = (meetingDate: unknown, signedIn = true) => api('POST', `/notes/${sourceId}/versions/1/meeting-date`, { meetingDate }, signedIn);
  const approve = (key: string) => api('POST', `/extractions/${runId}/items/${item[key]}/review`, { sourceVersionId: versionId, decision: 'approved' });
  const reject = (key: string) => api('POST', `/extractions/${runId}/items/${item[key]}/review`, { sourceVersionId: versionId, decision: 'rejected' });
  const edit = (key: string, body: object) => api('POST', `/extractions/${runId}/items/${item[key]}/edit`, { sourceVersionId: versionId, ...body });

  beforeEach(async () => {
    const sender = new CaptureSender();
    const clock = new FakeClock(Date.UTC(2026, 10, 9, 2, 0, 0));
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

    const created = (await api('POST', '/notes', { title: 'T', text: TEXT })).body;
    sourceId = created.source.id;
    versionId = created.version.id;
    const userId = (await pool.query('SELECT id FROM users')).rows[0].id;
    runId = uuidv7();
    await pool.query(`INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at)
                      VALUES ($1,$2,$3,'succeeded',6,0,now(),now())`, [runId, versionId, userId]);
    // [key, kind, due, due_event, alternatives]; every quote is found once.
    const rows: Array<[string, string, string | null, string | null, string[] | null]> = [
      ['soon', 'action', 'Immediate', null, null],
      ['dated', 'action', '5 November 2026', null, null],
      ['friday', 'action', 'Friday', null, null],
      ['decision', 'decision', null, null, null],
      ['question', 'question', null, null, ['Ship', 'Wait']],
      ['evented', 'action', null, 'after the Dean approves', null],
    ];
    for (const [i, [key, kind, due, dueEvent, alternatives]] of rows.entries()) {
      item[key] = uuidv7();
      if (dueEvent === null && alternatives === null) {
        // Written the way runs from before migration 0010 were.
        await pool.query(`INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, due, quote, quote_start, quote_end, quote_matches, created_at)
                          VALUES ($1,$2,$3,$4,$5,'T',$6,'We agreed to ship on Friday.',0,28,1,now())`, [item[key], runId, versionId, i, kind, due]);
      } else {
        await pool.query(`INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, due, due_event, alternatives, quote, quote_start, quote_end, quote_matches, created_at)
                          VALUES ($1,$2,$3,$4,$5,'T',$6,$7,$8,'We agreed to ship on Friday.',0,28,1,now())`, [item[key], runId, versionId, i, kind, due, dueEvent, alternatives ?? []]);
      }
    }
  });
  afterEach(async () => {
    await app?.close();
    await pool?.end();
  });

  test('setting the meeting date changes the readings', async () => {
    let v = await view();
    assert.equal(v.run.meetingDateSource, 'none');
    assert.equal(v.run.meetingDate, null);
    assert.equal((await get('soon')).dueReading.state, 'needs_date');

    const r = await setMeeting('2026-11-04');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { meetingDate: '2026-11-04' });

    v = await view();
    assert.equal(v.run.meetingDateSource, 'reviewer');
    assert.equal(v.run.meetingDate, '2026-11-04');
    const soon = await get('soon');
    assert.deepEqual(
      { state: soon.dueReading.state, earliest: soon.dueReading.earliest, latest: soon.dueReading.latest, used: soon.dueReading.usedMeetingDate },
      { state: 'range', earliest: '2026-11-04', latest: '2026-11-07', used: true },
    );
    assert.equal(soon.due, 'Immediate', 'the wording is unchanged');
    assert.equal((await get('dated')).dueReading.state, 'exact');
  });

  test("the reviewer's meeting date wins over the model's and the latest one counts", async () => {
    await pool.query(`UPDATE extraction_runs SET meeting_date = '2026-11-01' WHERE id = $1`, [runId]);
    let v = await view();
    assert.equal(v.run.meetingDateSource, 'notes');
    assert.equal(v.run.meetingDate, '2026-11-01');
    await setMeeting('2026-11-04');
    await setMeeting('2026-11-05');
    v = await view();
    assert.equal(v.run.meetingDateSource, 'reviewer');
    assert.equal(v.run.meetingDate, '2026-11-05');
  });

  test('a meeting date that is not a calendar day is refused', async () => {
    for (const bad of ['2026-02-30', '4 Nov', '', 20261104]) {
      const r = await setMeeting(bad);
      assert.equal(r.status, 400, String(bad));
      assert.equal(r.body.message, 'meetingDate must be a date in the form YYYY-MM-DD');
    }
  });

  test('setting a meeting date needs a signed-in person and is audited', async () => {
    assert.equal((await setMeeting('2026-11-04', false)).status, 401);
    await setMeeting('2026-11-04');
    const { rows } = await pool.query(`SELECT detail FROM audit_events WHERE action = 'note.meeting_date_set'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail.meetingDate, '2026-11-04');
  });

  test('an action that needs a date cannot be approved, but can be rejected', async () => {
    const r = await approve('friday');
    assert.equal(r.status, 409);
    assert.equal(r.body.message, NEEDS_DATE);
    assert.equal((await reject('friday')).status, 200);
  });

  test('an action with a date, a range or an event can be approved, and other kinds never need a date', async () => {
    await setMeeting('2026-11-04');
    for (const key of ['soon', 'dated', 'evented', 'decision', 'question']) {
      assert.equal((await approve(key)).status, 200, key);
    }
  });

  test('runs from before this change still load', async () => {
    const dated = await get('dated');
    assert.deepEqual(dated.alternatives, []);
    assert.equal(dated.dueEvent, null);
    assert.equal(dated.reviewerDue, null);
    assert.equal(dated.dueReading.state, 'exact');
    assert.equal(dated.dueReading.earliest, '2026-11-05');
    assert.deepEqual((await get('question')).alternatives, ['Ship', 'Wait']);
    const evented = await get('evented');
    assert.equal(evented.dueEvent, 'after the Dean approves');
    assert.equal(evented.dueReading.event, 'after the Dean approves');
  });

  test("a reviewer's due replaces the reading and is kept in history", async () => {
    const r = await edit('friday', { text: 'T', due: 'Friday', dueEarliest: '2026-11-10', dueLatest: '2026-11-12' });
    assert.equal(r.status, 200);
    const it = await get('friday');
    assert.deepEqual(it.reviewerDue, { earliest: '2026-11-10', latest: '2026-11-12', event: null });
    assert.equal(it.dueReading.state, 'range');
    assert.equal(it.dueReading.latest, '2026-11-12');
    assert.equal(it.due, 'Friday');
    assert.equal(it.original.due, 'Friday');
    assert.equal((await approve('friday')).status, 200);
  });

  test('a blank latest date means the same day, and an event can be given instead', async () => {
    await edit('friday', { text: 'T', due: 'Friday', dueEarliest: '2026-11-10', dueLatest: '' });
    assert.deepEqual((await get('friday')).reviewerDue, { earliest: '2026-11-10', latest: '2026-11-10', event: null });
    await edit('friday', { text: 'T', due: 'Friday', dueEvent: 'Senate approval' });
    const it = await get('friday');
    assert.deepEqual(it.reviewerDue, { earliest: null, latest: null, event: 'Senate approval' });
    assert.equal(it.dueReading.state, 'event');
  });

  test('editing the wording with the same due keeps the dates', async () => {
    await edit('friday', { text: 'T', due: 'Friday', dueEarliest: '2026-11-10', dueLatest: '2026-11-12' });
    await edit('friday', { text: 'Ship it', due: 'Friday', dueEarliest: '2026-11-10', dueLatest: '2026-11-12' });
    const it = await get('friday');
    assert.equal(it.text, 'Ship it');
    assert.equal(it.dueReading.earliest, '2026-11-10');
    assert.equal(it.dueReading.latest, '2026-11-12');
  });

  test('bad reviewer dues are refused with a reason', async () => {
    const cases: Array<[object, string]> = [
      [{ dueEarliest: '2026-11-10', dueEvent: 'approval' }, 'Give dates or an event, not both'],
      [{ dueEarliest: '2026-11-12', dueLatest: '2026-11-10' }, 'The latest date cannot be before the earliest date'],
      [{ dueLatest: '2026-11-10' }, 'Give the earliest date first'],
      [{ dueEarliest: '10 Nov 2026' }, 'Dates must be in the form YYYY-MM-DD'],
      [{ dueEarliest: '2026-02-30' }, 'Dates must be in the form YYYY-MM-DD'],
    ];
    for (const [fields, message] of cases) {
      const r = await edit('friday', { text: 'T', due: 'Friday', ...fields });
      assert.equal(r.status, 400, JSON.stringify(fields));
      assert.equal(r.body.message, message, JSON.stringify(fields));
    }
  });

  test('an approval that waited for an edit uses the due the edit left', async () => {
    await edit('friday', { text: 'T', due: 'Friday', dueEarliest: '2026-11-10', dueLatest: '2026-11-12' });
    const client = await pool.connect();
    try {
      // Another reviewer's edit, holding the item's lock, clears the dates.
      await client.query('BEGIN');
      await client.query('SELECT id FROM extraction_items WHERE id = $1 FOR UPDATE', [item.friday]);
      const userId = (await client.query('SELECT id FROM users')).rows[0].id;
      await client.query(
        `INSERT INTO extraction_item_edits (id, item_id, text, due, edited_by, edited_at) VALUES ($1, $2, 'T', 'Friday', $3, '2026-11-20T00:00:00Z')`,
        [uuidv7(), item.friday, userId],
      );
      const pending = approve('friday');
      await new Promise((r) => setTimeout(r, 400));
      await client.query('COMMIT');
      const r = await pending;
      assert.equal(r.status, 409);
      assert.equal(r.body.message, NEEDS_DATE);
    } finally {
      client.release();
    }
  });

  test('changing only the due counts as a change', async () => {
    const r = await edit('friday', { text: 'T', due: 'Friday', dueEarliest: '2026-11-10' });
    assert.equal(r.status, 200);
    const { rows } = await pool.query(`SELECT detail FROM audit_events WHERE action = 'proposal.edited'`);
    assert.deepEqual(rows[0].detail.changed, ['due_dates']);
  });
});
