import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';

export interface AuditEvent {
  at: Date;
  action: string;
  actorUserId?: string | null;
  subjectType?: string;
  subjectId?: string;
  /** Never put codes, tokens, secrets or source text here. */
  detail?: Record<string, unknown>;
}

/** Appends one audit event. Pass a transaction client to make it atomic with the change it records. */
export async function writeAudit(db: Pool | PoolClient, event: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (id, occurred_at, actor_user_id, action, subject_type, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      uuidv7(event.at.getTime()),
      event.at,
      event.actorUserId ?? null,
      event.action,
      event.subjectType ?? null,
      event.subjectId ?? null,
      JSON.stringify(event.detail ?? {}),
    ],
  );
}
