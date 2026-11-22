/**
 * Approving, rescheduling and cancelling updates (10b spec 6.3, 6.4, 11). Each action writes its row, its
 * update_changes row (with the reason), its audit event and one email per Active person in one transaction.
 * Plain functions over a pool; the controller adds the clock, the running version and the actor.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { can } from '../auth/permissions';
import { readReason } from '../common/reason';
import { uuidv7 } from '../common/uuid7';
import { freshBackup } from '../ops/status';
import { auditUpdateApproved, auditUpdateCancelled, auditUpdateRescheduled } from './audit';
import { type ScheduledUpdate, mailEveryone, scheduledBannerText } from './people-mail';
import { newestAvailable } from './release-check';
import { FAILURE_TEXT, type FailureCode, OPEN_STATES, type UpdateState, approvalWindowProblem, stateWords } from './states';
import { isNewer, parseTag } from './version';

const DAY_MS = 86_400_000;
export const HISTORY_LIMIT = 20;
/** Before the window starts an Administrator may still change the time or cancel. */
export const CHANGEABLE_STATES: readonly UpdateState[] = ['approved', 'preparing', 'ready'];
export const RECOVERY_STATES: readonly UpdateState[] = ['failed_after_migration', 'failed_needs_attention'];

/** Fixed refusal texts (409 unless noted). */
export const UPDATE_REFUSALS = {
  open: { code: 'update_open', message: 'Another update is already approved or in progress.' },
  protective: { code: 'protective_on', message: 'Updates are refused while Kainow is read-only.' },
  notNewer: { code: 'not_newer', message: 'This release is not newer than the running version.' },
  needsRecovery: { code: 'needs_recovery', message: 'The last update failed and must be recovered first.' },
  noFreshBackup: { code: 'no_fresh_backup', message: 'Updates are refused until a backup succeeds. See Backups above.' },
  notNewest: { code: 'not_newest_available', message: 'Only the newest available release can be approved.' },
  notChangeable: { code: 'not_changeable', message: 'This update has started or finished and can no longer be changed.' },
} as const;

export interface UpdateStepView {
  step: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: 'running' | 'passed' | 'failed' | 'skipped';
  failureCode: string | null;
  failureText: string | null;
}

export interface UpdateView {
  id: string;
  fromVersion: string;
  toVersion: string;
  tag: string;
  commit: string;
  state: UpdateState;
  stateWords: string;
  startsAt: Date;
  expectedMinutes: number;
  approvedBy: { id: string; name: string };
  approvedAt: Date;
  reason: string;
  cancelledBy: { id: string; name: string } | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  reminderSentAt: Date | null;
  /** Only once the tag is verified. */
  releaseNotes: string | null;
  failureCode: string | null;
  failureText: string | null;
  finishedAt: Date | null;
  /** ORDER BY started_at, id. */
  steps: UpdateStepView[];
}

const failureText = (code: string | null): string | null => (code ? ((FAILURE_TEXT as Record<string, string>)[code] ?? null) : null);

const SELECT = `SELECT u.*, a.display_name AS approved_by_name, c.display_name AS cancelled_by_name
  FROM updates u JOIN users a ON a.id = u.approved_by LEFT JOIN users c ON c.id = u.cancelled_by`;

async function toViews(db: Pick<Pool | PoolClient, 'query'>, rows: Record<string, any>[]): Promise<UpdateView[]> {
  const ids = rows.map((r) => r.id as string);
  const steps = ids.length
    ? (await db.query(`SELECT * FROM update_steps WHERE update_id = ANY($1::uuid[]) ORDER BY started_at, id`, [ids])).rows
    : [];
  return rows.map((r) => ({
    id: r.id,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    tag: r.tag,
    commit: r.commit,
    state: r.state,
    stateWords: stateWords(r.state),
    startsAt: r.starts_at,
    expectedMinutes: r.expected_minutes,
    approvedBy: { id: r.approved_by, name: r.approved_by_name },
    approvedAt: r.approved_at,
    reason: r.reason,
    cancelledBy: r.cancelled_by ? { id: r.cancelled_by, name: r.cancelled_by_name } : null,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    reminderSentAt: r.reminder_sent_at,
    releaseNotes: r.tag_object ? r.release_notes : null,
    failureCode: r.failure_code,
    failureText: failureText(r.failure_code as FailureCode | null),
    finishedAt: r.finished_at,
    steps: steps
      .filter((s) => s.update_id === r.id)
      .map((s) => ({
        step: s.step,
        startedAt: s.started_at,
        finishedAt: s.finished_at,
        outcome: s.outcome,
        failureCode: s.failure_code,
        failureText: failureText(s.failure_code),
      })),
  }));
}

export async function loadUpdate(db: Pick<Pool | PoolClient, 'query'>, id: string): Promise<UpdateView | null> {
  const rows = (await db.query(`${SELECT} WHERE u.id = $1`, [id])).rows;
  return (await toViews(db, rows))[0] ?? null;
}

