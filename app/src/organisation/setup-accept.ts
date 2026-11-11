import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';

export const RECOVERY_NO_LONGER_USABLE = 'This recovery link can no longer be used: an Administrator is active.';

/** An open (not accepted, not superseded) setup or recovery link, as the code that ends or accepts it needs it. */
export interface OpenInvitation {
  id: string;
  user_id: string;
  email: string;
  kind: 'setup' | 'recovery';
  prior_role: string | null;
  prior_status: string | null;
}

/**
 * Ends a link that will not be used (superseded, found expired, or refused at acceptance). The account it changed
 * is put back: a reused account gets its prior role and status again, and an account the link created is disabled.
 * Either only while the account is still the Invited one the link left (an Active account was never changed).
 */
export async function endInvitation(c: PoolClient, open: OpenInvitation, at: Date, restoreAccount = true): Promise<void> {
  await c.query(`UPDATE setup_invitations SET superseded_at = $2 WHERE id = $1`, [open.id, at]);
  await writeAudit(c, { at, action: 'setup.invitation_superseded', subjectType: 'user', subjectId: open.user_id, detail: { email: open.email } });
  if (!restoreAccount) return;
  if (open.prior_status === null) {
    await c.query(`UPDATE users SET status = 'disabled', updated_at = $2 WHERE id = $1 AND status = 'invited'`, [open.user_id, at]);
  } else {
    await c.query(`UPDATE users SET role = $2, status = $3, updated_at = $4 WHERE id = $1 AND status = 'invited'`, [
      open.user_id,
      open.prior_role,
      open.prior_status,
      at,
    ]);
  }
}

/**
 * Called inside a successful sign-in, before the account is made Active: the person's open link, if any, is accepted
 * and the account becomes an Enterprise Administrator. A recovery link is refused (and ended) when another Enterprise
 * Administrator is Active by then; the caller then refuses the sign-in.
 */
export async function acceptSetupOnSignIn(c: PoolClient, userId: string, at: Date): Promise<'none' | 'accepted' | 'refused'> {
  const open = (
    await c.query<OpenInvitation>(
      `SELECT id, user_id, email, kind, prior_role, prior_status FROM setup_invitations
        WHERE user_id = $1 AND accepted_at IS NULL AND superseded_at IS NULL AND expires_at > $2 FOR UPDATE`,
      [userId, at],
    )
  ).rows[0];
  if (!open) return 'none';
  if (open.kind === 'recovery') {
    const other = await c.query(`SELECT 1 FROM users WHERE role = 'enterprise_administrator' AND status = 'active' AND id <> $1 LIMIT 1`, [userId]);
    if (other.rowCount) {
      await endInvitation(c, open, at);
      return 'refused';
    }
  }
  await c.query(`UPDATE setup_invitations SET accepted_at = $2 WHERE id = $1`, [open.id, at]);
  await c.query(`UPDATE users SET role = 'enterprise_administrator', updated_at = $2 WHERE id = $1`, [userId, at]);
  await writeAudit(c, {
    at,
    action: open.kind === 'recovery' ? 'admin.recovery_accepted' : 'setup.accepted',
    actorUserId: userId,
    subjectType: 'user',
    subjectId: userId,
  });
  return 'accepted';
}

/**
 * True when this account was invited to set up Kainow but none of its setup invitations can still be used (expired or
 * replaced): it may not sign in, so the link's expiry really ends the invitation.
 */
export async function setupLapsed(db: Pick<PoolClient, 'query'>, userId: string, status: string, at: Date): Promise<boolean> {
  if (status !== 'invited') return false;
  const { rows } = await db.query(
    `SELECT count(*)::int AS invitations,
            count(*) FILTER (WHERE accepted_at IS NULL AND superseded_at IS NULL AND expires_at > $2)::int AS usable
       FROM setup_invitations WHERE user_id = $1`,
    [userId, at],
  );
  return rows[0].invitations > 0 && rows[0].usable === 0;
}
