import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';

/** Fills in the authorise form of a copied action; nothing is authorised by it. */
export interface ProposedSubtask {
  title: string;
  description: string | null;
  due: string | null;
}

/** A person's proposal, already checked. */
export interface NewHumanProposal {
  id?: string;
  projectId: string;
  kind: string;
  text: string;
  description: string | null;
  owner: string | null;
  due: string | null;
  followsTaskId?: string;
  /** Set only on a proposal carried over by duplicating a project (D140). */
  copiedFromProjectId?: string;
  proposedSubtasks?: ProposedSubtask[];
}

/** The one way a people's proposal is written, whoever proposes it. */
export async function insertHumanProposal(c: PoolClient, p: NewHumanProposal, userId: string, at: Date): Promise<string> {
  const id = p.id ?? uuidv7(at.getTime());
  await c.query(
    `INSERT INTO human_proposals (id, project_id, kind, text, owner, due, proposed_by, proposed_at, description, follows_task_id, copied_from_project_id, proposed_subtasks)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id, p.projectId, p.kind, p.text, p.owner, p.due, userId, at, p.description, p.followsTaskId ?? null, p.copiedFromProjectId ?? null,
      p.proposedSubtasks && p.proposedSubtasks.length > 0 ? JSON.stringify(p.proposedSubtasks) : null,
    ],
  );
  await writeAudit(c, {
    at, action: 'proposal.submitted', actorUserId: userId, subjectType: 'project', subjectId: p.projectId,
    detail: { proposalId: id, kind: p.kind, ...(p.followsTaskId ? { followsTaskId: p.followsTaskId } : {}) },
  });
  return id;
}
