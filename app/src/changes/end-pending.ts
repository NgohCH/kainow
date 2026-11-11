import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';

/** Why an AI proposal's authorisation ended when its item was rejected (the item's Reject takes no reason). */
export const PROPOSAL_REJECTED_REASON = 'The proposal was rejected.';

/**
 * Locks the pending authorisation of a proposal, if any, so a rejection takes the same lock order as an approval
 * (request, then proposal).
 */
export async function lockPendingAuthorisation(c: PoolClient, targetKind: 'extraction_item' | 'human_proposal', targetId: string): Promise<void> {
  await c.query(`SELECT 1 FROM change_requests WHERE kind = 'authorise_proposal' AND target_kind = $1 AND target_id = $2 AND status = 'pending' FOR UPDATE`, [
    targetKind, targetId,
  ]);
}

/**
 * Rejecting a proposal ends its pending authorisation in the same transaction, so a later approval cannot override
 * the rejection (spec §3.3).
 */
export async function rejectPendingAuthorisation(
  c: PoolClient,
  targetKind: 'extraction_item' | 'human_proposal',
  targetId: string,
  actorUserId: string,
  at: Date,
  reason: string,
): Promise<void> {
  const ended = await c.query(
    `UPDATE change_requests SET status = 'rejected', decided_by = $3, decided_at = $4, reason = $5
      WHERE kind = 'authorise_proposal' AND target_kind = $1 AND target_id = $2 AND status = 'pending'
      RETURNING id, project_id AS "projectId", version`,
    [targetKind, targetId, actorUserId, at, reason],
  );
  for (const r of ended.rows) {
    await writeAudit(c, {
      at,
      action: 'change.rejected',
      actorUserId,
      subjectType: 'change_request',
      subjectId: r.id,
      detail: { projectId: r.projectId, version: r.version, cause: 'proposal_rejected' },
    });
  }
}
