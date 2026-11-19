import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';

type Db = Pool | PoolClient;

export interface RecordDelegationRow {
  id: string;
  pmUserId: string;
  pm: string;
  by: string;
  reason: string;
  at: Date;
}

/** The project's open delegation of record deletion (D83), if any. */
export async function openRecordDelegation(db: Db, projectId: string): Promise<RecordDelegationRow | null> {
  const row = (
    await db.query(
      `SELECT d.id, d.pm_user_id AS "pmUserId", p.display_name AS pm, b.display_name AS by, d.reason, d.at
         FROM record_deletion_delegations d JOIN users p ON p.id = d.pm_user_id JOIN users b ON b.id = d.delegated_by
        WHERE d.project_id = $1 AND d.revoked_at IS NULL`,
      [projectId],
    )
  ).rows[0];
  return (row as RecordDelegationRow) ?? null;
}

/**
 * Ends the open delegation (revoked by an Owner or Sponsor, or a new Project Manager takes over). `why` is the
 * revoking person's reason, or a fixed word such as pm_changed. True when there was one.
 */
export async function endRecordDelegation(c: PoolClient, projectId: string, actorId: string, at: Date, why: string): Promise<boolean> {
  const ended = await c.query(
    `UPDATE record_deletion_delegations SET revoked_by = $2, revoked_at = $3, revoke_reason = $4 WHERE project_id = $1 AND revoked_at IS NULL RETURNING id`,
    [projectId, actorId, at, why],
  );
  if (!ended.rowCount) return false;
  await writeAudit(c, { at, action: 'record_deletion.delegation_ended', actorUserId: actorId, subjectType: 'project', subjectId: projectId, detail: { delegationId: ended.rows[0].id } });
  return true;
}
