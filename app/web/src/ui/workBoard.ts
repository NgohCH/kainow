/** The Work tab's board and side panel (11a.2, D142): which record an address opens, and where focus goes. Pure. */
import type { BoardBox, BoardTask } from './board.ts';

type Ids = readonly { id: string }[];
type RecordIds = { tasks: Ids; decisions: Ids; questions: Ids; risks: Ids };

/** The id of the box that shows a task on the board drawn: its own box first, else the box it sits inside; null when none. */
export function boxFor(taskId: string, boxes: readonly BoardBox<BoardTask>[]): string | null {
  if (boxes.some((b) => b.task.id === taskId)) return taskId;
  return boxes.find((b) => b.subtasks.some((s) => s.task.id === taskId))?.task.id ?? null;
}

/**
 * What `#/projects/<id>/work/<focusId>` opens on the board: a task shown on it opens in the side panel; a task off the
 * board (cancelled, completed earlier) or a decision, question or risk is found by its row; anything else, nothing.
 */
export function panelTarget(focusId: string | undefined, records: RecordIds, boxes: readonly BoardBox<BoardTask>[]): 'panel' | 'list' | 'none' {
  if (!focusId) return 'none';
  if (boxFor(focusId, boxes) !== null) return 'panel';
  const known = [records.tasks, records.decisions, records.questions, records.risks].some((list) => list.some((r) => r.id === focusId));
  return known ? 'list' : 'none';
}

/** Closing the panel: focus goes back to the box, or to its column's heading when the box has left the board. */
export const focusAfterClose = (boxPresent: boolean): 'box' | 'column' => (boxPresent ? 'box' : 'column');

/** The line under the board naming the tasks only the list view shows, or null when there are none. */
export function offBoardText(count: number): string | null {
  if (count === 0) return null;
  return `${count} cancelled or completed earlier ${count === 1 ? 'is' : 'are'} in the list view`;
}

/** A project's tasks as board tasks: each with its project and its parent's title (null when the parent is not in the list). */
export function withProject<T extends { id: string; title: string; parentId: string | null }>(
  tasks: readonly T[], projectId: string, projectName: string,
): (T & { parentTitle: string | null; projectId: string; projectName: string })[] {
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  return tasks.map((t) => ({ ...t, parentTitle: t.parentId === null ? null : titles.get(t.parentId) ?? null, projectId, projectName }));
}
