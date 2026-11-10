import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Clock } from '../auth/tokens';
import { isEligible } from '../notifications/recipients';
import { todayUtc8 } from '../projects/membership';
import type { Db } from './letterhead';
import { noticeEmail } from './notice';
import { writeOutbox } from './outbox';
import { isConsolidated, stillRelevant, type EligibilityScope, type EmailRelevance } from './relevance';
import { classify, type MailTransport, type OutgoingEmail, type StoredAttachment } from './transport';

/** Minutes after the first failure for the first, second and third retry (an initial attempt plus three: four in all). */
export const RETRY_MINUTES = [5, 30, 120];
/** A row left `sending` this long had an attempt whose outcome was never recorded. */
export const UNCERTAIN_AFTER_MINUTES = 10;

const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
const BATCH = 10;
const MAX_ROUNDS = 20;
const MINUTE = 60_000;

export const REASON_INELIGIBLE = 'recipient no longer eligible';
export const REASON_NOT_RELEVANT = 'no longer relevant';
export const REASON_CONTENT_CHANGED = 'content changed';
export const REASON_NO_ATTEMPTS_LEFT = 'No more attempts after an uncertain send';

export interface DispatcherLog {
  /** Fixed reasons only; never an error object or message. */
  warn(message: string): void;
}

export interface DispatcherDeps {
  pool: Pool;
  transport: MailTransport;
  from: string;
  clock: Clock;
  log: DispatcherLog;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  cancelled: number;
}

interface Claimed {
  id: string;
  attemptNo: number;
  /** The claim time, replaced by the stamp taken just before the send. */
  startedAt: Date;
  email: OutgoingEmail;
}

type OutboxRow = {
  id: string;
  to_user_id: string | null;
  to_address: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  attachments: StoredAttachment[] | null;
  kind: string;
  project_id: string | null;
  initiated_by: 'person' | 'schedule' | 'trigger' | 'digest' | 'system';
  relevance: EmailRelevance | null;
  attempts: number;
  first_failure_at: Date | null;
  next_attempt_at: Date | null;
};

const at = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * MINUTE);

