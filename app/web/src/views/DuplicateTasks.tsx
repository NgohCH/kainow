import { memo, useCallback, useMemo } from 'react';
import { type DupState, MAX_DESCRIPTION, MAX_WORDING, type Offer, type OfferedTask, type TaskDraft, allTasks, chooseAllTasks, chooseTask, fieldOf } from '../duplicate.ts';
import { CarriedField, type PartProps, type Update } from './DuplicateFields.tsx';

type Server = DupState['serverTerms'][string] | undefined;

interface RowProps {
  task: OfferedTask;
  depth: number;
  draft: TaskDraft;
  offer: Offer;
  terms: readonly string[];
  titleTick: string | undefined;
  descriptionTick: string | undefined;
  titleServer: Server;
  descriptionServer: Server;
  titleRecheck: string | undefined;
  descriptionRecheck: string | undefined;
  update: Update;
}

/** One task or subtask. Drawn again only when it changes itself, so that hundreds of them stay quick to type in. */
const TaskRow = memo(function TaskRow({ task, depth, draft, offer, terms, titleTick, descriptionTick, titleServer, descriptionServer, titleRecheck, descriptionRecheck, update }: RowProps) {
  const what = depth === 0 ? 'Task' : 'Subtask';
  const edit = useCallback((change: Partial<TaskDraft>) => update((s) => ({ ...s, tasks: { ...s.tasks, [task.id]: { ...s.tasks[task.id], ...change } } })), [task.id, update]);
  return (
    <li className={`dup-task depth-${Math.min(depth, 2)}`}>
      <label className="check dup-choose">
        <input type="checkbox" checked={draft.on} onChange={(e) => update((s) => chooseTask(s, offer, task.id, e.target.checked))} />
        <span>
          <span className="visually-hidden">Copy {what.toLowerCase()}: </span>
          {draft.on ? <span className="dup-kind">{what}</span> : draft.title}
        </span>
      </label>
      {draft.on && (
        <div className="dup-task-fields">
          <CarriedField id={task.titleKey} text={draft.title} terms={terms} confirmed={titleTick} server={titleServer} recheck={titleRecheck} offer={offer} update={update}>
            {(note) => (
              <label>
                Title
                <input id={fieldOf(task.titleKey)} maxLength={MAX_WORDING} value={draft.title} aria-describedby={note} onChange={(e) => edit({ title: e.target.value })} />
              </label>
            )}
          </CarriedField>
          <CarriedField id={task.descriptionKey} text={draft.description} terms={terms} confirmed={descriptionTick} server={descriptionServer} recheck={descriptionRecheck} offer={offer} update={update}>
            {(note) => (
              <label>
                Description (optional)
                <textarea id={fieldOf(task.descriptionKey)} rows={draft.description === '' ? 1 : 3} maxLength={MAX_DESCRIPTION} value={draft.description} aria-describedby={note} onChange={(e) => edit({ description: e.target.value })} />
              </label>
            )}
          </CarriedField>
          <label className="dup-due">
            New due date (optional)
            <input type="date" value={draft.due} onChange={(e) => edit({ due: e.target.value })} />
          </label>
        </div>
      )}
    </li>
  );
});

/** The original's tasks as a tree with tick boxes; every title, description and due date can be changed. */
export const DuplicateTasks = memo(function DuplicateTasks({ offer, state, terms, update }: PartProps) {
  const rows = useMemo(() => {
    const parents = new Map(allTasks(offer).map((t) => [t.id, t.parentId]));
    return allTasks(offer).map((task) => {
      let depth = 0;
      for (let at = parents.get(task.id); at; at = parents.get(at)) depth++;
      return { task, depth };
    });
  }, [offer]);
  const chosen = rows.filter((r) => state.tasks[r.task.id].on).length;
  if (rows.length === 0) return <p className="meta">The original has no task that can be copied.</p>;
  return (
    <>
      <p className="meta">
        Each ticked task becomes a proposal in the new project, with its subtasks. An Owner or Sponsor authorises it there and gives it a person. Old dates, people, progress and evidence are not copied.
      </p>
      <div className="dup-tools">
        <button type="button" onClick={() => update((s) => chooseAllTasks(s, offer, true))}>Select all</button>
        <button type="button" onClick={() => update((s) => chooseAllTasks(s, offer, false))}>Select none</button>
        <span role="status">{chosen.toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')} tasks and subtasks chosen</span>
      </div>
      <ul className="plain dup-tree">
        {rows.map(({ task, depth }) => (
          <TaskRow
            key={task.id}
            task={task}
            depth={depth}
            draft={state.tasks[task.id]}
            offer={offer}
            terms={terms}
            titleTick={state.confirmed[task.titleKey]}
            descriptionTick={state.confirmed[task.descriptionKey]}
            titleServer={state.serverTerms[task.titleKey]}
            descriptionServer={state.serverTerms[task.descriptionKey]}
            titleRecheck={state.recheck[task.titleKey]}
            descriptionRecheck={state.recheck[task.descriptionKey]}
            update={update}
          />
        ))}
      </ul>
    </>
  );
}, (a, b) => a.offer === b.offer && a.terms === b.terms && a.update === b.update && a.state.tasks === b.state.tasks && a.state.confirmed === b.state.confirmed && a.state.serverTerms === b.state.serverTerms && a.state.recheck === b.state.recheck);
