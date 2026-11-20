import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { writeOutbox } from '../email/outbox';
import { loadAdmins } from '../notifications/recipients';

export interface AdminNotice {
  kind: string;
  summary: string;
  link: string | null;
  now: Date;
  urgent: true;
  /** An administrator who is not told (the one who did the thing, for example Resume). */
  except?: string;
}

const isClient = (db: Pool | PoolClient): db is PoolClient => typeof (db as PoolClient).release === 'function';

/**
 * One in-app notice per Active Enterprise Administrator plus one queued email each. The notice is marked email_off
 * because mailing.ts only handles trigger-based notices; the outbox row is what gets the email out (the worker sends it).
 * Atomic: given a Pool, all rows are written in one transaction; given a PoolClient, the caller's transaction is used.
 */
export async function notifyAdmins(db: Pool | PoolClient, n: AdminNotice): Promise<void> {
  if (isClient(db)) return writeNotices(db, n);
  const client = await db.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      await writeNotices(client, n);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    client.release(broken);
  }
}

async function writeNotices(db: PoolClient, n: AdminNotice): Promise<void> {
  const ids = (await loadAdmins(db)).filter((id) => id !== n.except);
  if (ids.length === 0) return;
  const emails = new Map<string, string>(
    (await db.query('SELECT id, email FROM users WHERE id = ANY($1::uuid[])', [ids])).rows.map((r) => [r.id, r.email]),
  );
  for (const userId of ids) {
    const email = emails.get(userId);
    const outboxId = email
      ? await writeOutbox(db, {
          toUserId: userId,
          toAddress: email,
          subject: n.summary,
          body: n.link ? `${n.summary}\n\n${n.link}` : n.summary,
          kind: n.kind,
          projectId: null,
          initiatedBy: 'system',
          now: n.now,
        })
      : null;
    await db.query(
      `INSERT INTO notifications (id, user_id, kind, urgent, summary, link, created_at, email_off, outbox_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
      [uuidv7(), userId, n.kind, n.urgent, n.summary, n.link, n.now, outboxId],
    );
  }
}