async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await work(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export class EmailDispatcher {
  /** When this process handed each message to a paced transport in the last minute. */
  private readonly recentSends: number[] = [];

  constructor(private readonly deps: DispatcherDeps) {}

  /** How many more messages may be sent now: unlimited unless the transport is paced (Microsoft 365). */
  private room(): number {
    const limit = this.deps.transport.perMinute;
    if (limit === undefined) return Number.POSITIVE_INFINITY;
    const since = this.deps.clock().getTime() - MINUTE;
    while (this.recentSends.length > 0 && this.recentSends[0] <= since) this.recentSends.shift();
    return limit - this.recentSends.length;
  }

  /**
   * One pass over the outbox. Nothing is sent inside a transaction: rows are claimed (status `sending`) and committed first,
   * then sent, then the outcome is recorded in a second transaction. A row whose outcome was never recorded is found
   * later by the 10-minute rule and handled as uncertain, never silently resent.
   * A paced transport takes at most its limit per rolling minute; rows beyond it stay queued, with no attempt counted,
   * for a later pass.
   */
  async dispatchDue(): Promise<DispatchResult> {
    const result: DispatchResult = { sent: 0, failed: 0, cancelled: 0 };
    result.failed += await this.markUncertain();
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const room = this.room();
      if (room <= 0) break;
      const { claimed, cancelled } = await this.claim(Math.min(BATCH, room));
      result.cancelled += cancelled;
      for (const c of claimed) {
        const outcome = await this.attempt(c);
        if (outcome === 'sent') result.sent += 1;
        else if (outcome === 'failed') result.failed += 1;
      }
      if (claimed.length + cancelled === 0) break;
    }
    return result;
  }

  /** Rows left `sending` for 10 minutes. Returns how many ended `failed` because no attempt was left. */
  private async markUncertain(): Promise<number> {
    const now = this.deps.clock();
    return inTransaction(this.deps.pool, async (db) => {
      const stale = (
        await db.query(
          `SELECT id, attempts, first_failure_at, next_attempt_at FROM email_outbox
            WHERE status = 'sending' AND next_attempt_at <= $1
            ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED`,
          [at(now, -UNCERTAIN_AFTER_MINUTES)],
        )
      ).rows as Pick<OutboxRow, 'id' | 'attempts' | 'first_failure_at' | 'next_attempt_at'>[];
      let failed = 0;
      for (const r of stale) {
        const startedAt = r.next_attempt_at as Date;
        const priorUncertain = Number(
          (await db.query(`SELECT count(*) AS n FROM email_attempts WHERE outbox_id = $1 AND outcome = 'uncertain'`, [r.id])).rows[0].n,
        );
        await db.query(
          `INSERT INTO email_attempts (id, outbox_id, attempt_no, started_at, finished_at, outcome) VALUES ($1, $2, $3, $4, NULL, 'uncertain')`,
          [randomUUID(), r.id, r.attempts, startedAt],
        );
        if (priorUncertain > 0) {
          // A second uncertain stays for an Administrator: no automatic pick-up.
          await db.query(`UPDATE email_outbox SET status = 'uncertain', next_attempt_at = NULL WHERE id = $1`, [r.id]);
          continue;
        }
        const firstFailure = r.first_failure_at ?? startedAt;
        const retry = RETRY_MINUTES[r.attempts - 1];
        if (retry === undefined) {
          await db.query(
            `UPDATE email_outbox SET status = 'failed', possible_duplicate = true, first_failure_at = $2, next_attempt_at = NULL, last_reason = $3 WHERE id = $1`,
            [r.id, firstFailure, REASON_NO_ATTEMPTS_LEFT],
          );
          failed += 1;
          continue;
        }
        await db.query(
          `UPDATE email_outbox SET status = 'uncertain', possible_duplicate = true, first_failure_at = $2, next_attempt_at = $3 WHERE id = $1`,
          [r.id, firstFailure, at(firstFailure, retry)],
        );
      }
      return failed;
    });
  }

  /** Locks due rows, rechecks eligibility and relevance for each, and marks the ones to send as `sending`. */
  private async claim(limit: number): Promise<{ claimed: Claimed[]; cancelled: number }> {
    const now = this.deps.clock();
    const today = todayUtc8(now);
    return inTransaction(this.deps.pool, async (db) => {
      const due = (
        await db.query(
          `SELECT * FROM email_outbox
            WHERE status = 'queued' OR (status IN ('retry_wait', 'uncertain') AND next_attempt_at <= $1)
            ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [now, limit],
        )
      ).rows as OutboxRow[];
      const claimed: Claimed[] = [];
      let cancelled = 0;
      const cancel = async (id: string, reason: string): Promise<void> => {
        await db.query(`UPDATE email_outbox SET status = 'cancelled', next_attempt_at = NULL, last_reason = $2 WHERE id = $1`, [id, reason]);
        cancelled += 1;
      };
      for (const r of due) {
        if (!(await this.eligible(db, r, today))) {
          await cancel(r.id, REASON_INELIGIBLE);
          continue;
        }
        const rel = r.relevance;
        if (rel && isConsolidated(rel)) {
          const keep: typeof rel.items = [];
          for (const item of rel.items) if (await stillRelevant(db, item.check, now)) keep.push(item);
          if (keep.length < rel.items.length) {
            await cancel(r.id, REASON_CONTENT_CHANGED);
            if (keep.length > 0) await this.writeReplacement(db, r, rel, keep, now);
            continue;
          }
        } else if (rel && !(await stillRelevant(db, rel, now))) {
          await cancel(r.id, REASON_NOT_RELEVANT);
          continue;
        }
        const attemptNo = r.attempts + 1;
        await db.query(`UPDATE email_outbox SET status = 'sending', attempts = $2, next_attempt_at = $3 WHERE id = $1`, [r.id, attemptNo, now]);
        claimed.push({
          id: r.id,
          attemptNo,
          startedAt: now,
          email: {
            from: this.deps.from,
            to: r.to_address,
            subject: r.subject,
            text: r.text_body,
            html: r.html_body ?? '',
            attachments: r.attachments ?? [],
          },
        });
      }
      return { claimed, cancelled };
    });
  }

  private async eligible(db: PoolClient, r: OutboxRow, today: string): Promise<boolean> {
    if (r.to_user_id === null) return true;
    const scope: EligibilityScope = r.relevance?.scope ?? 'account';
    if (scope === 'admin') return isEligible(db, r.to_user_id, null, today);
    if (scope === 'project') return r.project_id !== null && (await isEligible(db, r.to_user_id, r.project_id, today));
    return (await db.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [r.to_user_id])).rows.length > 0;
  }

  private async writeReplacement(
    db: PoolClient,
    r: OutboxRow,
    rel: Extract<EmailRelevance, { items: unknown }>,
    keep: Extract<EmailRelevance, { items: unknown }>['items'],
    now: Date,
  ): Promise<void> {
    const notice = noticeEmail(
      rel.projectName,
      keep.map((i) => i.line),
    );
    await writeOutbox(db, {
      toUserId: r.to_user_id,
      toAddress: r.to_address,
      subject: notice.subject,
      body: notice.body,
      kind: r.kind,
      projectId: r.project_id,
      initiatedBy: r.initiated_by,
      triggerIds: keep.map((i) => i.triggerId),
      relevance: { ...rel, items: keep },
      replaces: r.id,
      now,
    });
  }

  /** Sends one claimed row and records the outcome. */
  private async attempt(c: Claimed): Promise<'sent' | 'failed' | 'retry'> {
    // Re-assert ownership just before sending: if another pass has marked this claim uncertain meanwhile, do not send.
    const stamp = this.deps.clock();
    const owned = await this.deps.pool.query(
      `UPDATE email_outbox SET next_attempt_at = $4 WHERE id = $1 AND status = 'sending' AND attempts = $2 AND next_attempt_at = $3`,
      [c.id, c.attemptNo, c.startedAt, stamp],
    );
    if (owned.rowCount === 0) return 'retry';
    c.startedAt = stamp;
    if (this.deps.transport.perMinute !== undefined) this.recentSends.push(stamp.getTime());
    let error: ReturnType<typeof classify> | undefined;
    try {
      await this.deps.transport.send(c.email);
    } catch (err) {
      error = classify(err);
    }
    const finished = this.deps.clock();
    if (!error) {
      await this.record(c, finished, 'sent', null, null, `status = 'sent', sent_at = $4, last_reason = NULL`, [finished]);
      return 'sent';
    }
    this.deps.log.warn(`Email attempt ${c.attemptNo} failed (${error.kind}): ${error.reason}`);
    if (error.kind === 'permanent') {
      await this.record(c, finished, 'permanent', error.smtpCode, error.kind, `status = 'failed', next_attempt_at = NULL, last_reason = $4`, [error.reason]);
      return 'failed';
    }
    // first_failure_at is set once; every retry slot counts from it
    const first = await this.firstFailure(c);
    if (c.attemptNo >= MAX_ATTEMPTS) {
      await this.record(c, finished, 'temporary', error.smtpCode, error.kind, `status = 'failed', next_attempt_at = NULL, last_reason = $4, first_failure_at = $5`, [error.reason, first]);
      return 'failed';
    }
    await this.record(
      c,
      finished,
      'temporary',
      error.smtpCode,
      error.kind,
      `status = 'retry_wait', last_reason = $4, first_failure_at = $5, next_attempt_at = $6`,
      [error.reason, first, at(first, RETRY_MINUTES[c.attemptNo - 1])],
    );
    return 'retry';
  }

  private async firstFailure(c: Claimed): Promise<Date> {
    const r = (await this.deps.pool.query(`SELECT first_failure_at FROM email_outbox WHERE id = $1`, [c.id])).rows[0];
    return (r?.first_failure_at as Date | null) ?? c.startedAt;
  }

  /**
   * Updates the row only while it is still the `sending` row of this attempt, and writes the attempt row only then,
   * so an attempt already recorded as uncertain by another pass is not recorded twice.
   */
  private async record(c: Claimed, finished: Date, outcome: 'sent' | 'temporary' | 'permanent', smtpCode: number | null, errorClass: string | null, set: string, params: unknown[]): Promise<void> {
    await inTransaction(this.deps.pool, async (db) => {
      const upd = await db.query(`UPDATE email_outbox SET ${set} WHERE id = $1 AND status = 'sending' AND attempts = $2 AND next_attempt_at = $3`, [
        c.id,
        c.attemptNo,
        c.startedAt,
        ...params,
      ]);
      if (upd.rowCount === 0) return;
      await db.query(
        `INSERT INTO email_attempts (id, outbox_id, attempt_no, started_at, finished_at, outcome, smtp_code, error_class) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), c.id, c.attemptNo, c.startedAt, finished, outcome, smtpCode === null ? null : String(smtpCode), errorClass],
      );
    });
  }
}

