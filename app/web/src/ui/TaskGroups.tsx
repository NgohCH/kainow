import { dayLabel, overdueDaysLabel } from '../dashboard.ts';
import { taskHref } from '../taskPage.ts';
import { taskCounts, tasksByProject } from './byProject.ts';
import { type TaskRow, statusWord } from './home.ts';
import { type GroupColumn, ProjectGroups } from './ProjectGroups.tsx';
import { StatusLabel } from './StatusLabel.tsx';

function Urgency({ t }: { t: TaskRow }) {
  if (t.group === 'overdue') return <StatusLabel meaning="overdue" word={t.overdueDays === undefined ? undefined : statusWord(overdueDaysLabel(t.overdueDays))} />;
  if (t.group === 'awaitingReview') return <StatusLabel meaning="review" word="Deadline review" />;
  if (t.group === 'dueSoon') return <StatusLabel meaning="dueSoon" />;
  return <span className="project-group-plain">{t.group === 'completed' ? 'Completed' : 'Later'}</span>;
}

const columns: GroupColumn<TaskRow>[] = [
  { header: 'Urgency', kind: 'state', cell: (t) => <Urgency t={t} /> },
  { header: 'Task', kind: 'head', cell: (t) => <a href={taskHref(t.projectId, t.id)}>{t.title}</a> },
  { header: 'Status', kind: 'status', cell: (t) => (t.status === 'blocked' ? <StatusLabel meaning="blocked" /> : statusWord(t.status)) },
  { header: 'Due (UTC+8)', kind: 'date', cell: (t) => dayLabel(t.dueOn) },
];

/** A person's tasks, one box per project, on Home and on My tasks. */
export function TaskGroups({ rows, headingLevel }: { rows: TaskRow[]; headingLevel: 2 | 3 }) {
  return <ProjectGroups boxes={tasksByProject(rows)} headingLevel={headingLevel} label="Tasks" counts={taskCounts} rows={(p) => p.rows} rowKey={(t) => t.id} columns={columns} />;
}
