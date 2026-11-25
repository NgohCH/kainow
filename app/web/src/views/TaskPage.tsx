import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { RequestView } from '../changes.ts';
import { dayLabel } from '../dashboard.ts';
import { formatWhen } from '../format.ts';
import { mayDeleteRecord } from '../history.ts';
import type { ProjectRole, ProjectStatus } from '../projects.ts';
import { TASK_STATUS_LABEL, TASK_STATUS_MEANING, type TaskHistoryEntry, type TaskStatus, historyLine } from '../records.ts';
import { NO_DESCRIPTION, type ProposalRef, blockedLine, historyChanges, statusMeaning, taskHref } from '../taskPage.ts';
import { Box } from '../ui/Box.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Person } from './AuthoriseForm.tsx';
import type { WorkContext } from './ChangeForms.tsx';
import { ChangeRequestPanel } from './ChangeRequest.tsx';
import { ModeLabel } from './ProjectCalendar.tsx';
import { Evidence, ProposalLink, type Records, TaskActions, TaskLabels, type TaskView } from './Work.tsx';
import { useRecordChanges } from './useRecordChanges.ts';

interface TaskReply {
  task: TaskView & { description: string | null; dueSoon?: boolean };
  history: TaskHistoryEntry[];
  parent: { id: string; title: string } | null;
  subtasks: Array<{ id: string; title: string; status: TaskStatus; dueOn: string }>;
  authorised: { by: string; at: string };
  blocked: { reason: string | null; by: string; at: string } | null;
  proposal: ProposalRef | null;
}
interface Loaded { reply: TaskReply; records: Records; requests: RequestView[] }

const NOT_FOUND = 'Not Found';
/** A refusal to read (no access, held, deleted or unknown) hides the task; anything else keeps what is on screen. */
const isRefusal = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 403 || e.status === 404);

/** One task in full, inside its project with the Work tab open: what it is, what it came from, and the same actions as its row in Work. */
export function TaskPage({
  projectId, taskId, people, canPropose, canClear, roles, status, delegated,
}: {
  projectId: string; taskId: string; people: Person[]; canPropose: boolean; canClear: boolean;
  roles: ProjectRole[]; status: ProjectStatus; delegated: boolean;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const actionsHeading = useRef<HTMLHeadingElement>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const latest = useRef(0);

  // Everything the page shows is read together and replaced in one step, so a refresh after an action never blanks the page.
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
        } else setLoadError(e.message);
      },
    );
  }, [projectId, taskId]);
  useEffect(() => {
    load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  const { error, notice, act, propose, changed } = useRecordChanges(projectId, load);

  // After an action the button that was pressed may be gone: focus then goes to the Actions heading, never to the page body.
  const acted = useRef(false);
  if (notice !== null) acted.current = true;
  useEffect(() => {
    if (!acted.current) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    (actionsHeading.current ?? message.current)?.focus();
  }, [data, refused]);

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

  const { reply, records, requests } = data;
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

  return (
    <div className="task-page">
      {back}
      <div className="task-page-head">
        <h2>{t.title}</h2>
        <TaskLabels t={t} />
      </div>
      {messages}
      <Box title="Status and dates" headingLevel={3} meaning={TASK_STATUS_MEANING[t.status]}>
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
      <Box title="Description" headingLevel={3}>
        {t.description ? <p className="task-description">{t.description}</p> : <p className="meta">{NO_DESCRIPTION}</p>}
      </Box>
      <Box title="Source" headingLevel={3}>
        {t.source ? <Evidence source={t.source} projectId={projectId} /> : <p className="meta">No quote from a note or discussion.</p>}
        <ProposalLink proposal={reply.proposal} projectId={projectId} title={t.title} />
      </Box>
      <Box title="Subtasks" headingLevel={3}>
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
        <Box title="Waiting for authorisation" headingLevel={3}>
          {waiting.map((r) => <ChangeRequestPanel key={`${r.id}:${r.version}`} request={r} work={work} onChanged={changed} projectId={projectId} />)}
        </Box>
      )}
      <section className="box" aria-labelledby="task-actions-heading">
        <h3 id="task-actions-heading" className="box-title" tabIndex={-1} ref={actionsHeading}>Actions</h3>
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
      <Box title="History" headingLevel={3}>
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
    </div>
  );
}
