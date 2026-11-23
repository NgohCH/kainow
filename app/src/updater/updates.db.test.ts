import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadDatabaseConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { runOpsSweep } from '../ops/sweep-ops';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../testing/db';
import { seedOrganisation, seedUser } from '../testing/projects';
import { approvalText, scheduledBannerText, sendDueReminders } from './people-mail';
import { approveUpdate, cancelUpdate, rescheduleUpdate, scheduledBanner } from './updates.service';

const migrationsDir = loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir;
const NOW = new Date('2026-12-01T04:00:00Z'); // 12:00 in UTC+8
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RUNNING = '1.0.0';
const COMMIT = 'a'.repeat(40);
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

const statusOf = (e: unknown): number | undefined => (e as { getStatus?: () => number }).getStatus?.();
const responseOf = (e: unknown): any => (e as { getResponse?: () => unknown }).getResponse?.();

async function refused(p: Promise<unknown>): Promise<{ status: number | undefined; body: any }> {
  try {
    await p;
  } catch (e) {
    return { status: statusOf(e), body: responseOf(e) };
  }
  assert.fail('expected a refusal');
}

describe('approving, rescheduling and cancelling updates', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  let admin: string;
  let member: string;
  let disabled: string;
  let invited: string;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, migrationsDir);
    admin = await seedUser(pool, 'upd6-admin@example.org', 'enterprise_administrator');
    member = await seedUser(pool, 'upd6-member@example.org');
    disabled = await seedUser(pool, 'upd6-disabled@example.org');
    invited = await seedUser(pool, 'upd6-invited@example.org');
    await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [disabled]);
    await pool.query(`UPDATE users SET status = 'invited' WHERE id = $1`, [invited]);
    await seedOrganisation(pool);
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    // The update history is append-only; tests start from nothing, so the triggers are skipped for this cleanup only.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      for (const t of ['update_steps', 'update_changes', 'updates', 'email_outbox', 'notifications', 'backup_runs', 'releases_seen', 'audit_events']) {
        await c.query(`DELETE FROM ${t}`);
      }
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await pool.query(`UPDATE operations_state SET protective = false, reason = NULL, since = NULL`);
    await backup(at(-2 * HOUR));
    await pool.query(`INSERT INTO releases_seen (tag, commit, first_seen_at, notified_at) VALUES ('v1.1.0', $1, $2, $2)`, [COMMIT, at(-DAY)]);
  });

  async function backup(finishedAt: Date) {
    await pool.query(
      `INSERT INTO backup_runs (id, kind, started_at, finished_at, outcome, set_name, folder_label, key_id, database_bytes, files_total, files_new, source_area)
       VALUES ($1, 'daily', $2, $3, 'succeeded', 'set-1', 'backup-disk-1', 'key-aa11', 1000, 3, 1, 'not_in_use')`,
      [uuidv7(), new Date(finishedAt.getTime() - 10 * MIN), finishedAt],
    );
  }
  const approve = (over: Record<string, unknown> = {}, now = NOW) =>
    approveUpdate(pool, admin, { tag: 'v1.1.0', startsAt: at(3 * DAY).toISOString(), expectedMinutes: 45, reason: 'Security fixes', ...over }, now, RUNNING);
  const mail = async (kind: string) =>
    (await pool.query(`SELECT to_user_id, to_address, subject, text_body, kind FROM email_outbox WHERE kind = $1 ORDER BY to_address`, [kind])).rows;
  const audits = async (action: string) => (await pool.query(`SELECT actor_user_id, subject_id, detail FROM audit_events WHERE action = $1`, [action])).rows;

  test('approve records tag, commit, start, length, reason, approver, update_changes row and audit ops.update_approved', async () => {
    const v = await approve();
    assert.equal(v.state, 'approved');
    assert.equal(v.tag, 'v1.1.0');
    assert.equal(v.commit, COMMIT);
    assert.equal(v.fromVersion, '1.0.0');
    assert.equal(v.toVersion, '1.1.0');
    assert.equal(v.startsAt.toISOString(), at(3 * DAY).toISOString());
    assert.equal(v.expectedMinutes, 45);
    assert.equal(v.reason, 'Security fixes');
    assert.equal(v.approvedBy.id, admin);
    assert.equal(v.approvedAt.toISOString(), NOW.toISOString());
    const changes = (await pool.query(`SELECT action, actor_id, reason, detail FROM update_changes WHERE update_id = $1`, [v.id])).rows;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, 'approved');
    assert.equal(changes[0].actor_id, admin);
    assert.equal(changes[0].reason, 'Security fixes');
    assert.equal(changes[0].detail.commit, COMMIT);
    const a = await audits('ops.update_approved');
    assert.equal(a.length, 1);
    assert.equal(a[0].actor_user_id, admin);
    assert.equal(a[0].subject_id, v.id);
    assert.equal(a[0].detail.reason, 'Security fixes');
    assert.equal(a[0].detail.tag, 'v1.1.0');
  });

  // "On hold" is a project membership, not an account status: account status alone decides who is emailed (final review #13).
  test('approve emails every Active account and nobody disabled or invited', async () => {
    await approve();
    const rows = await mail('update_scheduled');
    assert.deepEqual(rows.map((r) => r.to_user_id).sort(), [admin, member].sort());
    assert.ok(!rows.some((r) => r.to_user_id === disabled || r.to_user_id === invited));
    const text = 'Kainow will be unavailable on Fri 4 Dec from 12:00 (UTC+8) for about 45 minutes while it is updated. Anything you save before then is kept.';
    assert.equal(approvalText({ id: 'x', startsAt: at(3 * DAY), expectedMinutes: 45 }), text);
    for (const r of rows) assert.ok(r.text_body.includes(text), r.text_body);
  });

  test('approve is refused without a successful backup younger than 24 h', async () => {
    await pool.query(`DELETE FROM backup_runs`);
    await backup(at(-25 * HOUR));
    const r = await refused(approve());
    assert.equal(r.status, 409);
    assert.equal(r.body.message, 'Updates are refused until a backup succeeds. See Backups above.');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM updates`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM email_outbox`)).rows[0].n, 0);
  });

  test('approve is refused while protective mode is on', async () => {
    await pool.query(`UPDATE operations_state SET protective = true, reason = 'low_space', since = $1`, [NOW]);
    const r = await refused(approve());
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'protective_on');
  });

  test('approve is refused when another update is open', async () => {
    await approve();
    const r = await refused(approve());
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'update_open');
  });

  test('approve is refused when the latest update is failed_after_migration', async () => {
    const v = await approve();
    await pool.query(`UPDATE updates SET state = 'failed_after_migration' WHERE id = $1`, [v.id]);
    const r = await refused(approve());
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'needs_recovery');
  });

  test('approve is refused for a tag that is not newer, and for one that is not the newest available', async () => {
    const r = await refused(approve({ tag: 'v1.0.0' }));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'not_newer');
    await pool.query(`INSERT INTO releases_seen (tag, commit, first_seen_at, notified_at) VALUES ('v1.0.5', $1, $2, $2)`, ['b'.repeat(40), at(-2 * DAY)]);
    const n = await refused(approve({ tag: 'v1.0.5' }));
    assert.equal(n.status, 409);
    assert.equal(n.body.code, 'not_newest_available');
  });

  test('approve: a window too close, too far or with a bad length is 400; an empty reason is 400', async () => {
    assert.equal((await refused(approve({ startsAt: at(10 * MIN).toISOString() }))).status, 400);
    assert.equal((await refused(approve({ startsAt: at(31 * DAY).toISOString() }))).status, 400);
    assert.equal((await refused(approve({ expectedMinutes: 241 }))).status, 400);
    assert.equal((await refused(approve({ reason: '  ' }))).status, 400);
    const v = await approve({ expectedMinutes: undefined });
    assert.equal(v.expectedMinutes, 30, 'default length');
  });

  test('cancel emails everyone and is refused once installing', async () => {
    const v = await approve();
    const later = at(HOUR);
    const c = await cancelUpdate(pool, admin, v.id, { reason: 'Clash with month end' }, later);
    assert.equal(c.state, 'cancelled');
    assert.equal(c.cancelReason, 'Clash with month end');
    assert.equal(c.cancelledBy?.id, admin);
    const rows = await mail('update_cancelled');
    assert.deepEqual(rows.map((r) => r.to_user_id).sort(), [admin, member].sort());
    const ch = (await pool.query(`SELECT reason FROM update_changes WHERE update_id = $1 AND action = 'cancelled'`, [v.id])).rows;
    assert.deepEqual(ch, [{ reason: 'Clash with month end' }]);
    assert.equal((await audits('ops.update_cancelled')).length, 1);
    assert.equal(await scheduledBanner(pool, later), null);

    const w = await approve({}, later);
    await pool.query(`UPDATE updates SET state = 'installing' WHERE id = $1`, [w.id]);
    const r = await refused(cancelUpdate(pool, admin, w.id, { reason: 'Too late' }, later));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'not_changeable');
    const s = await refused(rescheduleUpdate(pool, admin, w.id, { startsAt: at(5 * DAY).toISOString(), expectedMinutes: 30, reason: 'Too late' }, later));
    assert.equal(s.status, 409);
    assert.equal((await mail('update_cancelled')).length, 2, 'no new email for a refused cancel');
  });

  test('reschedule emails everyone; the day-before email still goes once', async () => {
    const v = await approve(); // start NOW + 3 days
    assert.equal(await sendDueReminders(pool, at(2 * DAY - MIN)), 0, 'not yet');
    assert.equal(await sendDueReminders(pool, at(2 * DAY)), 1, 'at T-24h');
    assert.equal(await sendDueReminders(pool, at(2 * DAY + HOUR)), 0, 'once');
    assert.deepEqual((await mail('update_reminder')).map((r) => r.to_user_id).sort(), [admin, member].sort());

    // Moved to 4 days from now (beyond 24 hours): the reminder is due again for the new start.
    const movedAt = at(2 * DAY + 2 * HOUR);
    const newStart = new Date(movedAt.getTime() + 4 * DAY);
    const r = await rescheduleUpdate(pool, admin, v.id, { startsAt: newStart.toISOString(), expectedMinutes: 60, reason: 'Moved to the weekend' }, movedAt);
    assert.equal(r.startsAt.toISOString(), newStart.toISOString());
    assert.equal(r.expectedMinutes, 60);
    assert.equal(r.reminderSentAt, null);
    const moved = await mail('update_rescheduled');
    assert.deepEqual(moved.map((x) => x.to_user_id).sort(), [admin, member].sort());
    assert.ok(moved[0].text_body.includes(approvalText({ id: v.id, startsAt: newStart, expectedMinutes: 60 })));
    assert.equal((await pool.query(`SELECT reason FROM update_changes WHERE update_id = $1 AND action = 'rescheduled'`, [v.id])).rows[0].reason, 'Moved to the weekend');
    assert.equal((await audits('ops.update_rescheduled')).length, 1);

    // The sweep runs the reminders: nothing until the new T-24h, then once.
    await runOpsSweep(pool, new Date(newStart.getTime() - DAY - MIN));
    assert.equal((await mail('update_reminder')).length, 2);
    await runOpsSweep(pool, new Date(newStart.getTime() - DAY));
    assert.equal((await mail('update_reminder')).length, 4);
    await runOpsSweep(pool, new Date(newStart.getTime() - DAY + HOUR));
    assert.equal((await mail('update_reminder')).length, 4, 'never two for the same start');

    // Moved to less than 24 hours ahead after the reminder: the reschedule email says it; no further reminder.
    const lateMove = new Date(newStart.getTime() - DAY + 2 * HOUR);
    await rescheduleUpdate(pool, admin, v.id, { startsAt: new Date(lateMove.getTime() + 20 * HOUR).toISOString(), expectedMinutes: 60, reason: 'Earlier' }, lateMove);
    assert.equal(await sendDueReminders(pool, new Date(lateMove.getTime() + HOUR)), 0);
  });

  test('sendDueReminders sends nothing for an approval made 23 h ahead', async () => {
    await approve({ startsAt: at(23 * HOUR).toISOString() });
    for (const h of [0, 1, 12, 22]) assert.equal(await sendDueReminders(pool, at(h * HOUR)), 0);
    assert.equal((await mail('update_reminder')).length, 0);
  });

  test('the scheduled banner shows from approval until the start', async () => {
    const v = await approve();
    const b = await scheduledBanner(pool, NOW);
    assert.equal(b?.text, 'Kainow will be unavailable on Fri 4 Dec from 12:00 for about 45 minutes for an update.');
    assert.equal(b?.text, scheduledBannerText(v));
    assert.equal(await scheduledBanner(pool, at(3 * DAY)), null, 'not once the start has come');
  });
});
