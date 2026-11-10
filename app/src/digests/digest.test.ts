import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import type { Calendar } from '../notifications/calendar';
import { SKIP_NO_DB } from '../testing/db';
import { type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { asAtLine, buildDigest, digestRecipients, scheduledDigestDue } from './digest';

/** Instant for HH:MM UTC+8 on a day of November 2026. */
const at = (day: number, h: number, m = 0): Date => new Date(Date.UTC(2026, 10, day, h - 8, m));
const WORK: Calendar = { dayCounting: 'working', weekdays: [1, 2, 3, 4, 5], holidays: new Set() };

describe('scheduledDigestDue', () => {
  test('daily is due on working days from the chosen time, once', () => {
    const s = { frequency: 'daily' as const, weekday: null, time: '09:00' };
    assert.equal(scheduledDigestDue(WORK, s, at(20, 8, 59), null), null);
    assert.equal(scheduledDigestDue(WORK, s, at(20, 9), null), '2026-11-20');
    assert.equal(scheduledDigestDue(WORK, s, at(20, 15), '2026-11-19'), '2026-11-20');
    assert.equal(scheduledDigestDue(WORK, s, at(20, 15), '2026-11-20'), null);
  });
  test('daily skips Saturday in Working Days mode but not in Calendar mode', () => {
    const s = { frequency: 'daily' as const, weekday: null, time: '09:00' };
    assert.equal(scheduledDigestDue(WORK, s, at(21, 10), null), null);
    assert.equal(scheduledDigestDue({ ...WORK, dayCounting: 'calendar' }, s, at(21, 10), null), '2026-11-21');
  });
  test('daily skips a holiday', () => {
    const s = { frequency: 'daily' as const, weekday: null, time: '09:00' };
    assert.equal(scheduledDigestDue({ ...WORK, holidays: new Set(['2026-11-20']) }, s, at(20, 10), null), null);
  });
  test('weekly is due on the chosen weekday, or the working day before when that is a holiday', () => {
    const s = { frequency: 'weekly' as const, weekday: 5, time: '09:00' }; // Friday
    assert.equal(scheduledDigestDue(WORK, s, at(19, 10), null), null);
    assert.equal(scheduledDigestDue(WORK, s, at(20, 10), null), '2026-11-20');
    const hol = { ...WORK, holidays: new Set(['2026-11-20']) };
    assert.equal(scheduledDigestDue(hol, s, at(19, 10), null), '2026-11-19');
    assert.equal(scheduledDigestDue(hol, s, at(20, 10), null), null);
  });
  test('weekly on a Monday holiday goes to the Friday before', () => {
    const s = { frequency: 'weekly' as const, weekday: 1, time: '09:00' };
    const hol = { ...WORK, holidays: new Set(['2026-11-23']) };
    assert.equal(scheduledDigestDue(hol, s, at(20, 10), null), '2026-11-20');
    assert.equal(scheduledDigestDue(hol, s, at(23, 10), null), null);
  });
});

describe('asAtLine', () => {
  test('names the date and time in UTC+8', () => {
    assert.equal(asAtLine(at(17, 9)), 'As at Tue 17 Nov 2026, 09:00 (UTC+8)');
  });
});

describe('building a digest', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let pool: Pool;
  const ids: Record<string, string> = {};
  let projectId: string;

  before(async () => {
    t = await startTestApp();
    pool = t.pool;
    for (const p of ['pm', 'owner', 'ann', 'bob', 'cat', 'audit', 'held', 'away', 'quiet', 'gone']) ids[p] = await seedUser(pool, `${p}@example.org`);
    projectId = await seedProject(pool, {
      status: 'active',
      name: 'Harbour Works',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.ann, role: 'member' },
        { userId: ids.bob, role: 'member' },
        { userId: ids.held, role: 'member' },
        { userId: ids.away, role: 'member' },
        { userId: ids.quiet, role: 'member' },
        { userId: ids.gone, role: 'member' },
      ],
    });
    await pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision)
       VALUES ($1, $2, $3, 'audit', 'Review', 'Tasks', '2026-11-01', '2026-12-31', $4, now(), 'approved')`,
      [uuidv7(), projectId, ids.audit, ids.owner],
    );
    await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [ids.gone]);
    await pool.query(`UPDATE memberships SET held_at = now() WHERE project_id = $1 AND user_id = $2`, [projectId, ids.held]);
    await pool.query(`INSERT INTO away_periods (id, user_id, starts_on, ends_on, created_at) VALUES ($1, $2, '2026-11-15', '2026-11-20', now())`, [uuidv7(), ids.away]);
    await pool.query(`INSERT INTO email_preferences (user_id, project_id, choice, updated_at) VALUES ($1, $2, 'off', now())`, [ids.quiet, projectId]);
  });
  after(async () => {
    await t?.close();
  });

  const task = async (title: string, assignee: string, dueOn: string, o: { status?: string; parent?: string; review?: boolean } = {}) => {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO tasks (id, project_id, parent_id, depth, title, assignee_id, due_on, status, authorised_by, authorised_at, deadline_review_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6, '2026-11-01T00:00:00Z', $9)`,
      [id, projectId, o.parent ?? null, o.parent ? 1 : 0, title, assignee, dueOn, o.status ?? 'not_started', o.review ?? false],
    );
    return id;
  };

  test('own tasks first with overdue first; others grouped by assignee; closed work absent; markers and links', async () => {
    const later = await task('Later own task', ids.ann, '2026-11-27');
    const sooner = await task('Sooner own task', ids.ann, '2026-11-24', { status: 'in_progress' });
    const overdue = await task('Overdue own task', ids.ann, '2026-11-12', { status: 'blocked' });
    const sub = await task('Own subtask', ids.ann, '2026-11-25', { parent: later, review: true });
    await task('Finished task', ids.ann, '2026-11-12', { status: 'completed' });
    await task('Dropped task', ids.bob, '2026-11-12', { status: 'cancelled' });
    await task('Bob late', ids.bob, '2026-11-30');
    await task('Bob early', ids.bob, '2026-11-18');
    await task('Pat task', ids.pm, '2026-11-19');

    const d = await buildDigest(pool, projectId, ids.ann, at(17, 9), 'https://kainow.example.org/');
    assert.equal(d.subject, 'Action items: Harbour Works');
    assert.equal(d.openCount, 7);
    const lines = d.body.split('\n');
    assert.equal(lines[1], 'As at Tue 17 Nov 2026, 09:00 (UTC+8)');
    const at_ = (s: string) => d.body.indexOf(s);
    assert.ok(at_('Your open tasks') < at_('Overdue own task') && at_('Overdue own task') < at_('Sooner own task'));
    assert.ok(at_('Sooner own task') < at_('Own subtask') && at_('Own subtask') < at_('Later own task'));
    assert.ok(at_('Later own task') < at_('Other open tasks in this project'));
    // Others grouped by assignee name (bob before pm), by due date within a group.
    assert.ok(at_('Bob early') < at_('Bob late') && at_('Bob late') < at_('Pat task'));
    assert.ok(!d.body.includes('Finished task') && !d.body.includes('Dropped task'));
    const overdueLines = d.body.split('\n').filter((l) => l.startsWith('  Assignee') && l.includes('Overdue'));
    assert.equal(overdueLines.length, 1, 'only the one past-due open task of the recipient is marked');
    assert.match(d.body, /Status: Blocked; Overdue/);
    assert.match(d.body, /Own subtask[\s\S]*?Status: Not started; Deadline review required/);
    assert.ok(d.body.includes(`https://kainow.example.org/#/projects/${projectId}/work/${overdue}`));
    assert.ok(d.body.includes(`/work/${sooner}`) && d.body.includes(`/work/${sub}`));
    assert.ok(!/Bob (late|early)[\s\S]{0,80}Overdue/.test(d.body));
    for (const banned of ['proposal', 'risk', 'decision', 'question']) assert.ok(!d.body.toLowerCase().includes(banned), banned);
  });

  test('a recipient with no tasks sees the other tasks only, and an empty project counts zero', async () => {
    const d = await buildDigest(pool, projectId, ids.cat, at(17, 9));
    assert.match(d.body, /Your open tasks\nNone\n/);
    assert.ok(d.openCount > 0);
    const empty = await seedProject(pool, { status: 'active', name: 'Empty', members: [{ userId: ids.pm, role: 'pm' }] });
    assert.equal((await buildDigest(pool, empty, ids.pm, at(17, 9))).openCount, 0);
  });

  test('recipients: holders only, minus On Hold and people away today; email preference off still counts', async () => {
    const on17 = (await digestRecipients(pool, projectId, '2026-11-17')).map((r) => r.userId).sort();
    assert.deepEqual(on17, [ids.pm, ids.owner, ids.ann, ids.bob, ids.quiet].sort());
    const on21 = (await digestRecipients(pool, projectId, '2026-11-21')).map((r) => r.userId);
    assert.ok(on21.includes(ids.away), 'away ends the day before');
    assert.ok(!on21.includes(ids.audit) && !on21.includes(ids.held));
    assert.ok(!on17.includes(ids.gone) && !on17.includes(ids.held) && !on17.includes(ids.away) && !on17.includes(ids.audit));
  });
});
