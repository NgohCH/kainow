import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { loadAdmins, loadHolders } from '../notifications/recipients';
import { todayUtc8 } from '../projects/membership';
import { readSettings } from '../spend/spend.settings';
import type { Provider } from './keys';

export const PROVIDER_NAMES: Readonly<Record<Provider, string>> = { openai: 'OpenAI', anthropic: 'Anthropic' };

/** What was sent when a connection's key was first seen rejected. Never holds a key. */
export interface KeyRejectedNotice {
  connectionId: string;
  projectId: string;
  projectName: string;
  provider: Provider;
  label: string;
  status: number;
  at: Date;
  /** The in-app notice text, the same for every recipient. */
  text: string;
  recipients: string[];
}

/** Spec 5.4: one wording for a bad key and for a key that may not use the model. */
export function keyRejectedText(provider: Provider, label: string, projectName: string): string {
  return `The ${PROVIDER_NAMES[provider]} key for AI connection "${label}" in ${projectName} was refused, or this key may not use the model. AI requests skip this connection until the key is replaced.`;
}

const MANAGER_ROLES = new Set(['pm', 'owner', 'sponsor']);

/**
 * The provider refused the connection's key (401/403), on a real call or on Check key (spec 5.3, 5.4). In the caller's
 * transaction: the connection becomes key_rejected with the time and status (a disabled one stays disabled but keeps the
 * rejection, so enabling it returns key_rejected), a key_rejected event (actor null: Kainow acted), the project History
 * line, and one ai_key_rejected notice per Enterprise Administrator and per current connection manager.
 *
 * Only the call that changes the row does any of that (`... WHERE state <> 'key_rejected' AND rejection_notified_at IS NULL
 * RETURNING`): a second 401 seen at the same time waits on the row lock, then finds it already rejected, and notifies
 * nobody. Replacing the key clears rejection_notified_at. Returns the notice, or null when the connection was already
 * rejected.
 */
export async function markKeyRejected(c: PoolClient, input: { connectionId: string; status: number; at: Date }): Promise<KeyRejectedNotice | null> {
  const { connectionId, status, at } = input;
  // Lock first: a concurrent rejection of the same connection commits before this one reads the state again below.
  const previous = (await c.query<{ state: string }>(`SELECT state FROM ai_connections WHERE id = $1 FOR UPDATE`, [connectionId])).rows[0]?.state;
  const { rows } = await c.query<{ project_id: string; label: string; state: string; provider: Provider; model_id: string; project_name: string }>(
    `UPDATE ai_connections c
        SET state = CASE WHEN c.state = 'disabled' THEN 'disabled' ELSE 'key_rejected' END,
            rejected_at = $2, rejected_status = $3, rejection_notified_at = $2
       FROM ai_models m, projects p
      WHERE c.id = $1 AND m.id = c.model_ref AND p.id = c.project_id
        AND c.state <> 'key_rejected' AND c.rejection_notified_at IS NULL
      RETURNING c.project_id, c.label, c.state, m.provider, m.model_id, p.name AS project_name`,
    [connectionId, at, status],
  );
  const r = rows[0];
  if (!r) return null;

  const settings = await readSettings(c);
  const admins = await loadAdmins(c);
  const managers = settings?.projectsMayManageConnections
    ? (await loadHolders(c, r.project_id, todayUtc8(at))).filter((h) => h.roles.some((role) => MANAGER_ROLES.has(role))).map((h) => h.userId)
    : [];
  const recipients = [...new Set([...admins, ...managers])].sort();
  const text = keyRejectedText(r.provider, r.label, r.project_name);

  const detail = { label: r.label, provider: r.provider, modelId: r.model_id, status, previousState: previous, state: r.state, notified: recipients.length };
  await c.query(`INSERT INTO ai_connection_events (id, connection_id, action, actor_id, reason, detail, at) VALUES ($1, $2, 'key_rejected', NULL, NULL, $3, $4)`, [
    uuidv7(at.getTime()),
    connectionId,
    JSON.stringify(detail),
    at,
  ]);
  // The project History line, in the form every connection change takes (ConnectionsService.record): names the label, never the key.
  await writeAudit(c, { at, action: 'ai.connection_key_rejected', actorUserId: null, subjectType: 'ai_connection', subjectId: connectionId, detail: { projectId: r.project_id, ...detail } });
  for (const userId of recipients) {
    await c.query(
      `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at, email_off) VALUES ($1, $2, $3, 'ai_key_rejected', false, $4, $5, $6, true)`,
      [uuidv7(at.getTime()), userId, r.project_id, text, `#/projects/${r.project_id}/ai`, at],
    );
  }
  return { connectionId, projectId: r.project_id, projectName: r.project_name, provider: r.provider, label: r.label, status, at, text, recipients };
}

/** markKeyRejected in its own transaction. */
export async function markKeyRejectedNow(pool: Pool, input: { connectionId: string; status: number; at: Date }): Promise<KeyRejectedNotice | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await markKeyRejected(c, input);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
