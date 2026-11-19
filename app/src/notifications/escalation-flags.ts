// "No independent escalation recipient" (spec §5): open tasks whose current-episode escalation found nobody to tell,
// listed for as long as that episode is overdue.
import { liveRecordSql } from '../history/deleted-sql';
import type { Pool, PoolClient } from 'pg';

export interface EscalationFlag {
  taskId: string;
  title: string;
  dueOn: string;
}

export async function escalationFlags(db: Pool | PoolClient, projectId: string, today: string): Promise<EscalationFlag[]> {
  return (await escalationFlagsFor(db, [projectId], today)).map(({ taskId, title, dueOn }) => ({ taskId, title, dueOn }));
}

/** The same flags for several projects in one query (dashboards), each with its project. */
export async function escalationFlagsFor(
  db: Pool | PoolClient,
  projectIds: string[],
  today: string,
): Promise<Array<EscalationFlag & { projectId: string }>> {
  const r = await db.query(
    `SELECT DISTINCT t.project_id AS "projectId", t.id AS "taskId", t.title, to_char(t.due_on, 'YYYY-MM-DD') AS "dueOn"
       FROM tasks t
       JOIN notification_triggers n ON n.record_kind = 'task' AND n.record_id = t.id AND n.outcome = 'no_recipient'
      WHERE t.project_id = ANY($1::uuid[]) AND t.status NOT IN ('completed', 'cancelled') AND ${liveRecordSql('t')}
        AND (
          (n.kind = 'overdue' AND t.due_on < $2::date
            AND n.key = 'task:' || t.id || ':overdue:' || to_char(t.due_on, 'YYYY-MM-DD') || ':'
                        || (SELECT count(*) FROM task_events e WHERE e.task_id = t.id AND e.kind = 'reopened'))
          OR (n.kind = 'parent_deadline' AND EXISTS (
                SELECT 1 FROM tasks pt
                 WHERE pt.id::text = n.detail->>'parentId' AND pt.status NOT IN ('completed', 'cancelled')
                   AND to_char(pt.due_on, 'YYYY-MM-DD') = n.detail->>'parentDueOn' AND pt.due_on < $2::date))
        )
      ORDER BY "dueOn", t.title, "taskId"`,
    [projectIds, today],
  );
  return r.rows as Array<EscalationFlag & { projectId: string }>;
}
