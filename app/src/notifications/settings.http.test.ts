import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { loadEffective, loadEffectiveMany, loadRiskSnaps, loadTaskSnaps } from './settings';

describe('notification settings, holidays and preview', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let ann: Client;
  const ids: Record<string, string> = {};
  let projectId: string;

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['owner', 'pm', 'ann']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    ann = await t.signIn('ann@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  const setOrg = (changes: Record<string, unknown>, reason: string | null = 'Because') => admin.request('PUT', '/notification-settings', { changes, reason });
  const setProj = (changes: Record<string, unknown>, c: Client = pm) => c.request('PUT', `/projects/${projectId}/notification-settings`, { changes, reason: 'Project need' });
  const allow = (group: 'Calendar' | 'Timings' | 'Digest', on = true) => setOrg({ [`projectsMayChange${group}`]: on });

  /** An open task due on a Friday, authorised well before any reminder falls. */
  const seedTask = async (dueOn = '2026-11-20', title = 'Write the report') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, $3, $4, $5, 'not_started', $6, '2026-11-01T00:00:00Z')`,
      [id, projectId, title, ids.ann, dueOn, ids.owner],
    );
    return id;
  };

  test('the Administrator reads defaults and changes lead days with a reason; history is written', async () => {
    const g = await admin.request('GET', '/notification-settings');
    assert.equal(g.status, 200);
    assert.deepEqual(
      [g.body.dayCounting, g.body.weekdays, g.body.leadDays, g.body.escalationDays, g.body.sweepMinutes, g.body.projectsMayChangeCalendar],
      ['working', [1, 2, 3, 4, 5], [7, 1], 3, 15, false],
    );
    const r = await setOrg({ leadDays: [1, 5, 14], weekdays: [5, 1, 3] }, 'Longer notice');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.leadDays, r.body.weekdays], [[14, 5, 1], [1, 3, 5]]);
    const h = r.body.history as { field: string; oldValue: string; newValue: string; reason: string; actor: string }[];
    assert.equal(h.length, 2);
    const lead = h.find((x) => x.field === 'lead_days');
    assert.deepEqual([lead?.oldValue, lead?.newValue, lead?.reason, lead?.actor], ['[7,1]', '[14,5,1]', 'Longer notice', 'admin']);
    assert.equal((await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'notification_settings.changed'`)).rowCount, 1);
    // An unchanged value writes nothing.
    await setOrg({ escalationDays: 3 });
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM notification_settings_changes`)).rows[0].n, 2);
    assert.equal((await setOrg({ escalationDays: 4 }, ' ')).status, 400);
    assert.equal((await setOrg({ escalationDays: 4 }, null)).status, 400);
    assert.equal((await setOrg({ bogus: 1 })).status, 400);
  });

  test('the organisation settings show noticesFrom (read-only; set only by golive-init)', async () => {
    assert.equal((await admin.request('GET', '/notification-settings')).body.noticesFrom, null);
    await t.pool.query(`UPDATE notification_settings SET notices_from = '2026-11-10T01:30:00Z'`);
    const g = await admin.request('GET', '/notification-settings');
    assert.equal(new Date(g.body.noticesFrom).getTime(), Date.UTC(2026, 10, 10, 1, 30));
    assert.equal((await setOrg({ noticesFrom: '2026-01-01T00:00:00Z' })).status, 400);
    assert.equal((await setOrg({ noticesFrom: null })).status, 400);
    assert.equal(
      (await t.pool.query(`SELECT notices_from FROM notification_settings`)).rows[0].notices_from.getTime(), Date.UTC(2026, 10, 10, 1, 30),
    );
    assert.equal((await setOrg({ escalationDays: 4 })).body.noticesFrom.slice(0, 16), '2026-11-10T01:30');
  });

  test('a member cannot read or change organisation settings', async () => {
    assert.equal((await pm.request('GET', '/notification-settings')).status, 403);
    assert.equal((await pm.request('PUT', '/notification-settings', { changes: { sweepMinutes: 10 }, reason: 'x' })).status, 403);
    assert.equal((await pm.request('POST', '/notification-settings/holidays', { date: '2026-12-25', name: 'Day', reason: 'Calendar' })).status, 403);
    assert.equal((await pm.request('POST', '/notification-settings/preview', { changes: { sweepMinutes: 10 } })).status, 403);
  });

  test('bounds are refused with the exact messages', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ leadDays: [0] }, 'Each reminder must be 1–30 days before the due date.'],
      [{ leadDays: [31, 1] }, 'Each reminder must be 1–30 days before the due date.'],
      [{ leadDays: [7, 5, 3, 1] }, 'At most 3 reminders, each on a different day.'],
      [{ leadDays: [7, 7] }, 'At most 3 reminders, each on a different day.'],
      [{ escalationDays: 0 }, 'The escalation delay must be 1–10 days.'],
      [{ escalationDays: 11 }, 'The escalation delay must be 1–10 days.'],
      [{ sweepMinutes: 4 }, 'The sweep interval must be 5–60 minutes.'],
      [{ sweepMinutes: 61 }, 'The sweep interval must be 5–60 minutes.'],
      [{ weekdays: [] }, 'Choose at least one working weekday.'],
      [{ weekdays: [0, 1] }, 'Choose at least one working weekday.'],
      [{ weekdays: [8] }, 'Choose at least one working weekday.'],
    ];
    for (const [changes, message] of cases) {
      const r = await setOrg(changes);
      assert.deepEqual([r.status, r.body.message], [400, message], JSON.stringify(changes));
    }
    assert.equal((await admin.request('GET', '/notification-settings')).body.history.length, 0);
  });

  test('projects change settings only while the switch is on; values are labelled project, null restores organisation', async () => {
    const off = await setProj({ leadDays: [5, 1] });
    assert.deepEqual([off.status, off.body.message], [403, 'The Administrator has not allowed projects to change this setting.']);
    assert.equal((await setProj({ leadDays: [5, 1] }, ann)).status, 403);
    const view0 = await pm.request('GET', `/projects/${projectId}/notification-settings`);
    assert.deepEqual(view0.body.canEdit, { calendar: false, timings: false, digest: false });
    assert.equal((await ann.request('GET', `/projects/${projectId}/notification-settings`)).status, 200);

    await allow('Timings');
    const ok = await setProj({ leadDays: [1, 5] });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.leadDays, ok.body.sources.leadDays, ok.body.sources.escalationDays], [[5, 1], 'project', 'organisation']);
    assert.deepEqual(ok.body.canEdit, { calendar: false, timings: true, digest: false });
    assert.equal(ok.body.history[0].field, 'lead_days');
    assert.equal(ok.body.history[0].actor, 'pm');
    // A calendar field is still refused while that group is off.
    assert.equal((await setProj({ weekdays: [1, 2, 3] })).status, 403);

    const bad = await setProj({ leadDays: [40] });
    assert.deepEqual([bad.status, bad.body.message], [400, 'Each reminder must be 1–30 days before the due date.']);

    t.clock.advanceSeconds(60);
    const cleared = await setProj({ leadDays: null });
    assert.deepEqual([cleared.body.leadDays, cleared.body.sources.leadDays, cleared.body.own.leadDays], [[7, 1], 'organisation', null]);
  });

  test('switching a group off keeps the project value in force but read-only (spec §9.2, R28)', async () => {
    await allow('Timings');
    await allow('Calendar');
    await allow('Digest');
    await setProj({ escalationDays: 6, leadDays: [3, 1], weekdays: [1, 2, 3, 4], digestEnabled: true, digestFrequency: 'daily', digestTime: '08:30' });
    assert.equal((await pm.request('GET', `/projects/${projectId}/notification-settings`)).body.escalationDays, 6);
    // The organisation preview of switching the groups off: nothing moves for a project with its own values.
    await seedTask();
    const prev = await admin.request('POST', '/notification-settings/preview', { changes: { projectsMayChangeTimings: false, projectsMayChangeCalendar: false } });
    assert.equal(prev.status, 200);
    assert.deepEqual([prev.body.moved, prev.body.added, prev.body.removed], [[], [], []]);
    await allow('Timings', false);
    await allow('Calendar', false);
    await allow('Digest', false);
    const v = await pm.request('GET', `/projects/${projectId}/notification-settings`);
    assert.deepEqual(
      [v.body.escalationDays, v.body.sources.escalationDays, v.body.own.escalationDays, v.body.weekdays, v.body.sources.weekdays, v.body.leadDays],
      [6, 'project', 6, [1, 2, 3, 4], 'project', [3, 1]],
    );
    assert.deepEqual(v.body.canEdit, { calendar: false, timings: false, digest: false });
    assert.deepEqual(v.body.digest, { frequency: 'daily', weekday: null, time: '08:30' });
    assert.equal((await setProj({ escalationDays: 2 })).status, 403);
    // The sweep's loaders (one project and many) give the same values.
    const eff = await loadEffective(t.pool, projectId);
    assert.deepEqual([eff.timings.escalationDays, eff.timings.leadDays, eff.cal.weekdays], [6, [3, 1], [1, 2, 3, 4]]);
    assert.deepEqual(eff.digest, { frequency: 'daily', weekday: null, time: '08:30' });
    assert.deepEqual(eff.delegation, { calendar: false, timings: false, digest: false });
    const many = (await loadEffectiveMany(t.pool, [projectId])).get(projectId);
    assert.deepEqual([many?.timings.escalationDays, many?.cal.weekdays, many?.digest], [6, [1, 2, 3, 4], { frequency: 'daily', weekday: null, time: '08:30' }]);
  });

  test('the digest schedule is validated and gated by its own switch', async () => {
    const off = await setProj({ digestEnabled: true, digestFrequency: 'daily', digestTime: '08:30' });
    assert.deepEqual([off.status, off.body.message], [403, 'The Administrator has not allowed projects to change this setting.']);
    await allow('Digest');
    assert.equal((await setProj({ digestEnabled: true })).status, 400);
    assert.equal((await setProj({ digestEnabled: true, digestFrequency: 'weekly', digestTime: '08:30' })).status, 400);
    assert.equal((await setProj({ digestEnabled: true, digestFrequency: 'daily', digestTime: '25:00' })).status, 400);
    assert.equal((await pm.request('GET', `/projects/${projectId}/notification-settings`)).body.digest, null);

    const ok = await setProj({ digestEnabled: true, digestFrequency: 'weekly', digestWeekday: 2, digestTime: '08:30' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.digest, { frequency: 'weekly', weekday: 2, time: '08:30' });
    assert.deepEqual((await loadEffective(t.pool, projectId)).digest, { frequency: 'weekly', weekday: 2, time: '08:30' });
    t.clock.advanceSeconds(60);
    const off2 = await setProj({ digestEnabled: false });
    assert.equal(off2.body.digest, null);
  });

  test('holidays are added and removed with a record, never deleted, and duplicates are refused', async () => {
    const add = await admin.request('POST', '/notification-settings/holidays', { date: '2026-11-18', name: 'Founders Day', reason: 'Calendar' });
    assert.equal(add.status, 201);
    const id = add.body.holidays[0].id as string;
    const dupe = await admin.request('POST', '/notification-settings/holidays', { date: '2026-11-18', name: 'Again', reason: 'Calendar' });
    assert.equal(dupe.status, 409);
    assert.equal((await admin.request('POST', '/notification-settings/holidays', { date: '2026-02-30', name: 'x', reason: 'Calendar' })).status, 400);
    assert.equal((await admin.request('DELETE', `/notification-settings/holidays/${id}`, {})).status, 400);
    const del = await admin.request('DELETE', `/notification-settings/holidays/${id}`, { reason: 'Moved' });
    assert.equal(del.status, 200);
    assert.ok(del.body.holidays[0].removedAt);
    const row = (await t.pool.query(`SELECT removed_by, removed_at FROM holidays WHERE id = $1`, [id])).rows[0];
    assert.equal(row.removed_by, ids.admin);
    assert.ok(row.removed_at);
    // A removed date can be added again.
    assert.equal((await admin.request('POST', '/notification-settings/holidays', { date: '2026-11-18', name: 'Back', reason: 'Calendar' })).status, 201);
    assert.equal((await admin.request('DELETE', `/notification-settings/holidays/${id}`, { reason: 'Twice' })).status, 404);

    // Project holidays follow the calendar switch; the organisation's also apply.
    const refused = await pm.request('POST', `/projects/${projectId}/holidays`, { date: '2026-11-19', name: 'Local', reason: 'Calendar' });
    assert.deepEqual([refused.status, refused.body.message], [403, 'The Administrator has not allowed projects to change this setting.']);
    await allow('Calendar');
    const p = await pm.request('POST', `/projects/${projectId}/holidays`, { date: '2026-11-19', name: 'Local', reason: 'Calendar' });
    assert.equal(p.status, 201);
    assert.equal((await pm.request('POST', `/projects/${projectId}/holidays`, { date: '2026-11-19', name: 'Local', reason: 'Calendar' })).status, 409);
    assert.deepEqual([...(await loadEffective(t.pool, projectId)).cal.holidays].sort(), ['2026-11-18', '2026-11-19']);
    const ownId = p.body.holidays[0].id as string;
    assert.equal((await ann.request('GET', `/projects/${projectId}/holidays`)).status, 200);
    assert.equal((await ann.request('DELETE', `/projects/${projectId}/holidays/${ownId}`, { reason: 'x' })).status, 403);
    // An organisation holiday cannot be removed through a project.
    assert.equal((await pm.request('DELETE', `/projects/${projectId}/holidays/${id}`, { reason: 'x' })).status, 404);
    assert.equal((await pm.request('DELETE', `/projects/${projectId}/holidays/${ownId}`, { reason: 'Not needed' })).status, 200);
    assert.deepEqual([...(await loadEffective(t.pool, projectId)).cal.holidays], ['2026-11-18']);
  });

  test('the preview lists a moved reminder with from and to, and leaves out recorded triggers', async () => {
    const taskId = await seedTask('2026-11-20', 'Write the report');
    const prev = await admin.request('POST', '/notification-settings/preview', { changes: { leadDays: [5, 1] } });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.added.length, 0);
    assert.equal(prev.body.removed.length, 0);
    assert.equal(prev.body.moved.length, 1);
    const m = prev.body.moved[0];
    // Seven working days before Fri 20 Nov is Wed 11 Nov; five is Fri 13 Nov; both at 09:00 UTC+8.
    // The Administrator holds no role in the project: the task title is project content and is not shown.
    assert.deepEqual(
      [m.recordKind, m.recordId, m.projectId, m.projectName, m.title, m.kind, m.from, m.to],
      ['task', taskId, projectId, 'Project', null, 'reminder', '2026-11-11T01:00:00.000Z', '2026-11-13T01:00:00.000Z'],
    );
    assert.ok(!JSON.stringify(prev.body).includes('Write the report'));
    const hol = await admin.request('POST', '/notification-settings/holidays/preview', { add: { date: '2026-11-19' } });
    assert.ok(hol.body.moved.length > 0 && hol.body.moved.every((x: { title: unknown }) => x.title === null));
    // An Administrator who also holds a role in the project sees the title.
    await t.pool.query(
      `INSERT INTO memberships (id, project_id, user_id, role, starts_on) VALUES ($1, $2, $3, 'sponsor', '2026-11-01')`,
      [uuidv7(), projectId, ids.admin],
    );
    const withRole = await admin.request('POST', '/notification-settings/preview', { changes: { leadDays: [5, 1] } });
    assert.equal(withRole.body.moved[0].title, 'Write the report');
    const holWithRole = await admin.request('POST', '/notification-settings/holidays/preview', { add: { date: '2026-11-19' } });
    assert.ok(holWithRole.body.moved.every((x: { title: unknown }) => x.title === 'Write the report'));
    // The change is only previewed.
    assert.deepEqual((await admin.request('GET', '/notification-settings')).body.leadDays, [7, 1]);

    await t.pool.query(
      `INSERT INTO notification_triggers (id, key, kind, project_id, record_kind, record_id, fire_at, decided_at, outcome)
       VALUES ($1, $2, 'reminder', $3, 'task', $4, '2026-11-11T01:00:00Z', '2026-11-11T01:00:00Z', 'sent')`,
      [uuidv7(), `task:${taskId}:reminder:7:2026-11-20:0`, projectId, taskId],
    );
    const after = await admin.request('POST', '/notification-settings/preview', { changes: { leadDays: [5, 1] } });
    assert.deepEqual([after.body.moved.length, after.body.removed.length], [0, 0]);
    assert.deepEqual(after.body.added.map((x: { kind: string; to: string }) => [x.kind, x.to]), [['reminder', '2026-11-13T01:00:00.000Z']]);
  });

  test('reminders keep their pairing by lead: adding a 5-day reminder to [7,1] when 7 days had passed shows only the new one', async () => {
    // The due date was set on Thu 12 Nov for Fri 20 Nov: the 7-day reminder (Wed 11 Nov) had already passed, so only the 1-day one is planned.
    const taskId = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, 0, 'Late task', $3, '2026-11-20', 'not_started', $4, '2026-11-12T00:00:00Z')`,
      [taskId, projectId, ids.ann, ids.owner],
    );
    const prev = await admin.request('POST', '/notification-settings/preview', { changes: { leadDays: [5, 1] } });
    assert.equal(prev.status, 200);
    assert.deepEqual(prev.body.moved, []);
    assert.deepEqual(prev.body.removed, []);
    // Five working days before Fri 20 Nov is Fri 13 Nov 09:00 UTC+8.
    assert.deepEqual(prev.body.added.map((x: { recordId: string; kind: string; from: unknown; to: string }) => [x.recordId, x.kind, x.from, x.to]), [
      [taskId, 'reminder', null, '2026-11-13T01:00:00.000Z'],
    ]);
    // Leftovers still pair by rank: [7,1] → [3,1] moves the 7-day reminder of a task where it is planned.
    const other = await seedTask('2026-11-27', 'Planned early');
    const p2 = await admin.request('POST', '/notification-settings/preview', { changes: { leadDays: [3, 1] } });
    assert.deepEqual(p2.body.moved.map((x: { recordId: string; from: string; to: string }) => [x.recordId, x.from, x.to]), [
      [other, '2026-11-18T01:00:00.000Z', '2026-11-24T01:00:00.000Z'],
    ]);
    // For the late task the 1-day reminder stays paired with itself; its new 3-day reminder (Tue 17 Nov) is new.
    assert.deepEqual(p2.body.added.map((x: { recordId: string; to: string }) => [x.recordId, x.to]), [[taskId, '2026-11-17T01:00:00.000Z']]);
    assert.equal(p2.body.removed.length, 0);
  });

  test('a project preview covers that project, and an organisation preview skips projects with their own value', async () => {
    await seedTask();
    await allow('Timings');
    await setProj({ leadDays: [3, 1] });
    const orgPrev = await admin.request('POST', '/notification-settings/preview', { changes: { leadDays: [5, 1] } });
    assert.deepEqual([orgPrev.body.moved, orgPrev.body.added, orgPrev.body.removed], [[], [], []]);
    const projPrev = await pm.request('POST', `/projects/${projectId}/notification-settings/preview`, { changes: { leadDays: [5, 1] } });
    assert.equal(projPrev.status, 200);
    assert.equal(projPrev.body.moved.length, 1);
    assert.deepEqual([projPrev.body.moved[0].from, projPrev.body.moved[0].to], ['2026-11-17T01:00:00.000Z', '2026-11-13T01:00:00.000Z']);
    assert.equal((await ann.request('POST', `/projects/${projectId}/notification-settings/preview`, { changes: { leadDays: [5, 1] } })).status, 403);
  });

  test('a calendar change moves reminders in the preview', async () => {
    await seedTask();
    const prev = await admin.request('POST', '/notification-settings/preview', { changes: { weekdays: [1, 2, 3, 4, 5, 6, 7] } });
    assert.equal(prev.status, 200);
    assert.ok(prev.body.moved.length >= 1);
    for (const m of prev.body.moved) assert.notEqual(m.from, m.to);
  });

  test('snapshots hold open tasks with their due-date history, and unresolved risks with a review date', async () => {
    const parent = await seedTask('2026-11-27', 'Parent');
    const child = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at)
       VALUES ($1, $2, $3, 1, 'Child', $4, '2026-11-20', 'in_progress', $5, '2026-11-02T00:00:00Z')`,
      [child, projectId, parent, ids.ann, ids.owner],
    );
    const done = await seedTask('2026-11-20', 'Done');
    await t.pool.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [done]);
    const ev = (kind: string, at: string, detail: unknown = null) =>
      t.pool.query(
        `INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at, detail) VALUES ($1, $2, $3, 'in_progress', 'in_progress', $4, $5, $6)`,
        [uuidv7(), child, kind, ids.owner, at, detail ? JSON.stringify(detail) : null],
      );
    await ev('authorised', '2026-11-03T00:00:00Z');
    await ev('amended', '2026-11-05T00:00:00Z', { title: { from: 'a', to: 'b' } });
    await ev('amended', '2026-11-06T00:00:00Z', { dueOn: { from: '2026-11-18', to: '2026-11-20' } });
    await ev('reopened', '2026-11-07T00:00:00Z');
    await ev('reopened', '2026-11-08T00:00:00Z');
    const snaps = await loadTaskSnaps(t.pool, projectId);
    assert.deepEqual(snaps.map((s) => s.title).sort(), ['Child', 'Parent']);
    const c = snaps.find((s) => s.id === child);
    assert.equal(c?.dueSetAt.toISOString(), '2026-11-06T00:00:00.000Z');
    assert.equal(c?.reopenCount, 2);
    assert.equal(c?.parentId, parent);
    assert.equal(c?.dueOn, '2026-11-20');

    const risk = async (status: string, reviewOn: string | null) => {
      const proposal = uuidv7();
      await t.pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', 'R', $3, now())`, [proposal, projectId, ids.owner]);
      await t.pool.query(
        `INSERT INTO risks (id, project_id, description, severity, status, review_on, origin_proposal_id, authorised_by, authorised_at)
         VALUES ($1, $2, 'Supplier slips', 'low', $3, $4, $5, $6, now())`,
        [uuidv7(), projectId, status, reviewOn, proposal, ids.owner],
      );
    };
    await risk('open', '2026-12-01');
    await risk('resolved', '2026-12-02');
    await risk('open', null);
    const risks = await loadRiskSnaps(t.pool, projectId);
    assert.deepEqual(risks.map((r) => [r.description, r.status, r.reviewOn]), [['Supplier slips', 'open', '2026-12-01']]);
  });

  test('holiday changes are recorded in the history with a reason', async () => {
    assert.equal((await admin.request('POST', '/notification-settings/holidays', { date: '2026-12-25', name: 'Winter Day' })).status, 400);
    const add = await admin.request('POST', '/notification-settings/holidays', { date: '2026-12-25', name: 'Winter Day', reason: 'Public holiday' });
    t.clock.advanceSeconds(60);
    await admin.request('DELETE', `/notification-settings/holidays/${add.body.holidays[0].id}`, { reason: 'Cancelled' });
    const h = (await admin.request('GET', '/notification-settings')).body.history;
    assert.deepEqual(h.map((x: { field: string; oldValue: string | null; newValue: string | null; reason: string }) => [x.field, x.oldValue, x.newValue, x.reason]).reverse(), [
      ['holiday', null, '2026-12-25 Winter Day', 'Public holiday'],
      ['holiday', '2026-12-25 Winter Day', null, 'Cancelled'],
    ]);
    await allow('Calendar');
    await pm.request('POST', `/projects/${projectId}/holidays`, { date: '2026-12-24', name: 'Eve', reason: 'Local' });
    const ph = (await pm.request('GET', `/projects/${projectId}/notification-settings`)).body.history;
    assert.deepEqual([ph.length, ph[0].field, ph[0].newValue, ph[0].reason], [1, 'holiday', '2026-12-24 Eve', 'Local']);
    const row = (await t.pool.query(`SELECT scope, project_id FROM notification_settings_changes WHERE new_value = '2026-12-24 Eve'`)).rows[0];
    assert.deepEqual([row.scope, row.project_id], ['project', projectId]);
  });

  test('a holiday preview moves a reminder to the previous working day', async () => {
    await seedTask('2026-11-20');
    // The 1-day reminder is Thu 19 Nov 09:00 UTC+8; making 19 Nov a holiday moves it to Wed 18 Nov.
    const prev = await admin.request('POST', '/notification-settings/holidays/preview', { add: { date: '2026-11-19' } });
    assert.equal(prev.status, 200);
    assert.deepEqual(prev.body.moved.map((m: { from: string; to: string }) => [m.from, m.to]), [['2026-11-11T01:00:00.000Z', '2026-11-10T01:00:00.000Z'], ['2026-11-19T01:00:00.000Z', '2026-11-18T01:00:00.000Z']]);
    const own = await pm.request('POST', `/projects/${projectId}/holidays/preview`, { add: { date: '2026-11-19' } });
    assert.deepEqual([own.status, own.body.moved.length], [200, 2]);
    assert.equal((await ann.request('POST', `/projects/${projectId}/holidays/preview`, { add: { date: '2026-11-19' } })).status, 403);
    assert.equal((await admin.request('POST', '/notification-settings/holidays/preview', {})).status, 400);
  });

  test('the Administrator may clear a project override but not set one', async () => {
    await allow('Timings');
    await setProj({ leadDays: [5, 1], escalationDays: 6 });
    await allow('Timings', false);
    t.clock.advanceSeconds(60);
    const set = await admin.request('PUT', `/projects/${projectId}/notification-settings`, { changes: { leadDays: [3, 1] }, reason: 'x' });
    assert.deepEqual([set.status, set.body.message], [403, 'Only a Project Manager, Owner or Sponsor can change the project’s notification settings.']);
    const clear = await admin.request('PUT', `/projects/${projectId}/notification-settings`, { changes: { leadDays: null, escalationDays: null }, reason: 'Back to central' });
    assert.equal(clear.status, 200);
    assert.deepEqual([clear.body.own.leadDays, clear.body.own.escalationDays], [null, null]);
    assert.deepEqual(clear.body.history.slice(0, 2).map((x: { actor: string; newValue: unknown; reason: string }) => [x.actor, x.newValue, x.reason]), [
      ['admin', null, 'Back to central'],
      ['admin', null, 'Back to central'],
    ]);
    // A project manager is still refused while the switch is off.
    assert.equal((await setProj({ leadDays: null })).status, 403);
  });

  test('a person with no role in the project gets 404, not a validation error', async () => {
    await seedUser(t.pool, 'outsider@example.org');
    const out = await t.signIn('outsider@example.org');
    const path = `/projects/${projectId}/notification-settings`;
    assert.equal((await out.request('GET', path)).status, 404);
    assert.equal((await out.request('PUT', path, { changes: { leadDays: [99] } })).status, 404);
    assert.equal((await out.request('PUT', path, {})).status, 404);
    assert.equal((await out.request('POST', `${path}/preview`, { changes: { leadDays: [99] } })).status, 404);
    assert.equal((await out.request('POST', `/projects/${projectId}/holidays/preview`, {})).status, 404);
    assert.equal((await out.request('POST', `/projects/${projectId}/holidays`, {})).status, 404);
  });
});
