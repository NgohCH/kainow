import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { type PersonalDashboard, dayLabel, overdueDaysLabel } from '../dashboard.ts';
import { taskHref } from '../taskPage.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { TaskGroups } from '../ui/TaskGroups.tsx';
import { type TaskRow, statusWord, taskRows } from '../ui/home.ts';

const columns: Column<TaskRow>[] = [
  { key: 'task', header: 'Task', sortValue: (t) => t.title.toLowerCase(), cell: (t) => <a href={taskHref(t.projectId, t.id)}>{t.title}</a> },
  { key: 'project', header: 'Project', sortValue: (t) => t.projectName.toLowerCase(), cell: (t) => t.projectName },
  {
    key: 'due', header: 'Due (UTC+8)', sortValue: (t) => t.dueOn,
    cell: (t) => (
      <>
        {dayLabel(t.dueOn)}
        {t.overdueDays !== undefined && <> <StatusLabel meaning="overdue" word={overdueDaysLabel(t.overdueDays)} /></>}
      </>
    ),
  },
  { key: 'status', header: 'Status', sortValue: (t) => t.status, cell: (t) => statusWord(t.status) },
];

/** The person's tasks by project (11a.1 spec 15) or, by due date, in one table; the status and project filters apply to both. */
export function MyTasks() {
  const [d, setD] = useState<PersonalDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [project, setProject] = useState('');
  const [groupBy, setGroupBy] = useState<'project' | 'due'>('project');

  useEffect(() => {
    let stale = false;
    api.get<PersonalDashboard>('/dashboard/me?includeArchived=0&showCompleted=1').then(
      (r) => !stale && setD(r),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, []);

  const all = useMemo(() => (d ? taskRows(d.myTasks) : []), [d]);
  const statuses = useMemo(() => [...new Set(all.map((t) => t.status))].sort(), [all]);
  const projects = useMemo(() => [...new Map(all.map((t) => [t.projectId, t.projectName] as const)).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all]);
  const rows = all.filter((t) => (!status || t.status === status) && (!project || t.projectId === project));

  return (
    <main className="page">
      <PageHeader title="My tasks" intro="Your tasks in every project, overdue first." />
      {error && <p role="alert" className="error">{error}</p>}
      <div className="table-filters">
        <label>
          Group by
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value === 'due' ? 'due' : 'project')}>
            <option value="project">Project</option>
            <option value="due">Due date</option>
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{statusWord(s)}</option>)}
          </select>
        </label>
        <label>
          Project
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>
      {groupBy === 'project' && rows.length > 0 ? (
        <TaskGroups rows={rows} headingLevel={2} />
      ) : (
        <DataTable
          caption="Your tasks"
          columns={columns}
          rows={rows}
          rowKey={(t) => t.id}
          loading={!d && !error}
          empty={all.length === 0 ? 'No tasks are assigned to you.' : 'No tasks match these filters.'}
        />
      )}
    </main>
  );
}
