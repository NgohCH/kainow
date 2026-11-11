/**
 * Disabling an account, shared by the People page (UsersService.disable) and Administrator recovery
 * (recover-admin), so the two cannot drift. Runs inside the caller's transaction; the caller decides who may be
 * disabled and nudges the email worker after it commits.
 */
import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { holdAlertEmail } from '../email/messages';
import { writeOutbox } from '../email/outbox';
import { alertRecipients, holdMembershipsOf } from '../projects/holds';
import { todayUtc8 } from '../projects/membership';

/**
 * Every project change locks its project row first; disabling locks the same rows, in id order and before the
 * accounts, so it never slips past a restore, appointment or acceptance in progress (or they past it).
 */
export async function lockProjectsOf(c: PoolClient, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await c.query(
    `SELECT id FROM projects WHERE id IN (SELECT project_id FROM memberships WHERE user_id = ANY($1::uuid[])) ORDER BY id FOR UPDATE`,
    [userIds],
  );
}

/**
 * Disables the account: sessions revoked, unused codes consumed, current memberships placed On Hold and their
 * alerts queued in the outbox, and `user.disabled` audited (with `detail` added to the held count). Returns how many
 * alerts were queued. The caller has locked the projects (lockProjectsOf) and checked that the account may be disabled.
 */
export async function disableAccount(
  c: PoolClient,
  id: string,
  actorUserId: string | null,
  now: Date,
  appUrl: string,
  detail: Record<string, unknown> = {},
): Promise<number> {
  let alerted = 0;
  await c.query(`UPDATE users SET status = 'disabled', updated_at = $2 WHERE id = $1`, [id, now]);
  await c.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [id, now]);
  await c.query('UPDATE login_codes SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL', [id, now]);
  // Current project memberships go On Hold for investigation (V1.0 account lifecycle §4).
  const today = todayUtc8(now);
  const held = await holdMembershipsOf(c, id, actorUserId, now, today);
  // The alerts are queued in this transaction, so they exist exactly when the holds do.
  for (const h of held) {
    const m = holdAlertEmail(h.projectName, `${appUrl}/#/projects/${h.projectId}/people`);
    for (const to of await alertRecipients(c, h.projectId, id, today)) {
      await writeOutbox(c, {
        toUserId: to.userId,
        toAddress: to.email,
        subject: m.subject,
        body: m.body,
        kind: 'hold_alert',
        projectId: h.projectId,
        initiatedBy: actorUserId ? 'person' : 'system',
        initiatedByUser: actorUserId ?? undefined,
        relevance: { kind: 'none', scope: 'project' },
        now,
      });
      alerted += 1;
    }
  }
  await writeAudit(c, { at: now, action: 'user.disabled', actorUserId, subjectType: 'user', subjectId: id, detail: { heldProjects: held.length, ...detail } });
  return alerted;
}
