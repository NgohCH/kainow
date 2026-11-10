import { randomUUID } from 'node:crypto';
import { composeEmail } from '../organisation/email';
import { loadLetterhead, type Db } from './letterhead';
import type { EmailRelevance } from './relevance';
import { storeAttachments } from './transport';

export type OutboxInput = {
  toUserId: string | null;
  toAddress: string;
  subject: string;
  body: string;
  kind: string;
  projectId: string | null;
  initiatedBy: 'person' | 'schedule' | 'trigger' | 'digest' | 'system';
  initiatedByUser?: string;
  triggerIds?: string[];
  digestRunId?: string;
  relevance?: EmailRelevance;
  replaces?: string;
  resendOf?: string;
  /** When the row is written; library code never reads the clock itself. */
  now: Date;
};

/**
 * Composes the email with the letterhead as it is now and queues it. The composed text, HTML and logo are stored,
 * so a later change to the organisation never alters an email already composed.
 * Pass a client inside the caller's transaction to write atomically with it; the caller nudges the dispatcher after commit.
 */
export async function writeOutbox(db: Db, row: OutboxInput): Promise<string> {
  const m = composeEmail(await loadLetterhead(db, 'email'), row.subject, row.body);
  const id = randomUUID();
  await db.query(
    `INSERT INTO email_outbox (id, to_user_id, to_address, subject, text_body, html_body, attachments, kind, project_id,
       initiated_by_user, initiated_by, trigger_ids, digest_run_id, relevance, status, attempts, resend_of, replaces, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::uuid[], $13, $14::jsonb, 'queued', 0, $15, $16, $17)`,
    [
      id,
      row.toUserId,
      row.toAddress,
      m.subject,
      m.text,
      m.html,
      JSON.stringify(storeAttachments(m.attachments)),
      row.kind,
      row.projectId,
      row.initiatedByUser ?? null,
      row.initiatedBy,
      row.triggerIds ?? [],
      row.digestRunId ?? null,
      row.relevance === undefined ? null : JSON.stringify(row.relevance),
      row.resendOf ?? null,
      row.replaces ?? null,
      row.now,
    ],
  );
  return id;
}
