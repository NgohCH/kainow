import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadAdmins } from '../notifications/recipients';

export interface AdminNotice {
  kind: string;
  summary: string;
  link: string | null;
  now: Date;
  urgent: true;
}

/** One in-app notice per Active Enterprise Administrator (urgent, email not switched off). */
export async function notifyAdmins(db: Pool | PoolClient, n: AdminNotice): Promise<void> {
  for (const userId of await loadAdmins(db)) {
    await db.query(
      `INSERT INTO notifications (id, user_id, kind, urgent, summary, link, created_at, email_off)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)`,
      [uuidv7(), userId, n.kind, n.urgent, n.summary, n.link, n.now],
    );
  }
}
