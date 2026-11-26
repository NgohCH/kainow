import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { RequestView } from '../changes.ts';
import type { TaskHistoryEntry, TaskStatus } from '../records.ts';
import type { ProposalRef } from '../taskPage.ts';
import type { Records, TaskView } from './Work.tsx';
import { useRecordChanges } from './useRecordChanges.ts';

export interface TaskReply {
  task: TaskView & { description: string | null; dueSoon?: boolean };
  history: TaskHistoryEntry[];
  parent: { id: string; title: string } | null;
  subtasks: Array<{ id: string; title: string; status: TaskStatus; dueOn: string }>;
  authorised: { by: string; at: string };
  blocked: { reason: string | null; by: string; at: string } | null;
  proposal: ProposalRef | null;
}
export interface TaskDetail { reply: TaskReply; records: Records; requests: RequestView[] }

const NOT_FOUND = 'Not Found';
/** A refusal to read (no access, held, deleted or unknown) hides the task; anything else keeps what is on screen. */
const isRefusal = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 403 || e.status === 404);

/**
 * One task in full, as the task page and the Work tab's side panel show it: read together with its project's records and
 * waiting requests, replaced in one step, and read again after each change. `onReloaded` hears every read that succeeds,
 * so the board beside a panel is refreshed from the same reply.
 */
export function useTaskDetail(projectId: string, taskId: string, onReloaded?: (records: Records, requests: RequestView[]) => void) {
  const [data, setData] = useState<TaskDetail | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const actionsHeading = useRef<HTMLHeadingElement>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const latest = useRef(0);
  const reloaded = useRef(onReloaded);
  reloaded.current = onReloaded;

  // Everything shown is read together and replaced in one step, so a refresh after an action never blanks the page.
  const load = useCallback(() => {
    const mine = ++latest.current;
    Promise.all([
      api.get<TaskReply>(`/records/tasks/${taskId}`),
      api.get<Records>(`/projects/${projectId}/records`),
      api.get<{ requests: RequestView[] }>(`/projects/${projectId}/changes?status=pending`).then((r) => r.requests, () => [] as RequestView[]),
    ]).then(
      ([reply, records, requests]) => {
        if (mine !== latest.current) return;
        setLoadError(null);
        reloaded.current?.(records, requests);
        // A task of another project is not this project's to show.
        if (!records.tasks.some((t) => t.id === reply.task.id)) {
          setData(null);
          setRefused(NOT_FOUND);
          return;
        }
        setRefused(null);
        setData({ reply, records, requests });
      },
      (e: Error) => {
        if (mine !== latest.current) return;
        if (isRefusal(e)) {
          setData(null);
          setRefused(e.message);
          // The task is gone or hidden: what remains of the project is read once more for the board.
          if (reloaded.current) {
            const after = latest.current;
            Promise.all([
              api.get<Records>(`/projects/${projectId}/records`),
              api.get<{ requests: RequestView[] }>(`/projects/${projectId}/changes?status=pending`).then((r) => r.requests, () => [] as RequestView[]),
            ]).then(([records, requests]) => after === latest.current && reloaded.current?.(records, requests), () => undefined);
          }
        } else setLoadError(e.message);
      },
    );
  }, [projectId, taskId]);
  // A newer read replaces an older one. A read still under way when the panel closes is kept: `onReloaded` then still
  // refreshes the board after an action taken just before closing.
  useEffect(load, [load]);

  const { error, notice, act, propose, changed } = useRecordChanges(projectId, load);

  // After an action the button that was pressed may be gone: focus then goes to the Actions heading, never to the page body.
  const acted = useRef(false);
  if (notice !== null) acted.current = true;
  useEffect(() => {
    if (!acted.current) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    (actionsHeading.current ?? message.current)?.focus();
  }, [data, refused]);

  return { data, refused, loadError, error, notice, act, propose, changed, reload: load, actionsHeading, message };
}
