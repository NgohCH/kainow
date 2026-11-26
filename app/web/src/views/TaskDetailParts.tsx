import type { RefObject } from 'react';
import type { RequestView } from '../changes.ts';
import { dayLabel } from '../dashboard.ts';
import { formatWhen } from '../format.ts';
import { mayDeleteRecord } from '../history.ts';
import type { ProjectRole, ProjectStatus } from '../projects.ts';
import { TASK_STATUS_LABEL, TASK_STATUS_MEANING, historyLine } from '../records.ts';
import { NO_DESCRIPTION, blockedLine, historyChanges, statusMeaning, taskHref } from '../taskPage.ts';
import { Box } from '../ui/Box.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Person } from './AuthoriseForm.tsx';
import type { WorkContext } from './ChangeForms.tsx';
import { ChangeRequestPanel } from './ChangeRequest.tsx';
import { ModeLabel } from './ProjectCalendar.tsx';
import type { Act, Propose } from './useRecordChanges.ts';
import type { TaskDetail } from './useTaskDetail.ts';
import { Evidence, ProposalLink, TaskActions } from './Work.tsx';

export interface TaskDetailProps {
  projectId: string; people: Person[]; canPropose: boolean; canClear: boolean;
  roles: ProjectRole[]; status: ProjectStatus; delegated: boolean;
}

/**
 * The body of one task, shared by the task page and the Work tab's side panel: status and dates, description, source,
 * subtasks, waiting requests, actions with their forms, and history. `level` is the level of each part's heading.
 */
export function TaskDetailParts({
  detail, projectId, people, canPropose, canClear, roles, status, delegated, act, propose, changed, actionsHeading, actionsHeadingId, level = 3,
}: TaskDetailProps & {
  detail: TaskDetail; act: Act; propose: Propose; changed: (message: string) => void;
  actionsHeading: RefObject<HTMLHeadingElement | null>; actionsHeadingId: string; level?: 3 | 4;
}) {
  const { reply, records, requests } = detail;
  const t = reply.task;
  const work: WorkContext = {
    people,
    tasks: records.tasks.map((x) => (x.id === t.id ? { ...x, description: t.description } : x)),
    decisions: records.decisions,
    questions: records.questions,
    risks: records.risks,
  };
  // Approvals first, as on the Work tab.
  const rank = (r: RequestView) => (r.mayApprove ? 0 : r.mayRevise ? 1 : 2);
  const waiting = requests.filter((r) => r.target.kind === 'task' && r.target.id === t.id).sort((a, b) => rank(a) - rank(b));
  const names = Object.fromEntries([...people.map((p) => [p.userId, p.displayName]), [t.assignee.id, t.assignee.displayName]]);
  const related = (r: { id: string | null; title: string }) => (r.id ? <a href={taskHref(projectId, r.id)}>{r.title}</a> : r.title);
  const ActionsHeading = `h${level}` as 'h3';

  return (
    <>
      <Box title="Status and dates" headingLevel={level} meaning={TASK_STATUS_MEANING[t.status]}>
        <p>{statusMeaning(t.status)}</p>
        {reply.blocked && <p>{blockedLine(reply.blocked)}</p>}
        <dl className="facts">
          <dt>Assignee</dt>
          <dd>
            {t.assignee.displayName}
            {t.ownerAsWritten && <span className="meta work-parent">The notes say: {t.ownerAsWritten}</span>}
          </dd>
          <dt>Due</dt>
          <dd>
            {dayLabel(t.dueOn)}
            <ModeLabel />
          </dd>
          <dt>Authorised by</dt>
          <dd>{reply.authorised.by}, {formatWhen(reply.authorised.at)}</dd>
          {reply.parent && (
            <>
              <dt>Subtask of</dt>
              <dd>{related(reply.parent)}</dd>
            </>
          )}
          {t.follows && (
            <>
              <dt>Follows</dt>
              <dd>{related(t.follows)}</dd>
            </>
          )}
          {t.followedBy && (
            <>
              <dt>Followed by</dt>
              <dd>{related(t.followedBy)}</dd>
            </>
          )}
        </dl>
      </Box>
      <Box title="Description" headingLevel={level}>
        {t.description ? <p className="task-description">{t.description}</p> : <p className="meta">{NO_DESCRIPTION}</p>}
      </Box>
      <Box title="Source" headingLevel={level}>
        {t.source ? <Evidence source={t.source} projectId={projectId} /> : <p className="meta">No quote from a note or discussion.</p>}
        <ProposalLink proposal={reply.proposal} projectId={projectId} title={t.title} />
      </Box>
      <Box title="Subtasks" headingLevel={level}>
        {reply.subtasks.length === 0 ? (
          <p className="meta">No subtasks.</p>
        ) : (
          <ul className="plain task-subtasks">
            {reply.subtasks.map((s) => (
              <li key={s.id}>
                <a href={taskHref(projectId, s.id)}>{s.title}</a>{' '}
                <StatusLabel meaning={TASK_STATUS_MEANING[s.status]} word={TASK_STATUS_LABEL[s.status]} /> <span className="meta">due {dayLabel(s.dueOn)}</span>
              </li>
            ))}
          </ul>
        )}
      </Box>
      {waiting.length > 0 && (
        <Box title="Waiting for authorisation" headingLevel={level}>
          {waiting.map((r) => <ChangeRequestPanel key={`${r.id}:${r.version}`} request={r} work={work} onChanged={changed} projectId={projectId} level={level === 4 ? 5 : 3} />)}
        </Box>
      )}
      <section className="box" aria-labelledby={actionsHeadingId}>
        <ActionsHeading id={actionsHeadingId} className="box-title" tabIndex={-1} ref={actionsHeading}>Actions</ActionsHeading>
        <TaskActions
          projectId={projectId}
          t={t}
          hasChildren={reply.subtasks.length > 0}
          work={work}
          act={act}
          propose={propose}
          canPropose={canPropose}
          canClear={canClear}
          mayDelete={mayDeleteRecord(roles, status, delegated)}
          onChanged={changed}
        />
      </section>
      <Box title="History" headingLevel={level}>
        <ol className="task-history">
          {reply.history.map((h, i) => {
            const changes = historyChanges(h.detail, names);
            return (
              <li key={i}>
                {historyLine(h)}
                {changes.length > 0 && (
                  <dl className="facts">
                    {changes.flatMap((c) => [
                      <dt key={`${c.label}-from`}>{c.label} before</dt>,
                      <dd key={`${c.label}-was`}>{c.from}</dd>,
                      <dt key={`${c.label}-to`}>{c.label} after</dt>,
                      <dd key={`${c.label}-is`}>{c.to}</dd>,
                    ])}
                  </dl>
                )}
              </li>
            );
          })}
        </ol>
      </Box>
    </>
  );
}
