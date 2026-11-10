import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { Sweep } from '../notifications/sweep';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

/** Milliseconds for HH:MM UTC+8 on a day of November 2026. */
const at = (day: number, h: number, m = 0): number => Date.UTC(2026, 10, day, h - 8, m);
const APP_URL = 'https://kainow.example.org';

describe('action-item digests over HTTP and the sweep', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pm: Client;
  let owner: Client;
  let sponsor: Client;
  let ann: Client;
  let outsider: Client;
  const ids: Record<string, string> = {};
  let projectId: string;
  let nudges = 0;

  beforeEach(async () => {
    t = await startTestApp(at(17, 10));
    for (const p of ['pm', 'owner', 'sponsor', 'ann', 'audit', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour Works',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision)
       VALUES ($1, $2, $3, 'audit', 'Review', 'Tasks', '2026-11-01', '2026-12-31', $4, now(), 'approved')`,
      [uuidv7(), projectId, ids.audit, ids.owner],
    );
    pm = await t.signIn('pm@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    ann = await t.signIn('ann@example.org');
    outsider = await t.signIn('outsider@example.org');
    nudges = 0;
  });
  afterEach(async () => {
    await t?.close();
  });

  const task = (title = 'Write the report', assignee = ids.ann, dueOn = '2026-11-20', status = 'not_started', project = projectId) =>
    t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $4, '2026-11-01T00:00:00Z')`,
      [uuidv7(), project, title, assignee, dueOn, status],
    );
  const outbox = async () => (await t.pool.query(`SELECT * FROM email_outbox WHERE kind = 'digest' ORDER BY to_address`)).rows;
  const sweep = () =>
    new Sweep({ pool: t.pool, clock: t.clock.now, appUrl: APP_URL, nudge: { nudge: async () => { nudges += 1; } }, log: { warn: () => undefined } });
  const schedule = async (frequency: 'daily' | 'weekly', time = '09:00', weekday: number | null = null) => {
    await t.pool.query(`UPDATE notification_settings SET projects_may_change_digest = true`);
    await t.pool.query(
      `INSERT INTO project_notification_settings (project_id, digest_enabled, digest_frequency, digest_weekday, digest_time) VALUES ($1, true, $2, $3, $4)
       ON CONFLICT (project_id) DO UPDATE SET digest_enabled = true, digest_frequency = $2, digest_weekday = $3, digest_time = $4`,
      [projectId, frequency, weekday, time],
    );
  };
  const digestKeys = async () => (await t.pool.query(`SELECT key, outcome, detail FROM notification_triggers WHERE kind = 'digest' ORDER BY key`)).rows;

  test('preview shows the caller their own copy and writes nothing', async () => {
    await task('Pat task', ids.pm);
    await task('Ann task', ids.ann);
    const r = await pm.request('GET', `/projects/${projectId}/digest/preview`);
    assert.equal(r.status, 200);
    assert.equal(r.body.recipients, 4);
    assert.equal(r.body.subject, 'Action items: Harbour Works');
    assert.equal(r.body.asAt, new Date(t.clock.ms).toISOString());
    assert.match(r.body.body, /As at Tue 17 Nov 2026, 10:0\d \(UTC\+8\)/);
    assert.match(r.body.body, /Your open tasks\n- Pat task/);
    assert.equal((await t.pool.query(`SELECT 1 FROM digest_runs`)).rowCount, 0);
    assert.equal((await outbox()).length, 0);
  });

  test('sending queues one email per recipient and one run, excluding grant holders and people away', async () => {
    await task();
    await t.pool.query(`INSERT INTO away_periods (id, user_id, starts_on, ends_on, created_at) VALUES ($1, $2, '2026-11-17', '2026-11-17', now())`, [uuidv7(), ids.sponsor]);
    await t.pool.query(`INSERT INTO email_preferences (user_id, project_id, choice, updated_at) VALUES ($1, $2, 'off', now())`, [ids.ann, projectId]);
    const r = await owner.request('POST', `/projects/${projectId}/digest`);
    assert.equal(r.status, 201);
    assert.equal(r.body.recipients, 3);
    const run = (await t.pool.query(`SELECT * FROM digest_runs`)).rows;
    assert.equal(run.length, 1);
    assert.deepEqual([run[0].id, run[0].scheduled, run[0].initiated_by_user, run[0].recipient_count], [r.body.digestRunId, false, ids.owner, 3]);
    const rows = await outbox();
    assert.deepEqual(rows.map((x) => x.to_address), ['ann@example.org', 'owner@example.org', 'pm@example.org']);
    for (const row of rows) {
      assert.deepEqual([row.digest_run_id, row.initiated_by, row.subject, row.status], [r.body.digestRunId, 'digest', 'Action items: Harbour Works', 'queued']);
      assert.deepEqual(row.relevance, { kind: 'project_active', projectId, scope: 'project' });
    }
    assert.match(rows[0].text_body, /Your open tasks\n- Write the report/);
    assert.equal((await t.pool.query(`SELECT 1 FROM notifications`)).rowCount, 0, 'digests create no in-app notices');
  });

  test('a Member gets 403, a stranger 404, an Audit holder 403', async () => {
    await task();
    const refusal = 'Only the Project Manager, Owner or a Sponsor can send action-item emails, and only while the project is Active.';
    const m = await ann.request('POST', `/projects/${projectId}/digest`);
    assert.deepEqual([m.status, m.body.message], [403, refusal]);
    assert.equal((await ann.request('GET', `/projects/${projectId}/digest/preview`)).status, 403);
    assert.equal((await outsider.request('POST', `/projects/${projectId}/digest`)).status, 404);
    const audit = await t.signIn('audit@example.org');
    assert.equal((await audit.request('POST', `/projects/${projectId}/digest`)).status, 403);
    assert.equal((await t.pool.query(`SELECT 1 FROM digest_runs`)).rowCount, 0);
  });

  test('a Deferred project refuses with 403', async () => {
    await task();
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    assert.equal((await pm.request('POST', `/projects/${projectId}/digest`)).status, 403);
    assert.equal((await pm.request('GET', `/projects/${projectId}/digest/preview`)).status, 403);
  });

  test('a project with no open tasks gets 409 for both', async () => {
    await task('Done', ids.ann, '2026-11-20', 'completed');
    for (const r of [await pm.request('POST', `/projects/${projectId}/digest`), await pm.request('GET', `/projects/${projectId}/digest/preview`)]) {
      assert.deepEqual([r.status, r.body.message], [409, 'Nothing to send: no open tasks']);
    }
    assert.equal((await t.pool.query(`SELECT 1 FROM digest_runs`)).rowCount, 0);
  });

  test('scheduled daily digest goes once at the chosen time and skips Saturday', async () => {
    await task();
    await schedule('daily');
    t.clock.ms = at(20, 8, 59); // Friday
    await sweep().run();
    assert.equal((await outbox()).length, 0);
    t.clock.ms = at(20, 9, 1);
    await sweep().run();
    await sweep().run();
    const rows = await outbox();
    assert.equal(rows.length, 4);
    assert.ok(nudges >= 1);
    const run = (await t.pool.query(`SELECT scheduled, initiated_by_user, recipient_count, as_at FROM digest_runs`)).rows;
    assert.deepEqual(run.map((x) => [x.scheduled, x.initiated_by_user, x.recipient_count]), [[true, null, 4]]);
    assert.equal(rows.every((x) => x.initiated_by === 'digest' && x.initiated_by_user === null), true);
    assert.deepEqual((await digestKeys()).map((k) => [k.key, k.outcome]), [[`project:${projectId}:digest:2026-11-20`, 'sent']]);
    assert.equal((await t.pool.query(`SELECT 1 FROM notifications WHERE kind = 'digest'`)).rowCount, 0);
    t.clock.ms = at(21, 10); // Saturday
    await sweep().run();
    assert.equal((await outbox()).length, 4);
    t.clock.ms = at(23, 10); // Monday
    await sweep().run();
    assert.equal((await outbox()).length, 8);
  });

  test('scheduled weekly digest on a holiday goes the working day before', async () => {
    await task();
    await schedule('weekly', '09:00', 5);
    await t.pool.query(`INSERT INTO holidays (id, on_date, name, added_by, added_at) VALUES ($1, '2026-11-20', 'Founders Day', $2, now())`, [uuidv7(), ids.pm]);
    t.clock.ms = at(19, 10);
    await sweep().run();
    assert.equal((await outbox()).length, 4);
    assert.equal((await digestKeys())[0].key, `project:${projectId}:digest:2026-11-19`);
    t.clock.ms = at(20, 10);
    await sweep().run();
    assert.equal((await outbox()).length, 4);
  });

  test('a scheduled digest with no open tasks is recorded as skipped and sends nothing', async () => {
    await schedule('daily');
    t.clock.ms = at(20, 10);
    await sweep().run();
    await sweep().run();
    assert.equal((await outbox()).length, 0);
    assert.equal((await t.pool.query(`SELECT 1 FROM digest_runs`)).rowCount, 0);
    const keys = await digestKeys();
    assert.deepEqual(keys.map((k) => [k.outcome, k.detail]), [['skipped_obsolete', { reason: 'no open tasks' }]]);
  });

  test('a Deferred project gets no scheduled digest and nothing is caught up after resume', async () => {
    await task();
    await schedule('daily');
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [projectId]);
    t.clock.ms = at(20, 10);
    await sweep().run();
    assert.equal((await digestKeys()).length, 0);
    await t.pool.query(`UPDATE projects SET status = 'active' WHERE id = $1`, [projectId]);
    t.clock.ms = at(20, 12);
    await sweep().run();
    // Resumed on the due date after the time: today's digest goes, earlier dates never do.
    assert.deepEqual((await digestKeys()).map((k) => k.key), [`project:${projectId}:digest:2026-11-20`]);
  });

  test('without a schedule, or without the delegation, no digest is sent', async () => {
    await task();
    t.clock.ms = at(20, 10);
    await sweep().run();
    await t.pool.query(
      `INSERT INTO project_notification_settings (project_id, digest_enabled, digest_frequency, digest_time) VALUES ($1, true, 'daily', '09:00')`,
      [projectId],
    );
    await sweep().run();
    assert.equal((await digestKeys()).length, 0);
  });
});
