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
