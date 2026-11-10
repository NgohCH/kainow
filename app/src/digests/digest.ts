// Action-item digests (spec §8): the content built per recipient, the schedule rule, and the scheduled send.
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import type { EmailRelevance } from '../email/relevance';
import { writeOutbox } from '../email/outbox';
import { type Calendar, isWorkingDay, stepBackWorking } from '../notifications/calendar';
import { loadHolders } from '../notifications/recipients';
import type { DigestSchedule } from '../notifications/settings';
import { todayUtc8 } from '../projects/membership';

type Db = Pool | PoolClient;

export const NOTHING_TO_SEND = 'Nothing to send: no open tasks';
export const SEND_REFUSAL = 'Only the Project Manager, Owner or a Sponsor can send action-item emails, and only while the project is Active.';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS_LABEL: Record<string, string> = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked' };

const dateMs = (d: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`Invalid date: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const msDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** "Fri 20 Nov 2026" for a YYYY-MM-DD date. */
export function longDate(d: string): string {
  const dt = new Date(dateMs(d));
  return `${WEEKDAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/** "As at Mon 17 Nov 2026, 09:00 (UTC+8)". */
export function asAtLine(asAt: Date): string {
  const shifted = new Date(asAt.getTime() + 8 * 3_600_000);
  return `As at ${longDate(msDate(shifted.getTime()))}, ${shifted.toISOString().slice(11, 16)} (UTC+8)`;
}

interface OpenTask {
  id: string;
  title: string;
  assigneeId: string;
  assignee: string;
  dueOn: string;
  status: string;
  review: boolean;
}

async function openTasks(db: Db, projectId: string): Promise<OpenTask[]> {
  const r = await db.query(
    `SELECT t.id, t.title, t.assignee_id AS "assigneeId", u.display_name AS name, u.email,
            to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn", t.status, t.deadline_review_required AS review
       FROM tasks t JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = $1 AND t.status IN ('not_started', 'in_progress', 'blocked')`,
    [projectId],
  );
  return r.rows.map((x) => ({
    id: x.id, title: x.title, assigneeId: x.assigneeId, assignee: ((x.name as string | null) ?? '').trim() || x.email,
    dueOn: x.dueOn, status: x.status, review: x.review,
  }));
}

/** The number of open tasks in the project (not per recipient). */
export async function countOpen(db: Db, projectId: string): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND status IN ('not_started', 'in_progress', 'blocked')`, [projectId]);
  return r.rows[0].n;
}

const byDue = (a: OpenTask, b: OpenTask): number =>
  a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

export async function buildDigest(
  db: Db,
  projectId: string,
  recipientId: string,
  asAt: Date,
  appUrl = '',
): Promise<{ subject: string; body: string; openCount: number }> {
  const name = (await db.query(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0].name as string;
  const today = todayUtc8(asAt);
  const tasks = await openTasks(db, projectId);
  const base = appUrl.replace(/\/+$/, '');
  const line = (t: OpenTask): string => {
    const marks = [t.dueOn < today ? 'Overdue' : '', t.review ? 'Deadline review required' : ''].filter(Boolean);
    return [
      `- ${t.title}`,
      `  Assignee: ${t.assignee}; Due: ${longDate(t.dueOn)}; Status: ${STATUS_LABEL[t.status] ?? t.status}${marks.length ? `; ${marks.join('; ')}` : ''}`,
      `  ${base}/#/projects/${projectId}/work/${t.id}`,
    ].join('\n');
  };
  const own = tasks
    .filter((t) => t.assigneeId === recipientId)
    .sort((a, b) => Number(b.dueOn < today) - Number(a.dueOn < today) || byDue(a, b));
  const groups = new Map<string, { assignee: string; list: OpenTask[] }>();
  for (const t of tasks.filter((x) => x.assigneeId !== recipientId)) {
    const g = groups.get(t.assigneeId) ?? { assignee: t.assignee, list: [] };
    g.list.push(t);
    groups.set(t.assigneeId, g);
  }
  const others = [...groups.values()].sort((a, b) => a.assignee.localeCompare(b.assignee));

  const parts = [name, asAtLine(asAt), '', 'Your open tasks', own.length ? own.map(line).join('\n') : 'None', '', 'Other open tasks in this project'];
  if (others.length === 0) parts.push('None');
  for (const g of others) parts.push(g.assignee, ...g.list.sort(byDue).map(line));
  return { subject: `Action items: ${name}`, body: parts.join('\n'), openCount: tasks.length };
}

export interface DigestRecipient { userId: string; email: string }

/** Holders of an Active project role today with an Active account, minus people away today. An 'off' notice choice still receives digests. */
export async function digestRecipients(db: Db, projectId: string, today: string): Promise<DigestRecipient[]> {
  const holders = await loadHolders(db, projectId, today);
  if (holders.length === 0) return [];
  const r = await db.query(
    `SELECT u.id AS "userId", u.email FROM users u
      WHERE u.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM away_periods a WHERE a.user_id = u.id AND a.removed_at IS NULL
                          AND a.starts_on <= $2::date AND a.ends_on >= $2::date)
      ORDER BY u.id`,
    [holders.map((h) => h.userId), today],
  );
  return r.rows;
}

