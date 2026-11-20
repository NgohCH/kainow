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
}

/**
 * One in-app notice per Active Enterprise Administrator plus one queued email each. The notice is marked email_off
 * because mailing.ts only handles trigger-based notices; the outbox row is what gets the email out (the worker sends it).
 */
export async function notifyAdmins(db: Pool | PoolClient, n: AdminNotice): Promise<void> {
  for (const userId of await loadAdmins(db)) {
    const email = (await db.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0]?.email as string | undefined;
    const outboxId = email
      ? await writeOutbox(db, {
          toUserId: userId,
          toAddress: email,
          subject: n.summary,
          body: n.link ? `${n.summary}

${n.link}` : n.summary,
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
