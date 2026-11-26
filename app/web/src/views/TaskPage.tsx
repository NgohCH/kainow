import type { ProjectRole, ProjectStatus } from '../projects.ts';
import type { Person } from './AuthoriseForm.tsx';
import { TaskDetailParts } from './TaskDetailParts.tsx';
import { TaskLabels } from './Work.tsx';
import { useTaskDetail } from './useTaskDetail.ts';

/** One task in full, inside its project with the Work tab open: what it is, what it came from, and the same actions as its row in Work. */
export function TaskPage({
  projectId, taskId, people, canPropose, canClear, roles, status, delegated,
}: {
  projectId: string; taskId: string; people: Person[]; canPropose: boolean; canClear: boolean;
  roles: ProjectRole[]; status: ProjectStatus; delegated: boolean;
}) {
  const { data, refused, loadError, error, notice, act, propose, changed, actionsHeading, message } = useTaskDetail(projectId, taskId);

  const back = (
    <p className="no-print">
      <a href={`#/projects/${projectId}/work${data ? `/${taskId}` : ''}`}>Back to Work</a>
    </p>
  );
  const messages = (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {notice && <p role="status" className="meta" ref={message} tabIndex={-1}>{notice}</p>}
    </>
  );
  if (!data) {
    return (
      <>
        {back}
        {messages}
        {/* Once the person has deleted or reported it themselves, the message above already says why it is gone. */}
        {refused !== null ? notice === null && <p role="alert" className="error">{refused}</p> : !loadError && <p className="loading">Loading</p>}
      </>
    );
  }

  const t = data.reply.task;
  return (
    <div className="task-page">
      {back}
      <div className="task-page-head">
        <h2>{t.title}</h2>
        <TaskLabels t={t} />
      </div>
      {messages}
      <TaskDetailParts
        detail={data}
        projectId={projectId}
        people={people}
        canPropose={canPropose}
        canClear={canClear}
        roles={roles}
        status={status}
        delegated={delegated}
        act={act}
        propose={propose}
        changed={changed}
        actionsHeading={actionsHeading}
        actionsHeadingId="task-actions-heading"
      />
    </div>
  );
}