export const digestRelevance = (projectId: string): EmailRelevance => ({ kind: 'project_active', projectId, scope: 'project' });

/** Queues one digest email per recipient in the caller's transaction and records the run. Returns the run id. */
export async function queueDigestRun(
  c: PoolClient,
  o: { projectId: string; recipients: DigestRecipient[]; asAt: Date; scheduled: boolean; initiatedBy: string | null; appUrl: string },
): Promise<string> {
  const runId = uuidv7();
  await c.query(
    `INSERT INTO digest_runs (id, project_id, initiated_by_user, scheduled, as_at, recipient_count) VALUES ($1, $2, $3, $4, $5, $6)`,
    [runId, o.projectId, o.initiatedBy, o.scheduled, o.asAt, o.recipients.length],
  );
  for (const r of o.recipients) {
    const d = await buildDigest(c, o.projectId, r.userId, o.asAt, o.appUrl);
    await writeOutbox(c, {
      toUserId: r.userId, toAddress: r.email, subject: d.subject, body: d.body, kind: 'digest', projectId: o.projectId,
      initiatedBy: 'digest', ...(o.initiatedBy ? { initiatedByUser: o.initiatedBy } : {}), digestRunId: runId,
      relevance: digestRelevance(o.projectId), now: o.asAt,
    });
  }
  return runId;
}

/**
 * The date (YYYY-MM-DD, UTC+8) a scheduled digest is due for at `now`, or null. Daily: today when it is a working day
 * (every day in Calendar mode). Weekly: the chosen weekday, or the working day before when that is not a working day.
 * Due from the chosen time on that date, once; earlier dates are never caught up.
 */
export function scheduledDigestDue(cal: Calendar, schedule: DigestSchedule, now: Date, lastSentDate: string | null): string | null {
  const today = todayUtc8(now);
  if (lastSentDate === today) return null;
  const [h, m] = schedule.time.split(':').map(Number);
  if (now.getTime() < dateMs(today) + (h - 8) * 3_600_000 + m * 60_000) return null;
  if (schedule.frequency === 'daily') return isWorkingDay(cal, today) ? today : null;
  if (schedule.weekday === null) return null;
  const iso = new Date(dateMs(today)).getUTCDay() || 7;
  const monday = dateMs(today) - (iso - 1) * DAY_MS;
  // This week's target and next week's: a holiday target steps back, possibly into this week.
  for (const week of [0, 7]) {
    const target = msDate(monday + (week + schedule.weekday - 1) * DAY_MS);
    const due = isWorkingDay(cal, target) ? target : stepBackWorking(cal, target, 1);
    if (due === today) return today;
  }
  return null;
}

/**
 * Sends the project's scheduled digest if one is due. The trigger row (key `project:<id>:digest:<date>`) is inserted
 * once; whoever inserts it queues the emails in the same transaction. Returns the number of emails queued.
 */
export async function runScheduledDigest(
  pool: Pool,
  project: { id: string },
  cal: Calendar,
  schedule: DigestSchedule | null,
  now: Date,
  appUrl: string,
  noticesFrom: Date | null = null,
): Promise<number> {
  if (!schedule) return 0;
  // By project and kind (index notification_triggers_project_idx); a LIKE on the key cannot use the unique index under a non-C collation.
  const lastRow = (
    await pool.query(`SELECT max(substring(key from '[^:]+$')) AS d FROM notification_triggers WHERE project_id = $1 AND kind = 'digest'`, [project.id])
  ).rows[0];
  const date = scheduledDigestDue(cal, schedule, now, (lastRow?.d as string | null) ?? null);
  if (!date) return 0;
  // A digest whose scheduled time fell before the go-live time is neither sent nor recorded.
  if (noticesFrom) {
    const [h, m] = schedule.time.split(':').map(Number);
    if (dateMs(date) + (h - 8) * 3_600_000 + m * 60_000 < noticesFrom.getTime()) return 0;
  }
  const open = await countOpen(pool, project.id);
  const recipients = open === 0 ? [] : await digestRecipients(pool, project.id, todayUtc8(now));
  const outcome = open === 0 ? 'skipped_obsolete' : recipients.length === 0 ? 'no_recipient' : 'sent';
  const detail = open === 0 ? { reason: 'no open tasks' } : {};
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query(
      `INSERT INTO notification_triggers (id, key, kind, project_id, record_kind, record_id, fire_at, decided_at, outcome, recipients, detail)
       VALUES ($1, $2, 'digest', $3, 'project', $3, $4, $5, $6, $7::uuid[], $8::jsonb) ON CONFLICT (key) DO NOTHING RETURNING id`,
      [uuidv7(), `project:${project.id}:digest:${date}`, project.id, now, now, outcome, outcome === 'sent' ? recipients.map((r) => r.userId) : [], JSON.stringify(detail)],
    );
    if (!ins.rows[0] || outcome !== 'sent') {
      await c.query('COMMIT');
      return 0;
    }
    await queueDigestRun(c, { projectId: project.id, recipients, asAt: now, scheduled: true, initiatedBy: null, appUrl });
    await c.query('COMMIT');
    return recipients.length;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
