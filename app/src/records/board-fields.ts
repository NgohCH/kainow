import type { Pool } from 'pg';

/**
 * "Due soon" by the one rule (D135, D139): not finished, not waiting for a deadline review, not overdue, and due no later
 * than `end` (the project's `dueSoonEnd`). The task page, the task list, My tasks and Needs you all ask this.
 */
export function isDueSoon(task: { status: string; dueOn: string; deadlineReviewRequired: boolean }, today: string, end: string): boolean {
  return task.status !== 'completed' && task.status !== 'cancelled' && !task.deadlineReviewRequired && task.dueOn >= today && task.dueOn <= end;
}

/**
 * The note of each Blocked task's latest block, in one query for any number of tasks. A task not in `ids` (or never
 * blocked) is absent from the map. The caller leaves out tasks that carry an under-review label.
 */
export async function latestBlockNotes(db: Pool, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = (
    await db.query(
      `SELECT DISTINCT ON (e.task_id) e.task_id AS "taskId", e.note FROM task_events e
        WHERE e.task_id = ANY($1::uuid[]) AND e.kind = 'blocked' ORDER BY e.task_id, e.at DESC, e.id DESC`,
      [ids],
    )
  ).rows as Array<{ taskId: string; note: string | null }>;
  return new Map(rows.map((r) => [r.taskId, r.note]));
}
