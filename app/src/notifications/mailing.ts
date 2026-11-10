// Notice emails (spec §6, §6.1): one per person per project, timed by that person's choice, never on an away date.
// Each notification is emailed once: the outbox row that carried it is recorded on it in the same transaction.
import type { Pool } from 'pg';
import type { Relevance } from '../email/relevance';
import { noticeEmail } from '../email/notice';
import { writeOutbox } from '../email/outbox';
import { todayUtc8 } from '../projects/membership';
import { type Calendar, isWorkingDay, nextSlot, slotOn } from './calendar';
import { inTransaction } from './fire';
import { loadEffective } from './settings';
import { emailLine } from './summaries';

export type EmailChoice = 'daily_urgent_immediate' | 'immediate' | 'daily' | 'off';

interface Candidate {
  id: string;
  userId: string;
  projectId: string;
  urgent: boolean;
  summary: string;
  link: string | null;
  triggerId: string;
  fireAt: Date;
  recordKind: string;
  recordId: string;
  detail: Record<string, unknown> | null;
  minimal: boolean;
  projectName: string;
  email: string;
  choice: EmailChoice;
  away: boolean;
  /** The person was away on the day (UTC+8) the trigger fired: the notice waits for the first daily email after. */
  firedAway: boolean;
  projectActive: boolean;
  /** Fired before the project's latest return to Active from Deferred or Closed (the resumption summary replaces it). */
  beforeResumption: boolean;
}

/** What must still hold for a line to be worth sending (rechecked by the dispatcher before every attempt). */
export function checkFor(c: Pick<Candidate, 'recordKind' | 'recordId' | 'projectId' | 'detail'>): Relevance {
  const d = c.detail ?? {};
  if (c.recordKind === 'task') return { kind: 'task', taskId: c.recordId, dueOn: String(d.dueOn), reopenCount: Number(d.reopenCount ?? 0) };
  if (c.recordKind === 'risk') return { kind: 'risk', riskId: c.recordId, reviewOn: String(d.reviewOn) };
  return { kind: 'project_active', projectId: c.projectId };
}

/**
 * When a row may be emailed: at its fire time if the choice sends it at once, otherwise with the project's 09:00
 * email, which only goes out on a working day once that day's 09:00 has come (so a catch-up waits for 09:00).
 * An urgent notice that fired while the person was away is caught up with that daily email, not at the first sweep
 * after the away period; only "Every notice immediately" uses the first sweep (spec §6.1).
 */
export function sendable(
  choice: EmailChoice, urgent: boolean, fireAt: Date, cal: Calendar, now: Date, firedAway = false,
): { ok: boolean; atOnce: boolean } {
  if (choice === 'off') return { ok: false, atOnce: false };
  const atOnce = choice === 'immediate' || (choice === 'daily_urgent_immediate' && urgent && !firedAway);
  if (atOnce) return { ok: fireAt.getTime() <= now.getTime(), atOnce };
  const today = todayUtc8(now);
  const slotOpen = isWorkingDay(cal, today) && now.getTime() >= slotOn(today).getTime();
  return { ok: slotOpen && nextSlot(cal, fireAt).getTime() <= now.getTime(), atOnce };
}

