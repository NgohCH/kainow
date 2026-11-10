/**
 * Placing memberships On Hold when an account is disabled (V1.0 Sign-in, Access Requests and Account
 * Lifecycle §4). Runs inside the caller's transaction; alerts are sent by the caller after it commits.
 */
import type { PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { type MembershipRow, type ProjectRole, membershipState } from './membership';

export const HOLD_REASON_DISABLED = 'Account disabled';

interface Row extends MembershipRow {
  id: string;
  projectId: string;
  projectName: string;
}

const COLUMNS = `m.id, m.project_id AS "projectId", p.name AS "projectName", m.user_id AS "userId", m.role,
  to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn",
  m.revoked_at AS "revokedAt", m.held_at AS "heldAt", m.restored_at AS "restoredAt"`;

/** Holds each Scheduled or Active membership of the person; returns one entry per affected project. */
export async function holdMembershipsOf(
  c: PoolClient,
  userId: string,
  actorId: string | null,
  at: Date,
  today: string,
): Promise<Array<{ projectId: string; projectName: string; heldRole: ProjectRole }>> {
  const { rows } = await c.query(
    `SELECT ${COLUMNS} FROM memberships m JOIN projects p ON p.id = m.project_id WHERE m.user_id = $1 ORDER BY m.project_id, m.id FOR UPDATE OF m`,
    [userId],
  );
  const affected = new Map<string, { projectId: string; projectName: string; heldRole: ProjectRole }>();
  for (const r of rows as Row[]) {
    if (!['scheduled', 'active'].includes(membershipState(r, today))) continue;
    await c.query(`UPDATE memberships SET held_at = $2, held_by = $3, hold_reason = $4 WHERE id = $1`, [r.id, at, actorId, HOLD_REASON_DISABLED]);
    await c.query(
      `INSERT INTO membership_events (id, membership_id, kind, previous_starts_on, previous_expires_on, actor_id, reason, at)
       VALUES ($1, $2, 'held', $3, $4, $5, $6, $7)`,
      [uuidv7(at.getTime()), r.id, r.startsOn, r.expiresOn, actorId ?? userId, HOLD_REASON_DISABLED, at],
    );
    if (!affected.has(r.projectId)) affected.set(r.projectId, { projectId: r.projectId, projectName: r.projectName, heldRole: r.role });
  }
  return [...affected.values()];
}

/** Who to tell: the Active Project Manager, or the Active Owner and Sponsors when the PM is the one held. */
export async function alertRecipients(c: PoolClient, projectId: string, heldUserId: string, today: string): Promise<Array<{ userId: string; email: string }>> {
  const { rows } = await c.query(
    `SELECT m.user_id AS "userId", m.role, u.email, to_char(m.starts_on, 'YYYY-MM-DD') AS "startsOn",
            to_char(m.expires_on, 'YYYY-MM-DD') AS "expiresOn", m.revoked_at AS "revokedAt", m.held_at AS "heldAt", m.restored_at AS "restoredAt"
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1 AND u.status <> 'disabled'`,
    [projectId],
  );
  const active = (rows as Array<MembershipRow & { email: string }>).filter((r) => r.userId !== heldUserId && membershipState(r, today) === 'active');
  const pms = active.filter((r) => r.role === 'pm');
  const chosen = pms.length > 0 ? pms : active.filter((r) => r.role === 'owner' || r.role === 'sponsor');
  return [...new Map(chosen.map((r) => [r.email, { userId: r.userId, email: r.email }] as const)).values()];
}