/** The open update (approved, preparing, ready or installing), if any. */
export async function currentUpdate(db: Pick<Pool | PoolClient, 'query'>): Promise<UpdateView | null> {
  const rows = (await db.query(`${SELECT} WHERE u.state = ANY($1::text[]) ORDER BY u.approved_at DESC, u.id DESC LIMIT 1`, [OPEN_STATES])).rows;
  return (await toViews(db, rows))[0] ?? null;
}

/** The last 20 updates, newest approval first. */
export async function updateHistory(db: Pick<Pool | PoolClient, 'query'>): Promise<UpdateView[]> {
  const rows = (await db.query(`${SELECT} ORDER BY u.approved_at DESC, u.id DESC LIMIT ${HISTORY_LIMIT}`)).rows;
  return toViews(db, rows);
}

/** True when the latest update failed after its migration started or needs attention (only `recover` clears it). */
export async function needsRecovery(db: Pick<Pool | PoolClient, 'query'>): Promise<boolean> {
  const r = (await db.query(`SELECT state FROM updates ORDER BY approved_at DESC, id DESC LIMIT 1`)).rows[0];
  return !!r && RECOVERY_STATES.includes(r.state);
}

/** The scheduled-update banner: from approval until the update starts (state approved, preparing or ready, start ahead). */
export async function scheduledBanner(db: Pick<Pool | PoolClient, 'query'>, now: Date): Promise<{ startsAt: Date; expectedMinutes: number; text: string } | null> {
  const r = (
    await db.query(
      `SELECT id, starts_at, expected_minutes FROM updates WHERE state = ANY($1::text[]) AND starts_at > $2 ORDER BY starts_at, id LIMIT 1`,
      [CHANGEABLE_STATES, now],
    )
  ).rows[0];
  if (!r) return null;
  const u: ScheduledUpdate = { id: r.id, startsAt: r.starts_at, expectedMinutes: r.expected_minutes };
  return { startsAt: u.startsAt, expectedMinutes: u.expectedMinutes, text: scheduledBannerText(u) };
}

async function requireManager(db: Pick<Pool, 'query'>, actorId: string): Promise<void> {
  const actor = (await db.query(`SELECT role, status FROM users WHERE id = $1`, [actorId])).rows[0] as { role: string; status: string } | undefined;
  if (!actor || actor.status !== 'active' || !can(actor.role, 'operations.manage')) throw new ForbiddenException();
}

function readStart(input: unknown): Date {
  const d = typeof input === 'string' || input instanceof Date ? new Date(input) : new Date(NaN);
  return d;
}

function readMinutes(input: unknown): number {
  if (input === undefined || input === null || input === '') return 30;
  return typeof input === 'number' ? input : typeof input === 'string' && /^\d+$/.test(input.trim()) ? Number(input) : NaN;
}

function windowOrThrow(startsAt: Date, now: Date, minutes: number): void {
  const problem = approvalWindowProblem(startsAt, now, minutes);
  if (problem) throw new BadRequestException({ code: 'window', message: problem });
}

async function inUpdateTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.updates'))`);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    client.release(broken);
  }
}

const refuse = (r: { code: string; message: string }) => new ConflictException(r);

export interface ApproveInput {
  tag?: unknown;
  startsAt?: unknown;
  expectedMinutes?: unknown;
  reason?: unknown;
}

