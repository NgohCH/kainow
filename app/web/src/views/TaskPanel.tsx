import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import type { RequestView } from '../changes.ts';
import { taskHref } from '../taskPage.ts';
import { leaveGuard } from '../ui/leaveGuard.ts';
import { useLeaveGuard } from '../ui/useLeaveGuard.ts';
import { TaskDetailParts, type TaskDetailProps } from './TaskDetailParts.tsx';
import { type Records, TaskLabels } from './Work.tsx';
import { useTaskDetail } from './useTaskDetail.ts';

/** Asked before what was typed in the panel is thrown away by closing it, opening another box or changing the view. */
export const PANEL_UNSAVED = 'What you typed in the task panel has not been saved and will be lost. Continue?';

/**
 * One task beside the Work tab's board (below it on narrow screens): the task page's details, actions and forms under the
 * same rules, with "Open full page" and "Close". Opening it moves focus to its heading (unless `focusHeading` is false);
 * Escape or Close calls `onClose`, which puts focus back on the board. `onChanged` hears each fresh read of the project's
 * records, so one reload after an action refreshes both the panel and the board. `onTyped` says whether a form in it holds
 * text the person typed (the leave guard is armed meanwhile).
 */
export function TaskPanel({
  projectId, taskId, onClose, onChanged, onTyped, focusHeading = true, reloadKey = 0, ...rest
}: TaskDetailProps & {
  taskId: string;
  /** A change made outside the panel: each new value reads the task (and with it the board) again. */
  reloadKey?: number;
  onClose: () => void;
  onChanged: (records: Records, requests: RequestView[]) => void;
  onTyped?: (typed: boolean) => void;
  focusHeading?: boolean;
}) {
  const { data, refused, loadError, error, notice, act, propose, changed, reload, actionsHeading, message } = useTaskDetail(projectId, taskId, onChanged);
  const firstKey = useRef(reloadKey);
  useEffect(() => {
    if (reloadKey !== firstKey.current) reload();
  }, [reloadKey, reload]);
  const id = useId();
  const headingId = `${id}-heading`;
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focusHeading) heading.current?.focus();
    // Only on opening; a reload keeps focus where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A form holding typed text arms the leave guard until it is sent or cancelled (no form is left open in the panel).
  const [typed, setTyped] = useState(false);
  useLeaveGuard(typed);
  useEffect(() => onTyped?.(typed), [typed, onTyped]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const watch = new MutationObserver(() => {
      if (!el.querySelector('form')) setTyped(false);
    });
    watch.observe(el, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);

  const close = () => {
    if (typed && !leaveGuard.mayDiscard(PANEL_UNSAVED)) return;
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    close();
  };

  const t = data?.reply.task;
  return (
    <section
      ref={root}
      className="task-panel"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      onInput={(e) => {
        if (e.target instanceof Element && e.target.closest('form')) setTyped(true);
      }}
    >
      <div className="task-panel-head">
        <h3 id={headingId} ref={heading} tabIndex={-1}>{t ? t.title : 'Task'}</h3>
        <div className="task-panel-links">
          <a href={taskHref(projectId, taskId)}>Open full page<span className="visually-hidden">{t ? `: ${t.title}` : ''}</span></a>
          <button type="button" onClick={close}>Close<span className="visually-hidden"> the task panel</span></button>
        </div>
      </div>
      {t && <TaskLabels t={t} />}
      {error && <p role="alert" className="error">{error}</p>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {notice && <p role="status" className="meta" ref={message} tabIndex={-1}>{notice}</p>}
      {data ? (
        <TaskDetailParts
          detail={data}
          projectId={projectId}
          {...rest}
          act={act}
          propose={propose}
          changed={changed}
          actionsHeading={actionsHeading}
          actionsHeadingId={`${id}-actions`}
          level={4}
        />
      ) : refused !== null ? (
        notice === null && <p role="alert" className="error">{refused}</p>
      ) : (
        !loadError && <p className="loading">Loading</p>
      )}
    </section>
  );
}
