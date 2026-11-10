import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { type SeedMember, seedProject, seedUser } from '../testing/projects';
import { Sweep } from './sweep';

const APP_URL = 'https://kainow.example.org';
/** Milliseconds for HH:MM UTC+8 on the given day of November 2026. */
const at = (day: number, h: number, m = 0): number => Date.UTC(2026, 10, day, h - 8, m);
const LETTERHEAD = 'Example Organisation';

describe('the sweep', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pool: Pool;
  let admin: string;
  let nudges = 0;
  const warnings: string[] = [];

  before(async () => {
    t = await startTestApp(at(1, 8));
    pool = t.pool;
    admin = await seedUser(pool, 'admin@kainow.test', 'enterprise_administrator');
  });
  after(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    // Each test sweeps only its own projects and mails only its own notices.
    await pool.query(`UPDATE projects SET status = 'planned' WHERE status = 'active'`);
    await pool.query(`DELETE FROM notifications WHERE outbox_id IS NULL`);
    await pool.query(`DELETE FROM sweep_runs`);
    await pool.query(`DELETE FROM holidays`);
    await pool.query(`UPDATE notification_settings SET lead_days = '{7,1}', sweep_minutes = 15`);
    nudges = 0;
    warnings.length = 0;
  });
  afterEach(() => {
    assert.deepEqual(warnings, [], 'the sweep logged no failure');
  });

  const sweep = () =>
    new Sweep({ pool, clock: t.clock.now, appUrl: APP_URL, nudge: { nudge: async () => { nudges += 1; } }, log: { warn: (m: string) => { warnings.push(m); } } });
  const runAt = async (ms: number) => {
    t.clock.ms = ms;
    return sweep().run();
  };
  const user = async (label: string) => {
    const email = `${label}-${uuidv7().slice(-10)}@example.org`;
    return { id: await seedUser(pool, email), email };
  };
  const project = (members: SeedMember[], status: 'active' | 'planned' | 'deferred' = 'active', name = 'Harbour Works') =>
    seedProject(pool, { status, members, name });
  const membershipId = async (projectId: string, userId: string) =>
    (await pool.query(`SELECT id FROM memberships WHERE project_id = $1 AND user_id = $2 ORDER BY id LIMIT 1`, [projectId, userId])).rows[0].id as string;

  async function task(projectId: string, o: {
    title: string; assignee: string; dueOn: string; parentId?: string; authorisedAt?: number; reviewRequired?: boolean; invitationId?: string;
  }): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, deadline_review_required, invitation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'not_started', $6, $8, $9, $10)`,
      [id, projectId, o.parentId ?? null, o.parentId ? 1 : 0, o.title, o.assignee, o.dueOn, new Date(o.authorisedAt ?? at(1, 8)), o.reviewRequired ?? false, o.invitationId ?? null],
    );
    return id;
  }
  async function risk(projectId: string, o: { description: string; responsible: string | null; reviewOn: string; by: string }): Promise<string> {
    const id = uuidv7();
    const proposal = uuidv7();
    await pool.query(`INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at) VALUES ($1, $2, 'risk', $3, $4, now())`, [proposal, projectId, o.description, o.by]);
    await pool.query(
      `INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, mitigation, origin_proposal_id, authorised_by, authorised_at)
       VALUES ($1, $2, $3, 'medium', $4, $5, 'Secret mitigation text', $6, $7, now())`,
      [id, projectId, o.description, o.responsible, o.reviewOn, proposal, o.by],
    );
    return id;
  }
  const setPref = (userId: string, projectId: string, choice: string) =>
    pool.query(
      `INSERT INTO email_preferences (user_id, project_id, choice, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, project_id) DO UPDATE SET choice = EXCLUDED.choice`,
      [userId, projectId, choice],
    );
  const away = (userId: string, from: string, to: string) =>
    pool.query(`INSERT INTO away_periods (id, user_id, starts_on, ends_on, created_at) VALUES ($1, $2, $3, $4, now())`, [uuidv7(), userId, from, to]);
  const resume = async (projectId: string, actor: string, ms: number, from = 'deferred') => {
    await pool.query(`UPDATE projects SET status = 'active' WHERE id = $1`, [projectId]);
    const id = uuidv7();
    await pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, $3, 'active', $4, $5)`, [id, projectId, from, actor, new Date(ms)]);
    return id;
  };

  type Trig = { id: string; key: string; kind: string; record_id: string; outcome: string; recipients: string[]; detail: Record<string, unknown>; fire_at: Date };
  const triggers = async (projectId: string): Promise<Trig[]> =>
    (await pool.query(`SELECT id, key, kind, record_id, outcome, recipients, detail, fire_at FROM notification_triggers WHERE project_id = $1 ORDER BY key`, [projectId])).rows;
  const byKind = async (projectId: string, kind: string) => (await triggers(projectId)).filter((x) => x.kind === kind);
  const notes = async (projectId: string) =>
    (await pool.query(`SELECT * FROM notifications WHERE project_id = $1 ORDER BY created_at, user_id, summary`, [projectId])).rows;
  const mails = async (projectId: string) =>
    (await pool.query(`SELECT * FROM email_outbox WHERE project_id = $1 ORDER BY created_at, to_address`, [projectId])).rows;
  const mailsTo = async (projectId: string, userId: string) => (await mails(projectId)).filter((m) => m.to_user_id === userId);
  const sorted = (...ids: string[]) => [...ids].sort();

  test('a reminder fires at Friday 09:00 for a Monday deadline: one in-app row, one email; a second run fires nothing', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    const tk = await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-16' });

    const counts = await runAt(at(13, 9));
    const trs = await triggers(p);
    assert.deepEqual(trs.map((x) => [x.key, x.outcome]), [
      [`task:${tk}:reminder:1:2026-11-16:0`, 'sent'],
      [`task:${tk}:reminder:7:2026-11-16:0`, 'skipped_obsolete'],
    ]);
    assert.deepEqual(trs[0].recipients, [ann.id]);
    assert.equal(trs[0].fire_at.getTime(), at(13, 9));
    assert.deepEqual(trs[1].recipients, []);

    const n = await notes(p);
    assert.equal(n.length, 1);
    assert.equal(n[0].user_id, ann.id);
    assert.equal(n[0].summary, "Reminder: 'Draft the tender' is due on Mon 16 Nov");
    assert.equal(n[0].link, `#/projects/${p}/work/${tk}`);
    assert.equal(n[0].urgent, false);
    assert.equal(n[0].email_off, false);
    assert.equal(n[0].trigger_id, trs[0].id);

    const m = await mails(p);
    assert.equal(m.length, 1);
    assert.equal(m[0].to_user_id, ann.id);
    assert.equal(m[0].to_address, ann.email);
    assert.equal(m[0].kind, 'notice');
    assert.equal(m[0].subject, 'Kainow: 1 item needs your attention in Harbour Works');
    assert.ok(m[0].text_body.includes(`Reminder: 'Draft the tender' is due on Mon 16 Nov — ${APP_URL}/#/projects/${p}/work/${tk}`));
    assert.equal(m[0].initiated_by, 'schedule');
    assert.deepEqual(m[0].trigger_ids, [trs[0].id]);
    assert.equal(m[0].relevance.scope, 'project');
    assert.equal(m[0].relevance.projectName, 'Harbour Works');
    assert.deepEqual(m[0].relevance.items.map((i: { check: unknown }) => i.check), [{ kind: 'task', taskId: tk, dueOn: '2026-11-16', reopenCount: 0 }]);
    assert.equal((await notes(p))[0].outbox_id, m[0].id);
    assert.equal(nudges, 1);
    assert.deepEqual([counts.triggers, counts.notifications, counts.emails], [2, 1, 1]);

    const again = await runAt(at(13, 9));
    assert.deepEqual([again.triggers, again.notifications, again.emails], [0, 0, 0]);
    assert.equal((await triggers(p)).length, 2);
    assert.equal((await notes(p)).length, 1);
    assert.equal((await mails(p)).length, 1);
    assert.equal(nudges, 1);
  });

  test('the overdue escalation goes to the PM at Friday 09:00, not before, urgent and at once', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    const tk = await task(p, { title: 'Call the supplier', assignee: ann.id, dueOn: '2026-11-09' });

    await runAt(at(12, 9));
    assert.equal((await byKind(p, 'overdue')).length, 0);
    assert.deepEqual((await byKind(p, 'reminder')).map((x) => x.outcome), ['skipped_obsolete'], 'a reminder past its deadline is obsolete');
    assert.equal((await notes(p)).length, 0);

    await runAt(at(13, 9));
    const [o] = await byKind(p, 'overdue');
    assert.equal(o.key, `task:${tk}:overdue:2026-11-09:0`);
    assert.equal(o.outcome, 'sent');
    assert.deepEqual(o.recipients, [pm.id]);
    const n = await notes(p);
    assert.equal(n.length, 1);
    assert.equal(n[0].user_id, pm.id);
    assert.equal(n[0].urgent, true);
    assert.equal(n[0].summary, "Overdue: 'Call the supplier' was due on Mon 9 Nov");
    const m = await mails(p);
    assert.equal(m.length, 1);
    assert.equal(m[0].to_user_id, pm.id);
    assert.equal(m[0].initiated_by, 'trigger');
  });

  test('an amendment to a new due date gives new reminders and keeps the old trigger rows', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    const tk = await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-16' });
    await runAt(at(13, 9));
    const before = await triggers(p);
    assert.equal(before.length, 2);

    await pool.query(`UPDATE tasks SET due_on = '2026-11-23' WHERE id = $1`, [tk]);
    await pool.query(`INSERT INTO task_events (id, task_id, kind, actor_id, at, detail) VALUES ($1, $2, 'amended', $3, $4, '{"dueOn":"2026-11-23"}')`, [uuidv7(), tk, pm.id, new Date(at(13, 10))]);
    await runAt(at(13, 10, 15));
    assert.equal((await triggers(p)).length, 2, 'the new 7-day reminder was already past when the date took effect');

    await runAt(at(20, 9));
    const after = await triggers(p);
    assert.deepEqual(after.map((x) => [x.key, x.outcome]), [
      [`task:${tk}:reminder:1:2026-11-16:0`, 'sent'],
      [`task:${tk}:reminder:1:2026-11-23:0`, 'sent'],
      [`task:${tk}:reminder:7:2026-11-16:0`, 'skipped_obsolete'],
    ]);
    assert.ok(before.every((b) => after.some((a) => a.id === b.id && a.outcome === b.outcome)));
    assert.deepEqual((await notes(p)).map((n) => n.summary), [
      "Reminder: 'Draft the tender' is due on Mon 16 Nov",
      "Reminder: 'Draft the tender' is due on Mon 23 Nov",
    ]);
  });

  test('a Deferred project fires nothing; after resuming, paused triggers are skipped and one summary goes to the PM and each assignee', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const owner = await user('owner');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }, { userId: owner.id, role: 'owner' }], 'deferred');
    await pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, 'active', 'deferred', $3, $4)`, [uuidv7(), p, pm.id, new Date(at(9, 10))]);
    const hall = await task(p, { title: 'Book the hall', assignee: ann.id, dueOn: '2026-11-13', reviewRequired: true });
    const call = await task(p, { title: 'Call the supplier', assignee: ann.id, dueOn: '2026-11-12' });
    const rk = await risk(p, { description: 'Supplier may withdraw', responsible: owner.id, reviewOn: '2026-11-13', by: pm.id });

    for (const ms of [at(11, 9), at(13, 9), at(16, 9), at(18, 9)]) await runAt(ms);
    assert.equal((await triggers(p)).length, 0);

    const tid = await resume(p, pm.id, at(18, 10));
    await runAt(at(18, 10, 5));
    const trs = await triggers(p);
    const outcome = (key: string) => trs.find((x) => x.key === key)?.outcome;
    assert.equal(outcome(`task:${call}:overdue:2026-11-12:0`), 'skipped_paused');
    assert.equal(outcome(`risk:${rk}:review_due:2026-11-13`), 'skipped_paused');
    assert.equal(outcome(`risk:${rk}:review_missed:2026-11-13`), 'skipped_paused');
    assert.ok(!trs.some((x) => x.record_id === hall && x.kind !== 'resumption'), 'a task under deadline review fires nothing');
    const [r] = trs.filter((x) => x.kind === 'resumption');
    assert.equal(r.key, `project:${p}:resumed:${tid}`);
    assert.equal(r.outcome, 'sent');
    assert.equal(r.fire_at.getTime(), at(18, 10));
    assert.deepEqual(r.recipients, sorted(pm.id, ann.id));

    const n = await notes(p);
    assert.deepEqual(n.map((x) => x.user_id).sort(), sorted(pm.id, ann.id));
    for (const x of n) {
      assert.equal(x.kind, 'resumption');
      assert.equal(x.urgent, false);
      assert.equal(x.link, `#/projects/${p}/work`);
      assert.equal(
        x.summary,
        "Harbour Works: work to check after resuming. Deadline review required: 'Book the hall'. " +
          "Overdue: 'Call the supplier' (due Thu 12 Nov). Risk review date passed: 'Supplier may withdraw' (Fri 13 Nov).",
      );
      assert.ok(!x.summary.includes('Secret mitigation'));
    }
    assert.equal((await mails(p)).length, 0, 'not urgent: waits for the next 09:00');

    await runAt(at(18, 10, 30));
    assert.equal((await byKind(p, 'resumption')).length, 1);
    await runAt(at(19, 9));
    const m = await mails(p);
    assert.deepEqual(m.map((x) => x.to_user_id).sort(), sorted(pm.id, ann.id));
    assert.ok(m.every((x) => x.subject === 'Kainow: 1 item needs your attention in Harbour Works' && x.initiated_by === 'schedule'));
    assert.deepEqual(m[0].relevance.items[0].check, { kind: 'project_active', projectId: p });
  });

  test("an Owner's task with no independent person is no_recipient, and the flag endpoint lists it while overdue and open", async () => {
    const u = await user('sole');
    const mem = await user('mem');
    const outsider = await user('outsider');
    const p = await project([{ userId: u.id, role: 'pm' }, { userId: u.id, role: 'owner' }, { userId: mem.id, role: 'member' }]);
    const tk = await task(p, { title: 'Sign the lease', assignee: u.id, dueOn: '2026-11-09' });
    await runAt(at(13, 9));
    const [o] = await byKind(p, 'overdue');
    assert.equal(o.outcome, 'no_recipient');
    assert.deepEqual(o.recipients, []);
    assert.equal((await notes(p)).length, 0);
    assert.equal((await mails(p)).length, 0);

    const viewer = await t.signIn(mem.email);
    const r = await viewer.request('GET', `/projects/${p}/escalation-flags`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ taskId: tk, title: 'Sign the lease', dueOn: '2026-11-09' }]);
    const stranger = await t.signIn(outsider.email);
    assert.equal((await stranger.request('GET', `/projects/${p}/escalation-flags`)).status, 404);

    await pool.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [tk]);
    assert.deepEqual((await viewer.request('GET', `/projects/${p}/escalation-flags`)).body, []);
  });

  test('catch-up after three days down across a weekend: one email per recipient per project, only the latest reminder (Review Focus 4)', async () => {
    await pool.query(`UPDATE notification_settings SET lead_days = '{2,1}'`);
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    const x = await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-17' });
    await task(p, { title: 'Call the supplier', assignee: ann.id, dueOn: '2026-11-09' });
    await risk(p, { description: 'Supplier may withdraw', responsible: ann.id, reviewOn: '2026-11-13', by: pm.id });

    await runAt(at(12, 17));
    assert.equal((await notes(p)).length, 0);
    // Down from Thursday evening until Monday 10:00.
    await runAt(at(16, 10));
    const reminders = await byKind(p, 'reminder');
    const outcome = (key: string) => reminders.find((r) => r.key === key)?.outcome;
    assert.equal(outcome(`task:${x}:reminder:1:2026-11-17:0`), 'sent');
    assert.equal(outcome(`task:${x}:reminder:2:2026-11-17:0`), 'skipped_obsolete');

    const forAnn = await mailsTo(p, ann.id);
    const forPm = await mailsTo(p, pm.id);
    assert.equal(forAnn.length, 1);
    assert.equal(forPm.length, 1);
    assert.equal(forAnn[0].subject, 'Kainow: 3 items need your attention in Harbour Works');
    assert.equal((forAnn[0].text_body.match(/Reminder: /g) ?? []).length, 1);
    assert.ok(forAnn[0].text_body.includes("Risk review due: 'Supplier may withdraw' on Fri 13 Nov"));
    assert.ok(forAnn[0].text_body.includes("Risk review missed: 'Supplier may withdraw' was due for review on Fri 13 Nov"));
    assert.equal(forPm[0].subject, 'Kainow: 3 items need your attention in Harbour Works');
    assert.ok(forPm[0].text_body.includes("Overdue: 'Call the supplier' was due on Mon 9 Nov"));
    assert.equal(forPm[0].initiated_by, 'schedule');
    assert.equal(forPm[0].trigger_ids.length, 3);
  });

  test('a holiday added after a trigger was recorded never re-sends it; untriggered ones move (Review Focus 3)', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    const x = await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-16' });
    const z = await task(p, { title: 'Book the hall', assignee: ann.id, dueOn: '2026-11-23' });
    await runAt(at(13, 9));
    const firstNotes = (await notes(p)).length;
    assert.equal((await triggers(p)).find((r) => r.key === `task:${x}:reminder:1:2026-11-16:0`)?.outcome, 'sent');

    const addHoliday = (date: string) =>
      pool.query(`INSERT INTO holidays (id, project_id, on_date, name, added_by, added_at) VALUES ($1, NULL, $2, 'Local holiday', $3, now())`, [uuidv7(), date, pm.id]);
    await addHoliday('2026-11-13');
    const c = await runAt(at(13, 9, 30));
    assert.deepEqual([c.triggers, c.notifications, c.emails], [0, 0, 0]);
    assert.equal((await notes(p)).length, firstNotes);

    await addHoliday('2026-11-20');
    await runAt(at(19, 9));
    const moved = (await triggers(p)).find((r) => r.key === `task:${z}:reminder:1:2026-11-23:0`);
    assert.equal(moved?.outcome, 'sent');
    assert.equal(moved?.fire_at.getTime(), at(19, 9), 'moved to Thursday 09:00 by the new holiday');
  });

  test('a parent-deadline escalation for a PM-assigned subtask goes to the Owners and Sponsors, not the PM (Review Focus 2)', async () => {
    const pm = await user('pm');
    const mem = await user('mem');
    const owner = await user('owner');
    const sponsor = await user('sponsor');
    const p = await project([
      { userId: pm.id, role: 'pm' }, { userId: mem.id, role: 'member' }, { userId: owner.id, role: 'owner' }, { userId: sponsor.id, role: 'sponsor' },
    ]);
    const parent = await task(p, { title: 'Prepare the venue', assignee: mem.id, dueOn: '2026-11-09' });
    const child = await task(p, { title: 'Order chairs', assignee: pm.id, dueOn: '2026-11-20', parentId: parent });
    await runAt(at(10, 9));
    const [pd] = await byKind(p, 'parent_deadline');
    assert.equal(pd.key, `task:${child}:parent_deadline:${parent}:2026-11-09`);
    assert.equal(pd.outcome, 'sent');
    assert.deepEqual(pd.recipients, sorted(owner.id, sponsor.id));
    const n = (await notes(p)).filter((x) => x.kind === 'parent_deadline');
    assert.deepEqual(n.map((x) => x.user_id).sort(), sorted(owner.id, sponsor.id));
    assert.ok(n.every((x) => x.urgent && x.summary === "Subtask 'Order chairs' is unfinished past its parent's deadline (Mon 9 Nov)"));
    assert.equal((await mailsTo(p, pm.id)).length, 0);
    assert.equal((await mails(p)).length, 2);
  });

  test('risk review due on the day and missed the next morning, but not after a new review date was set', async () => {
    const pm = await user('pm');
    const rp = await user('resp');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: rp.id, role: 'member' }]);
    const r1 = await risk(p, { description: 'Supplier may withdraw', responsible: rp.id, reviewOn: '2026-11-18', by: pm.id });
    const r2 = await risk(p, { description: 'Permit may be late', responsible: rp.id, reviewOn: '2026-11-18', by: pm.id });
    await runAt(at(18, 8, 45));
    assert.equal((await triggers(p)).length, 0);
    await runAt(at(18, 9));
    const due = await byKind(p, 'risk_review_due');
    assert.deepEqual(due.map((x) => x.key).sort(), [`risk:${r1}:review_due:2026-11-18`, `risk:${r2}:review_due:2026-11-18`].sort());
    assert.ok(due.every((x) => JSON.stringify(x.recipients) === JSON.stringify(sorted(pm.id, rp.id))));

    await pool.query(`UPDATE risks SET review_on = '2026-11-27' WHERE id = $1`, [r2]);
    await runAt(at(18, 23));
    assert.equal((await byKind(p, 'risk_review_missed')).length, 0);
    await runAt(at(19, 9));
    const missed = await byKind(p, 'risk_review_missed');
    assert.deepEqual(missed.map((x) => x.key), [`risk:${r1}:review_missed:2026-11-18`]);
    const n = (await notes(p)).filter((x) => x.kind === 'risk_review_missed');
    assert.equal(n.length, 2);
    assert.ok(n.every((x) => !x.urgent && x.link === `#/projects/${p}/work/${r1}` && !x.summary.includes('Secret')));
  });

  test('an unavailable assignee alerts the PM once per hold, per ended membership and per failed invitation', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const cal = await user('cal');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }, { userId: cal.id, role: 'member', expiresOn: '2026-11-16' }]);
    const tk = await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-27' });
    const mid = await membershipId(p, ann.id);

    await runAt(at(16, 10));
    assert.equal((await byKind(p, 'assignee_unavailable')).length, 0);

    const held1 = at(16, 10, 5);
    await pool.query(`UPDATE memberships SET held_at = $2, held_by = $3, hold_reason = 'Investigation' WHERE id = $1`, [mid, new Date(held1), pm.id]);
    await runAt(at(16, 10, 15));
    let ua = await byKind(p, 'assignee_unavailable');
    assert.equal(ua.length, 1);
    assert.equal(ua[0].key, `task:${tk}:assignee_unavailable:hold:${mid}:${held1}`);
    assert.equal(ua[0].outcome, 'sent');
    assert.deepEqual(ua[0].recipients, [pm.id]);
    assert.equal(ua[0].fire_at.getTime(), at(16, 10, 15), 'urgent: fires at once');
    const n = (await notes(p)).filter((x) => x.kind === 'assignee_unavailable');
    assert.equal(n.length, 1);
    assert.equal(n[0].urgent, true);
    assert.equal(n[0].summary, "Task 'Draft the tender' needs a new assignee");
    assert.equal((await mailsTo(p, pm.id)).length, 1, 'urgent: emailed at once');

    await runAt(at(16, 10, 30));
    assert.equal((await byKind(p, 'assignee_unavailable')).length, 1);
    await pool.query(`UPDATE memberships SET restored_at = $2, restored_by = $3 WHERE id = $1`, [mid, new Date(at(16, 11)), pm.id]);
    await runAt(at(16, 11, 15));
    assert.equal((await byKind(p, 'assignee_unavailable')).length, 1);

    const held2 = at(17, 10);
    await pool.query(`UPDATE memberships SET held_at = $2 WHERE id = $1`, [mid, new Date(held2)]);
    await runAt(at(17, 10, 15));
    ua = await byKind(p, 'assignee_unavailable');
    assert.ok(ua.some((x) => x.key === `task:${tk}:assignee_unavailable:hold:${mid}:${held2}`), 'a new hold alerts again');

    // An expired membership (Cal's ended on 16 Nov), and an invitation that was declined.
    const ct = await task(p, { title: 'Book the hall', assignee: cal.id, dueOn: '2026-11-27' });
    const bea = await user('bea');
    const inv = uuidv7();
    await pool.query(
      `INSERT INTO invitations (id, project_id, email, role, starts_on, invited_by, token_hash, issued_at, expires_at, status)
       VALUES ($1, $2, $3, 'member', '2026-11-01', $4, $5, $6, $7, 'invited')`,
      [inv, p, bea.email, pm.id, `hash-${inv}`, new Date(at(16, 9)), new Date(at(23, 9))],
    );
    const bt = await task(p, { title: 'Call the supplier', assignee: bea.id, dueOn: '2026-11-27', invitationId: inv });
    await runAt(at(17, 11));
    ua = await byKind(p, 'assignee_unavailable');
    const cm = await membershipId(p, cal.id);
    assert.ok(ua.some((x) => x.key === `task:${ct}:assignee_unavailable:membership:${cm}`));
    assert.ok(!ua.some((x) => x.key.startsWith(`task:${bt}:`)), 'a pending invitation is waited on');
    await pool.query(`UPDATE invitations SET status = 'declined', responded_at = now() WHERE id = $1`, [inv]);
    await runAt(at(17, 11, 15));
    ua = await byKind(p, 'assignee_unavailable');
    assert.ok(ua.some((x) => x.key === `task:${bt}:assignee_unavailable:invitation:${inv}`));
    assert.equal(ua.length, 4);
  });

  test('the Administrator fallback carries exactly "A task in <name> needs reassignment." and nothing else', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm', revoked: true }, { userId: ann.id, role: 'member' }], 'active', 'Quarry Lane Depot');
    const tk = await task(p, { title: 'Survey the boundary', assignee: ann.id, dueOn: '2026-11-27' });
    await pool.query(`UPDATE memberships SET held_at = $2, held_by = $3 WHERE project_id = $1 AND user_id = $4`, [p, new Date(at(16, 9)), pm.id, ann.id]);
    await runAt(at(16, 10));
    const [ua] = await byKind(p, 'assignee_unavailable');
    assert.equal(ua.outcome, 'sent');
    assert.deepEqual(ua.recipients, [admin]);
    assert.equal(ua.detail.minimal, true);
    const [n] = await notes(p);
    assert.equal(n.user_id, admin);
    assert.equal(n.summary, 'A task in Quarry Lane Depot needs reassignment.');
    assert.equal(n.link, null);
    const [m] = await mails(p);
    assert.equal(m.to_user_id, admin);
    assert.equal(m.text_body, `${LETTERHEAD}\n\nA task in Quarry Lane Depot needs reassignment.\n\nSent by Kainow for ${LETTERHEAD}.`);
    assert.ok(!m.text_body.includes('Survey') && !m.html_body.includes('Survey') && !m.text_body.includes(tk));
    assert.equal(m.relevance.scope, 'admin');
  });

  test('a Planned project fires nothing', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }], 'planned');
    await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-09' });
    await runAt(at(13, 9));
    assert.equal((await triggers(p)).length, 0);
  });

  test('runIfDue waits for the sweep interval and records each run', async () => {
    t.clock.ms = at(13, 9);
    assert.equal(await sweep().runIfDue(), true);
    t.clock.ms = at(13, 9, 14);
    assert.equal(await sweep().runIfDue(), false);
    t.clock.ms = at(13, 9, 15);
    assert.equal(await sweep().runIfDue(), true);
    const runs = (await pool.query(`SELECT * FROM sweep_runs ORDER BY started_at`)).rows;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].started_at.getTime(), at(13, 9));
    assert.ok(runs[0].finished_at.getTime() >= runs[0].started_at.getTime());
    assert.ok(runs[0].duration_ms >= 0);
  });

  test('default choice: an escalation caught at 14:00 is emailed at once; 09:00 notices share one email per project; two projects, two emails', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    await task(p, { title: 'Call the supplier', assignee: ann.id, dueOn: '2026-11-09', authorisedAt: at(12, 18) });
    await runAt(at(12, 18, 30));
    await runAt(at(13, 8, 45));
    assert.equal((await mails(p)).length, 0);
    await runAt(at(13, 14));
    const m = await mailsTo(p, pm.id);
    assert.equal(m.length, 1);
    assert.ok(m[0].text_body.includes("Overdue: 'Call the supplier'"));
    assert.equal(m[0].initiated_by, 'trigger');

    const x = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }], 'active', 'North Depot');
    const y = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }], 'active', 'South Depot');
    await task(x, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-23', authorisedAt: at(13, 15) });
    await risk(x, { description: 'Supplier may withdraw', responsible: ann.id, reviewOn: '2026-11-20', by: pm.id });
    await task(y, { title: 'Book the hall', assignee: ann.id, dueOn: '2026-11-23', authorisedAt: at(13, 15) });
    await runAt(at(20, 8, 45));
    assert.equal((await mails(x)).length + (await mails(y)).length, 0);
    await runAt(at(20, 9));
    const ax = await mailsTo(x, ann.id);
    const ay = await mailsTo(y, ann.id);
    assert.equal(ax.length, 1);
    assert.equal(ay.length, 1);
    assert.equal(ax[0].subject, 'Kainow: 2 items need your attention in North Depot');
    assert.ok(ax[0].text_body.includes("Reminder: 'Draft the tender'") && ax[0].text_body.includes("Risk review due: 'Supplier may withdraw'"));
    assert.equal(ay[0].subject, 'Kainow: 1 item needs your attention in South Depot');
    assert.equal(ax[0].initiated_by, 'schedule');
  });

  test('"immediate" emails a non-urgent notice at once while the default waits for 09:00', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }], 'deferred');
    await task(p, { title: 'Book the hall', assignee: ann.id, dueOn: '2026-11-27', reviewRequired: true });
    await setPref(pm.id, p, 'immediate');
    await resume(p, pm.id, at(16, 14));
    await runAt(at(16, 14, 5));
    assert.equal((await notes(p)).length, 2);
    const forPm = await mailsTo(p, pm.id);
    assert.equal(forPm.length, 1);
    assert.equal(forPm[0].initiated_by, 'trigger');
    assert.equal((await mailsTo(p, ann.id)).length, 0);
    await runAt(at(17, 8, 45));
    assert.equal((await mailsTo(p, ann.id)).length, 0);
    await runAt(at(17, 9));
    assert.equal((await mailsTo(p, ann.id)).length, 1);
    assert.equal((await mailsTo(p, pm.id)).length, 1);
  });

  test('"daily" holds an urgent alert to the next 09:00', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-27' });
    await setPref(pm.id, p, 'daily');
    await pool.query(`UPDATE memberships SET held_at = $2, held_by = $3 WHERE project_id = $1 AND user_id = $4`, [p, new Date(at(16, 13, 55)), pm.id, ann.id]);
    await runAt(at(16, 14));
    assert.equal((await byKind(p, 'assignee_unavailable')).length, 1);
    assert.equal((await mails(p)).length, 0);
    await runAt(at(17, 8, 45));
    assert.equal((await mails(p)).length, 0);
    await runAt(at(17, 9));
    const m = await mailsTo(p, pm.id);
    assert.equal(m.length, 1);
    assert.equal(m[0].initiated_by, 'schedule');
  });

  test('"off" sends nothing then or later; cover adds the Owner; rows held while away are not sent after switching off', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const owner = await user('owner');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }, { userId: owner.id, role: 'owner' }]);
    await task(p, { title: 'Call the supplier', assignee: ann.id, dueOn: '2026-11-09' });
    await setPref(pm.id, p, 'off');
    await runAt(at(13, 9));
    const [o] = await byKind(p, 'overdue');
    assert.deepEqual(o.recipients, sorted(pm.id, owner.id));
    assert.deepEqual(o.detail.covering, [owner.id]);
    const n = await notes(p);
    assert.equal(n.find((x) => x.user_id === pm.id)?.email_off, true);
    assert.equal(n.find((x) => x.user_id === owner.id)?.email_off, false);
    assert.equal((await mailsTo(p, pm.id)).length, 0);
    assert.equal((await mailsTo(p, owner.id)).length, 1);
    await setPref(pm.id, p, 'daily_urgent_immediate');
    await runAt(at(16, 9));
    assert.equal((await mailsTo(p, pm.id)).length, 0, 'nothing is caught up later');

    // Away on the day it fires: held (with cover); then switched to off: still not sent.
    const q = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }, { userId: owner.id, role: 'owner' }], 'active', 'North Depot');
    await task(q, { title: 'Book the hall', assignee: ann.id, dueOn: '2026-11-12' });
    await away(pm.id, '2026-11-18', '2026-11-18');
    await runAt(at(18, 9));
    const [oq] = await byKind(q, 'overdue');
    assert.deepEqual(oq.detail.covering, [owner.id]);
    assert.equal((await mailsTo(q, pm.id)).length, 0);
    await setPref(pm.id, q, 'off');
    await runAt(at(19, 9));
    assert.equal((await mailsTo(q, pm.id)).length, 0);
    const held = (await notes(q)).find((x) => x.user_id === pm.id);
    assert.equal(held?.email_off, true, 'marked when the choice is Off at mail time');
    await setPref(pm.id, q, 'daily_urgent_immediate');
    await runAt(at(20, 9));
    assert.equal((await mailsTo(q, pm.id)).length, 0, 'switching back does not catch it up');
  });

  test('away Monday to Wednesday holds everything, urgent included; Thursday 09:00 carries the catch-up in one email', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    await risk(p, { description: 'Supplier may withdraw', responsible: ann.id, reviewOn: '2026-11-16', by: pm.id });
    await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-19', authorisedAt: at(16, 8) });
    // Authorised on Tuesday with a date already past: an urgent notice to Ann (and the PM) at Wednesday 09:00.
    await task(p, { title: 'Book the hall', assignee: ann.id, dueOn: '2026-11-16', authorisedAt: at(17, 10) });
    await away(ann.id, '2026-11-16', '2026-11-18');
    for (const ms of [at(16, 9), at(17, 9), at(18, 9), at(19, 0, 5), at(19, 8, 45)]) await runAt(ms);
    assert.equal((await mailsTo(p, ann.id)).length, 0, 'the urgent notice from an away day waits for the daily email too');
    const annNotes = (await notes(p)).filter((x) => x.user_id === ann.id);
    assert.equal(annNotes.length, 4, 'in-app notices still appear');
    assert.ok(annNotes.some((x) => x.kind === 'past_due_set' && x.urgent));
    assert.equal((await mailsTo(p, pm.id)).length, 3, 'the PM is not away');
    await runAt(at(19, 9));
    const m = await mailsTo(p, ann.id);
    assert.equal(m.length, 1);
    assert.equal(m[0].subject, 'Kainow: 4 items need your attention in Harbour Works');
    assert.ok(m[0].text_body.includes("Reminder: 'Draft the tender' is due on Thu 19 Nov"));
    assert.ok(m[0].text_body.includes("Due date set in the past: 'Book the hall' was due on Mon 16 Nov"));
    assert.equal(m[0].initiated_by, 'schedule');
  });

  test('a notice not yet emailed when the project is Deferred is not emailed while paused, nor after resuming', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }], 'deferred');
    await task(p, { title: 'Book the hall', assignee: ann.id, dueOn: '2026-11-27', reviewRequired: true });
    // A non-urgent notice fired Friday 14:00 under the default choice: it waits for Monday 09:00.
    await resume(p, pm.id, at(13, 14));
    await runAt(at(13, 14, 5));
    const [first] = await byKind(p, 'resumption');
    assert.equal((await mails(p)).length, 0);
    await pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [p]);
    await pool.query(
      `INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, 'active', 'deferred', $3, $4)`,
      [uuidv7(), p, pm.id, new Date(at(13, 16))],
    );
    await runAt(at(16, 9));
    assert.equal((await mails(p)).length, 0, 'not emailed while the project is Deferred');

    await resume(p, pm.id, at(17, 10));
    await runAt(at(17, 10, 5));
    const old = (await notes(p)).filter((x) => x.trigger_id === first.id);
    assert.equal(old.length, 2);
    assert.ok(old.every((x) => x.email_off && x.outbox_id === null), 'replaced by the new resumption summary');
    await runAt(at(18, 9));
    const m = await mailsTo(p, pm.id);
    assert.equal(m.length, 1);
    const second = (await byKind(p, 'resumption')).find((x) => x.id !== first.id);
    assert.deepEqual(m[0].trigger_ids, [second?.id]);
    assert.ok((await notes(p)).filter((x) => x.trigger_id === first.id).every((x) => x.outbox_id === null));
  });

  test('a task under deadline review raises no unavailable-assignee alert', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    await task(p, { title: 'Book the hall', assignee: ann.id, dueOn: '2026-11-27', reviewRequired: true });
    await pool.query(`UPDATE memberships SET held_at = $2, held_by = $3 WHERE project_id = $1 AND user_id = $4`, [p, new Date(at(16, 9)), pm.id, ann.id]);
    await runAt(at(16, 10));
    assert.equal((await byKind(p, 'assignee_unavailable')).length, 0);
  });

  test('a throwing nudge is logged and the run is still recorded', async () => {
    const pm = await user('pm');
    const ann = await user('ann');
    const p = await project([{ userId: pm.id, role: 'pm' }, { userId: ann.id, role: 'member' }]);
    await task(p, { title: 'Draft the tender', assignee: ann.id, dueOn: '2026-11-16' });
    t.clock.ms = at(13, 9);
    const logged: string[] = [];
    const s = new Sweep({
      pool, clock: t.clock.now, appUrl: APP_URL,
      nudge: { nudge: async () => { throw new Error('queue down'); } },
      log: { warn: (m: string) => { logged.push(m); } },
    });
    const c = await s.run();
    assert.equal(c.emails, 1);
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes('queue down'));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sweep_runs`)).rows[0].n, 1);
  });
});