/** Approves the newest available release for a time. 201 UpdateView; 400 for a bad window or reason; 409 refusals. */
export async function approveUpdate(pool: Pool, actorId: string, input: ApproveInput, now: Date, running: string): Promise<UpdateView> {
  await requireManager(pool, actorId);
  const reason = readReason(input.reason);
  const tag = typeof input.tag === 'string' ? input.tag.trim() : '';
  if (!parseTag(tag)) throw new BadRequestException({ code: 'tag', message: 'Choose a release tag such as v1.2.3.' });
  const startsAt = readStart(input.startsAt);
  const minutes = readMinutes(input.expectedMinutes);
  windowOrThrow(startsAt, now, minutes);

  const id = await inUpdateTransaction(pool, async (c) => {
    if ((await c.query(`SELECT 1 FROM updates WHERE state = ANY($1::text[]) LIMIT 1`, [OPEN_STATES])).rows.length > 0) throw refuse(UPDATE_REFUSALS.open);
    const state = (await c.query(`SELECT protective FROM operations_state WHERE id`)).rows[0];
    if (state?.protective) throw refuse(UPDATE_REFUSALS.protective);
    if (!isNewer(tag, running)) throw refuse(UPDATE_REFUSALS.notNewer);
    if (await needsRecovery(c)) throw refuse(UPDATE_REFUSALS.needsRecovery);
    if (!(await freshBackup(c, now)).ok) throw refuse(UPDATE_REFUSALS.noFreshBackup);
    const newest = await newestAvailable(c as unknown as Pool, running);
    if (!newest || newest.tag !== tag) throw refuse(UPDATE_REFUSALS.notNewest);

    const id = uuidv7(now.getTime());
    const toVersion = tag.slice(1);
    try {
      await c.query('SAVEPOINT approve');
      await c.query(
        `INSERT INTO updates (id, from_version, to_version, tag, commit, state, starts_at, expected_minutes, approved_by, approved_at, reason)
         VALUES ($1, $2, $3, $4, $5, 'approved', $6, $7, $8, $9, $10)`,
        [id, running, toVersion, tag, newest.commit, startsAt, minutes, actorId, now, reason],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        await c.query('ROLLBACK TO SAVEPOINT approve');
        throw refuse(UPDATE_REFUSALS.open);
      }
      throw err;
    }
    const detail = { tag, commit: newest.commit, fromVersion: running, toVersion, startsAt, expectedMinutes: minutes };
    await c.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, reason, detail) VALUES ($1, $2, $3, 'approved', $4, $5, $6)`, [
      uuidv7(now.getTime()),
      id,
      now,
      actorId,
      reason,
      JSON.stringify(detail),
    ]);
    await auditUpdateApproved(c, { at: now, actorUserId: actorId, subjectType: 'update', subjectId: id, detail: { ...detail, reason } });
    await mailEveryone(c, 'update_scheduled', { id, startsAt, expectedMinutes: minutes }, now);
    return id;
  });
  return (await loadUpdate(pool, id)) as UpdateView;
}

async function lockChangeable(c: PoolClient, id: string): Promise<Record<string, any>> {
  const row = (await c.query(`SELECT * FROM updates WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!row) throw new NotFoundException();
  if (!CHANGEABLE_STATES.includes(row.state)) throw refuse(UPDATE_REFUSALS.notChangeable);
  return row;
}

const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** A new start time and length. The day-before email is due again only when the new start is more than 24 hours away. */
export async function rescheduleUpdate(
  pool: Pool,
  actorId: string,
  id: string,
  input: { startsAt?: unknown; expectedMinutes?: unknown; reason?: unknown },
  now: Date,
): Promise<UpdateView> {
  await requireManager(pool, actorId);
  if (!isUuid(id)) throw new NotFoundException();
  const reason = readReason(input.reason);
  const startsAt = readStart(input.startsAt);
  const minutes = readMinutes(input.expectedMinutes);
  windowOrThrow(startsAt, now, minutes);

  await inUpdateTransaction(pool, async (c) => {
    const row = await lockChangeable(c, id);
    const clearReminder = startsAt.getTime() - now.getTime() > DAY_MS;
    await c.query(
      `UPDATE updates SET starts_at = $2, expected_minutes = $3, reminder_sent_at = CASE WHEN $4 THEN NULL ELSE reminder_sent_at END WHERE id = $1`,
      [id, startsAt, minutes, clearReminder],
    );
    const detail = { fromStartsAt: row.starts_at, fromExpectedMinutes: row.expected_minutes, startsAt, expectedMinutes: minutes };
    await c.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, reason, detail) VALUES ($1, $2, $3, 'rescheduled', $4, $5, $6)`, [
      uuidv7(now.getTime()),
      id,
      now,
      actorId,
      reason,
      JSON.stringify(detail),
    ]);
    await auditUpdateRescheduled(c, { at: now, actorUserId: actorId, subjectType: 'update', subjectId: id, detail: { ...detail, tag: row.tag, reason } });
    await mailEveryone(c, 'update_rescheduled', { id, startsAt, expectedMinutes: minutes }, now);
  });
  return (await loadUpdate(pool, id)) as UpdateView;
}

/** Cancels an update that has not started (approved, preparing or ready). */
export async function cancelUpdate(pool: Pool, actorId: string, id: string, input: { reason?: unknown }, now: Date): Promise<UpdateView> {
  await requireManager(pool, actorId);
  if (!isUuid(id)) throw new NotFoundException();
  const reason = readReason(input.reason);

  await inUpdateTransaction(pool, async (c) => {
    const row = await lockChangeable(c, id);
    await c.query(`UPDATE updates SET state = 'cancelled', cancelled_by = $2, cancelled_at = $3, cancel_reason = $4, finished_at = $3 WHERE id = $1`, [
      id,
      actorId,
      now,
      reason,
    ]);
    const detail = { fromState: row.state, startsAt: row.starts_at };
    await c.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, reason, detail) VALUES ($1, $2, $3, 'cancelled', $4, $5, $6)`, [
      uuidv7(now.getTime()),
      id,
      now,
      actorId,
      reason,
      JSON.stringify(detail),
    ]);
    await auditUpdateCancelled(c, { at: now, actorUserId: actorId, subjectType: 'update', subjectId: id, detail: { ...detail, tag: row.tag, reason } });
    await mailEveryone(c, 'update_cancelled', { id, startsAt: row.starts_at, expectedMinutes: row.expected_minutes }, now);
  });
  return (await loadUpdate(pool, id)) as UpdateView;
}
