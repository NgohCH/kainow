import { useEffect, useState } from 'react';
import { api } from '../api.ts';

/**
 * A task's description: the one already known, or read from the task itself (the project's list of work does not carry
 * it). Undefined until it is known, and when it cannot be read. `taskId` null reads nothing.
 */
export function useTaskDescription(taskId: string | null, known: string | null | undefined): string | null | undefined {
  const [read, setRead] = useState<{ id: string; description: string | null } | null>(null);
  const needed = taskId !== null && known === undefined;
  useEffect(() => {
    if (!needed) return;
    let stale = false;
    api.get<{ task: { description: string | null } }>(`/records/tasks/${taskId}`).then(
      (r) => !stale && setRead({ id: taskId as string, description: r.task.description }),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [needed, taskId]);
  if (known !== undefined) return known;
  return read?.id === taskId ? read?.description : undefined;
}
