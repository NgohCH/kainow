/**
 * Update notices to everyone (10b spec 6.4): one queued email per Active account, with the organisation's branding
 * (writeOutbox composes the letterhead), ignoring personal notification preferences like sign-in codes do, and never in
 * digests. Also the day-before email, sent once per start time by the ops sweep.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { writeOutbox } from '../email/outbox';
import { shortDate } from '../notifications/summaries';
import { reminderDue } from './states';

export type PeopleMailKind = 'update_scheduled' | 'update_rescheduled' | 'update_cancelled' | 'update_reminder';

/** What the emails and the banner need of an update. */
export interface ScheduledUpdate {
  id: string;
  startsAt: Date;
  expectedMinutes: number;
}

const UTC8_MS = 8 * 3_600_000;

/** The start as words in UTC+8: { date: 'Mon 30 Nov', time: '22:00' }. */
export function whenWords(at: Date): { date: string; time: string } {
  const iso = new Date(at.getTime() + UTC8_MS).toISOString();
  return { date: shortDate(iso.slice(0, 10)), time: iso.slice(11, 16) };
}

/** The approval (and day-before) email text, fixed (globals). */
export function approvalText(u: ScheduledUpdate): string {
  const { date, time } = whenWords(u.startsAt);
  return `Kainow will be unavailable on ${date} from ${time} (UTC+8) for about ${u.expectedMinutes} minutes while it is updated. Anything you save before then is kept.`;
}

/** The banner for every signed-in person, from approval until the update starts (fixed, globals). */
export function scheduledBannerText(u: ScheduledUpdate): string {
  const { date, time } = whenWords(u.startsAt);
  return `Kainow will be unavailable on ${date} from ${time} for about ${u.expectedMinutes} minutes for an update.`;
}

export function peopleMail(kind: PeopleMailKind, u: ScheduledUpdate): { subject: string; body: string } {
  const { date, time } = whenWords(u.startsAt);
  switch (kind) {
    case 'update_scheduled':
      return { subject: `Kainow update on ${date} from ${time} (UTC+8)`, body: approvalText(u) };
    case 'update_reminder':
      return { subject: `Reminder: Kainow update on ${date} from ${time} (UTC+8)`, body: approvalText(u) };
    case 'update_rescheduled':
      return { subject: `New time for the Kainow update: ${date} from ${time} (UTC+8)`, body: `The Kainow update has a new time. ${approvalText(u)}` };
    case 'update_cancelled':
      return {
        subject: 'Kainow update cancelled',
        body: `The Kainow update planned for ${date} from ${time} (UTC+8) is cancelled. Kainow stays available as usual.`,
      };
  }
}

/**
 * One outbox row per account with users.status = 'active' (accounts able to sign in). Invited and disabled accounts get
 * nothing. Uses the caller's transaction. Returns the number of rows queued.
 */
export async function mailEveryone(client: PoolClient, kind: PeopleMailKind, u: ScheduledUpdate, now: Date): Promise<number> {
  const { subject, body } = peopleMail(kind, u);
  const people = (await client.query(`SELECT id, email FROM users WHERE status = 'active' ORDER BY id`)).rows as Array<{ id: string; email: string }>;
  for (const p of people) {
    await writeOutbox(client, { toUserId: p.id, toAddress: p.email, subject, body, kind, projectId: null, initiatedBy: 'system', now });
  }
  return people.length;
}

/**
 * The day-before emails. The "approved more than 24 hours ahead" rule counts from the latest decision on the time
 * (approval or reschedule), so a time moved to less than a day ahead gets no reminder (its own email said it).
 * reminder_sent_at is set in the same transaction as the emails, so each start time gets the email at most once.
 */
export async function sendDueReminders(pool: Pool, now: Date): Promise<number> {
  const client = await pool.connect();
  let broken = false;
  let sent = 0;
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.updates'))`);
      const rows = (
        await client.query(
          `SELECT u.id, u.starts_at, u.expected_minutes, u.reminder_sent_at,
                  (SELECT max(c.at) FROM update_changes c WHERE c.update_id = u.id AND c.action IN ('approved', 'rescheduled')) AS decided_at,
                  u.approved_at
             FROM updates u
            WHERE u.state IN ('approved', 'preparing', 'ready') AND u.reminder_sent_at IS NULL
            ORDER BY u.starts_at, u.id
            FOR UPDATE OF u`,
        )
      ).rows;
      for (const r of rows) {
        const decidedAt = (r.decided_at as Date | null) ?? (r.approved_at as Date);
        if (!reminderDue({ approvedAt: decidedAt, startsAt: r.starts_at, reminderSentAt: r.reminder_sent_at }, now)) continue;
        const u: ScheduledUpdate = { id: r.id, startsAt: r.starts_at, expectedMinutes: r.expected_minutes };
        await mailEveryone(client, 'update_reminder', u, now);
        await client.query(`UPDATE updates SET reminder_sent_at = $2 WHERE id = $1`, [u.id, now]);
        await client.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, detail) VALUES ($1, $2, $3, 'reminded', NULL, $4)`, [
          uuidv7(now.getTime()),
          u.id,
          now,
          JSON.stringify({ startsAt: u.startsAt }),
        ]);
        sent += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    client.release(broken);
  }
  return sent;
}
