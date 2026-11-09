import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';

/** Called inside a successful sign-in: the person's open setup invitation, if any, is now accepted and setup closes. */
export async function acceptSetupOnSignIn(c: PoolClient, userId: string, at: Date): Promise<void> {
  const { rowCount } = await c.query(
    `UPDATE setup_invitations SET accepted_at = $2 WHERE user_id = $1 AND accepted_at IS NULL AND superseded_at IS NULL AND expires_at > $2`,
    [userId, at],
  );
  if (rowCount) await writeAudit(c, { at, action: 'setup.accepted', actorUserId: userId, subjectType: 'user', subjectId: userId });
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