/** Raised when an email cannot be resent because of its status; the controller maps it to 409. */
export class NotResendable extends Error {
  constructor(message = 'Only an email that failed or has an uncertain outcome can be resent.') {
    super(message);
    this.name = 'NotResendable';
  }
}

/** Raised when there is no such email; the controller maps it to 404. */
export class OutboxRowNotFound extends Error {
  constructor() {
    super('No such email.');
    this.name = 'OutboxRowNotFound';
  }
}

/**
 * Queues a copy of a failed or uncertain email as a new row linked by `resend_of`, with a fresh attempt count.
 * The composed email is copied, never recomposed; eligibility and relevance are checked again when it is sent.
 * An uncertain original that was still waiting for its automatic resend is taken out of the schedule in the same
 * statement, so the person is not sent two copies.
 */
export async function resend(db: Db, outboxId: string, actorId: string, now: Date): Promise<string> {
  const id = randomUUID();
  const r = await db.query(
    `WITH src AS (
       SELECT * FROM email_outbox WHERE id = $2 AND status IN ('failed', 'uncertain') FOR UPDATE
     ), unschedule AS (
       UPDATE email_outbox SET next_attempt_at = NULL WHERE id IN (SELECT id FROM src WHERE status = 'uncertain')
     )
     INSERT INTO email_outbox (id, to_user_id, to_address, subject, text_body, html_body, attachments, kind, project_id,
       initiated_by_user, initiated_by, relevance, trigger_ids, digest_run_id, status, attempts, resend_of, created_at)
     SELECT $1, to_user_id, to_address, subject, text_body, html_body, attachments, kind, project_id,
            $3, 'person', relevance, trigger_ids, digest_run_id, 'queued', 0, id, $4
       FROM src`,
    [id, outboxId, actorId, now],
  );
  if (r.rowCount === 0) {
    const exists = await db.query(`SELECT 1 FROM email_outbox WHERE id = $1`, [outboxId]);
    throw exists.rows.length > 0 ? new NotResendable() : new OutboxRowNotFound();
  }
  return id;
}
