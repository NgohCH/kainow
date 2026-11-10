// Recording one decided trigger and its in-app notifications, atomically (spec §4.6, §6).
// The trigger row is inserted complete and never updated; the unique key decides who records it.
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import type { RouteKind } from './recipients';

export type Outcome = 'sent' | 'skipped_obsolete' | 'skipped_paused' | 'no_recipient' | 'cancelled_ineligible';

/** Urgent kinds: emailed at the sweep that fires them under the default choice (spec §6.1). */
export const URGENT_KINDS: ReadonlySet<string> = new Set(['overdue', 'parent_deadline', 'past_due_set', 'assignee_unavailable']);

export interface Decided {
  key: string;
  kind: RouteKind;
  projectId: string;
  recordKind: 'task' | 'risk' | 'project';
  recordId: string;
  fireAt: Date;
  outcome: Outcome;
  /** Final recipients (routing plus cover); empty unless the outcome is 'sent'. */
  recipients: string[];
  detail: Record<string, unknown>;
  /** The in-app summary and link, the same for every recipient. */
  summary: string;
  link: string | null;
}

export async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
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

/** Keys among these that are already recorded. */
export async function recordedKeys(db: Pool | PoolClient, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const r = await db.query(`SELECT key FROM notification_triggers WHERE key = ANY($1::text[])`, [keys]);
  return new Set(r.rows.map((x: { key: string }) => x.key));
}

/**
 * Inserts the trigger row; only when this call recorded it (no row with the key existed) and the outcome is 'sent'
 * does it write one notification per recipient. email_off is the recipient's choice for the project at this moment.
 * Returns how many trigger rows (0 or 1) and notifications were written.
 */
export async function recordTrigger(pool: Pool, d: Decided, now: Date): Promise<{ triggers: number; notifications: number }> {
  return inTransaction(pool, async (c) => {
    const ins = await c.query(
      `INSERT INTO notification_triggers (id, key, kind, project_id, record_kind, record_id, fire_at, decided_at, outcome, recipients, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11::jsonb)
       ON CONFLICT (key) DO NOTHING RETURNING id`,
      [uuidv7(), d.key, d.kind, d.projectId, d.recordKind, d.recordId, d.fireAt, now, d.outcome,
        d.outcome === 'sent' ? d.recipients : [], JSON.stringify(d.detail)],
    );
    const triggerId = ins.rows[0]?.id as string | undefined;
    if (!triggerId) return { triggers: 0, notifications: 0 };
    if (d.outcome !== 'sent') return { triggers: 1, notifications: 0 };
    for (const userId of d.recipients) {
      await c.query(
        `INSERT INTO notifications (id, user_id, trigger_id, project_id, kind, urgent, summary, link, created_at, email_off)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 EXISTS (SELECT 1 FROM email_preferences WHERE user_id = $2 AND project_id = $4 AND choice = 'off'))`,
        [uuidv7(), userId, triggerId, d.projectId, d.kind, URGENT_KINDS.has(d.kind), d.summary, d.link, now],
      );
    }
    return { triggers: 1, notifications: d.recipients.length };
  });
}