/** Queues the notice emails that are due now. Returns how many were written; the caller nudges the dispatcher. */
export async function mailDue(pool: Pool, now: Date, appUrl: string): Promise<number> {
  const today = todayUtc8(now);
  const rows = (
    await pool.query(
      `SELECT n.id, n.user_id AS "userId", n.project_id AS "projectId", n.urgent, n.summary, n.link, n.trigger_id AS "triggerId",
              t.fire_at AS "fireAt", t.record_kind AS "recordKind", t.record_id AS "recordId", t.detail,
              COALESCE((t.detail->>'minimal')::boolean, false) AS minimal,
              p.name AS "projectName", u.email, COALESCE(ep.choice, 'daily_urgent_immediate') AS choice,
              EXISTS (SELECT 1 FROM away_periods a WHERE a.user_id = n.user_id AND a.removed_at IS NULL
                         AND a.starts_on <= $1::date AND a.ends_on >= $1::date) AS away,
              EXISTS (SELECT 1 FROM away_periods a WHERE a.user_id = n.user_id AND a.removed_at IS NULL
                         AND a.starts_on <= ((t.fire_at AT TIME ZONE 'UTC') + interval '8 hours')::date
                         AND a.ends_on >= ((t.fire_at AT TIME ZONE 'UTC') + interval '8 hours')::date) AS "firedAway",
              p.status = 'active' AS "projectActive",
              COALESCE(t.fire_at < (SELECT max(pt.at) FROM project_transitions pt
                                     WHERE pt.project_id = p.id AND pt.to_status = 'active' AND pt.from_status IN ('deferred', 'closed')),
                       false) AS "beforeResumption"
         FROM notifications n
         JOIN notification_triggers t ON t.id = n.trigger_id
         JOIN projects p ON p.id = n.project_id
         JOIN users u ON u.id = n.user_id
         LEFT JOIN email_preferences ep ON ep.user_id = n.user_id AND ep.project_id = n.project_id
        WHERE n.outbox_id IS NULL AND NOT n.email_off
        ORDER BY n.user_id, n.project_id, t.fire_at, n.created_at, n.id`,
      [today],
    )
  ).rows as Candidate[];

  // Never emailed: rows while the choice is Off (nothing is caught up later), and rows that fired before the project
  // was paused and resumed (D24: the resumption summary covers them). Marking them stops them being candidates.
  // The minimal Administrator fallback is exempt from the project-state rules.
  const never = rows.filter((r) => r.choice === 'off' || (!r.minimal && r.beforeResumption));
  if (never.length > 0) {
    await pool.query(`UPDATE notifications SET email_off = true WHERE id = ANY($1::uuid[]) AND outbox_id IS NULL`, [never.map((r) => r.id)]);
  }
  const neverIds = new Set(never.map((r) => r.id));

  const groups = new Map<string, Candidate[]>();
  for (const r of rows) {
    if (neverIds.has(r.id) || r.away) continue;
    if (!r.minimal && !r.projectActive) continue; // held while the project is not Active
    // The minimal Administrator fallback goes in its own email, checked against the Administrator role.
    const k = `${r.userId}|${r.projectId}|${r.minimal}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const calendars = new Map<string, Calendar>();
  const calendarOf = async (projectId: string): Promise<Calendar> => {
    let cal = calendars.get(projectId);
    if (!cal) {
      cal = (await loadEffective(pool, projectId)).cal;
      calendars.set(projectId, cal);
    }
    return cal;
  };

  let written = 0;
  for (const group of groups.values()) {
    const cal = await calendarOf(group[0].projectId);
    const due = group
      .map((r) => ({ r, s: sendable(r.choice, r.urgent, r.fireAt, cal, now, r.firedAway) }))
      .filter((x) => x.s.ok);
    if (due.length === 0) continue;
    written += await inTransaction(pool, async (c) => {
      // Lock and recheck: a concurrent sweep may have carried some of these rows already.
      const still = new Set(
        (
          await c.query(`SELECT id FROM notifications WHERE id = ANY($1::uuid[]) AND outbox_id IS NULL AND NOT email_off FOR UPDATE`, [
            due.map((x) => x.r.id),
          ])
        ).rows.map((x: { id: string }) => x.id),
      );
      const carried = due.filter((x) => still.has(x.r.id));
      if (carried.length === 0) return 0;
      const first = carried[0].r;
      const items = carried.map(({ r }) => ({
        triggerId: r.triggerId,
        projectId: r.projectId,
        check: checkFor(r),
        line: emailLine(r.summary, appUrl, r.link),
      }));
      const notice = noticeEmail(first.projectName, items.map((i) => i.line));
      const outboxId = await writeOutbox(c, {
        toUserId: first.userId,
        toAddress: first.email,
        subject: notice.subject,
        body: notice.body,
        kind: 'notice',
        projectId: first.projectId,
        initiatedBy: carried.every((x) => x.s.atOnce) ? 'trigger' : 'schedule',
        triggerIds: items.map((i) => i.triggerId),
        relevance: { scope: first.minimal ? 'admin' : 'project', projectName: first.projectName, items },
        now,
      });
      await c.query(`UPDATE notifications SET outbox_id = $1 WHERE id = ANY($2::uuid[])`, [outboxId, carried.map((x) => x.r.id)]);
      return 1;
    });
  }
  return written;
}
