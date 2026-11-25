import type { Pool, PoolClient } from 'pg';
import { activeManagerSql, audienceVisibleSql } from '../discussion/audience';
import { notHeldSql } from '../history/deleted-sql';
import { type ProjectContext, canReadContent } from '../projects/access.service';

/** Where a record's proposal is reviewed: on its extraction run's page, or in the project's people's proposals. */
export type ProposalLink = { kind: 'run'; runId: string; itemId: string } | { kind: 'human'; proposalId: string };

/**
 * The proposal each of the project's records came from, by record id, in one query: only those this viewer may open
 * today. A people's proposal follows `GET projects/:id/proposals` (not held); an extracted one follows
 * `GET extractions/:runId` (the source rule of AudienceService.canSeeSource, the item not held). Record ids are uuids,
 * unique across kinds. The caller has established that the viewer may read the project.
 */
export async function proposalLinks(db: Pool | PoolClient, ctx: ProjectContext, userId: string): Promise<Map<string, ProposalLink>> {
  const out = new Map<string, ProposalLink>();
  if (!canReadContent(ctx)) return out;
  const { rows } = await db.query(
    `WITH origins AS (
       SELECT id, origin_item_id, origin_proposal_id FROM tasks WHERE project_id = $1
       UNION ALL SELECT id, origin_item_id, origin_proposal_id FROM decisions WHERE project_id = $1
       UNION ALL SELECT id, origin_item_id, origin_proposal_id FROM questions WHERE project_id = $1
       UNION ALL SELECT id, origin_item_id, origin_proposal_id FROM risks WHERE project_id = $1)
     SELECT o.id, i.run_id AS "runId", i.id AS "itemId", NULL::uuid AS "proposalId"
       FROM origins o
       JOIN extraction_items i ON i.id = o.origin_item_id AND ${notHeldSql('i')}
       JOIN extraction_runs r ON r.id = i.run_id
       JOIN source_versions v ON v.id = r.source_version_id
       JOIN sources s ON s.id = v.source_id AND s.project_id = $1 AND s.kind <> 'summary'
       JOIN audiences a ON a.id = s.audience_id AND a.project_id = $1
      WHERE CASE WHEN s.publication = 'published' THEN ${audienceVisibleSql('a', '$2', '$3')}
                 ELSE s.submitted_by = $2::uuid OR ${activeManagerSql('s.project_id', '$2', '$3')} END
     UNION ALL
     SELECT o.id, NULL, NULL, h.id
       FROM origins o JOIN human_proposals h ON h.id = o.origin_proposal_id AND h.project_id = $1 AND ${notHeldSql('h')}`,
    [ctx.project.id, userId, ctx.today],
  );
  for (const r of rows) {
    out.set(r.id, r.proposalId ? { kind: 'human', proposalId: r.proposalId } : { kind: 'run', runId: r.runId, itemId: r.itemId });
  }
  return out;
}
