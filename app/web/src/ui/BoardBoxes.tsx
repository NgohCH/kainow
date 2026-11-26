import type { NeedsYouItem } from '../dashboard.ts';
import { dayLabel } from '../dashboard.ts';
import { TASK_STATUS_LABEL, TASK_STATUS_MEANING } from '../records.ts';
import { type TaskLabelFields, TaskLabels } from '../views/Work.tsx';
import type { BoardBox, BoardTask } from './board.ts';
import { blockedText, boxName, holderText, progressText } from './boardView.ts';
import { itemDate } from './byProject.ts';
import { KIND_GROUP } from './attention.ts';
import { StatusLabel } from './StatusLabel.tsx';

/** What the board knows of a task beyond the box fields: the reason it is blocked and the task page's other flags. */
export type BoxTask = BoardTask & TaskLabelFields & { blockedReason?: string | null };

export type BoxAction = { href: string } | { onOpen: () => void; expanded?: boolean };

/** A task box: title (a link or a button), due day, who holds it, subtask progress, labels, and its subtasks. */
export function TaskBoxView<T extends BoxTask>({ box, action }: { box: BoardBox<T>; action: BoxAction }) {
  const t = box.task;
  const progress = progressText(box.progress);
  const blocked = blockedText(t.status, t.blockedReason);
  return (
    <article className="task-box" aria-label={boxName(t)}>
      <h4 className="task-box-title">
        {'href' in action ? (
          <a href={action.href}>{t.title}</a>
        ) : (
          <button type="button" className="link-button" aria-expanded={action.expanded ?? false} onClick={action.onOpen}>{t.title}</button>
        )}
      </h4>
      <TaskLabels t={t} />
      {t.quarantineLabel && <StatusLabel meaning="review" word={t.quarantineLabel} />}
      <p className="meta task-box-line">
        <span>Due {dayLabel(t.dueOn)}</span>
        <span>{holderText(t)}</span>
        {progress && <span>{progress}</span>}
      </p>
      {blocked && <p className="task-box-blocked">{blocked}</p>}
      {box.subtasks.length > 0 && (
        <ul className="task-box-subtasks">
          {box.subtasks.map(({ task: s, depth }) => (
            <li key={s.id} style={{ ['--depth' as string]: depth - 1 }}>
              <span className="task-box-sub-title">{s.title}</span>
              <StatusLabel meaning={TASK_STATUS_MEANING[s.status]} word={TASK_STATUS_LABEL[s.status]} />
              <span className="meta">{s.assignee.displayName}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** A Needs you box: what it is (a link) and its date, with the meaning of the column it stands in. */
export function AttentionBoxView({ item }: { item: NeedsYouItem }) {
  const date = itemDate(item);
  return (
    <article className="task-box attention-box">
      <h4 className="task-box-title"><a href={item.link}>{item.label}{item.count && item.count > 1 ? ` (${item.count})` : ''}</a></h4>
      <p className="meta task-box-line">
        <StatusLabel meaning={KIND_GROUP[item.kind]} />
        {date && <span>{date}</span>}
      </p>
    </article>
  );
}
