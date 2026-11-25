import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { type EvidenceSource, evidenceView } from '../discussion.ts';
import { formatWhen } from '../format.ts';
import {
  DECISION_STATUS_LABEL,
  QUESTION_STATUS_LABEL,
  QUESTION_STATUS_MEANING,
  RISK_STATUS_MEANING,
  TASK_STATUS_MEANING,
  decisionMeaning,
  type QuestionAction,
  type QuestionStatus,
  RISK_STATUS_LABEL,
  type RiskAction,
  type RiskStatus,
  SEVERITY_LABEL,
  type Severity,
  TASK_ACTION_LABEL,
  TASK_ACTION_PROMPT,
  TASK_STATUS_LABEL,
  type TaskAction,
  type TaskHistoryEntry,
  type TaskStatus,
  historyLine,
} from '../records.ts';
import { taskHref } from '../taskPage.ts';
import { flagSentence, mayDeleteRecord } from '../history.ts';
import type { ProjectRole, ProjectStatus } from '../projects.ts';
import { DeleteAction } from './DeleteRestore.tsx';
import { QuarantineBar } from './ReportSecret.tsx';
import type { Person } from './AuthoriseForm.tsx';
import { ModeLabel } from './ProjectCalendar.tsx';
import { type RequestView } from '../changes.ts';
import { ChangeRequestPanel, useRequests } from './ChangeRequest.tsx';
import { ExportControls } from './ProjectOutputs.tsx';
import { useOutputPolicy } from './ProjectOutputSettings.tsx';
import { useFocusItem } from './useFocusItem.ts';
import { type Act, type Propose, useRecordChanges } from './useRecordChanges.ts';
import { useReturnFocus } from './useReturnFocus.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { AddSubtaskForm, AmendForm, CancelForm, FollowUpForm, SupersedeForm, WithdrawForm, type WorkContext } from './ChangeForms.tsx';

interface ReviewFlag {
  id: string;
  decision: { id: string | null; statement: string; status: string };
  raisedAt: string;
}

export interface TaskView {
  id: string;
  /** `Credential removed — under review` while the record is cleaned and under review. */
  quarantineLabel?: string | null;
  parentId: string | null;
  depth: number;
  title: string;
  assignee: { id: string; displayName: string };
  ownerAsWritten: string | null;
  dueOn: string;
  status: TaskStatus;
  overdue: boolean;
  awaitingMembership: boolean;
  invitation: string | null;
  dueAfterParent: boolean;
  mayAct: TaskAction[];
  source: EvidenceSource | null;
  changeWaiting: boolean;
  parentCancelled: boolean;
  deadlineReviewRequired: boolean;
  follows: { id: string | null; title: string } | null;
  followedBy: { id: string | null; title: string } | null;
  reviewFlags: ReviewFlag[];
}
interface QuestionView {
  id: string;
  /** `Credential removed — under review` while the record is cleaned and under review. */
  quarantineLabel?: string | null;
  text: string;
  status: QuestionStatus;
  requester: { id: string; displayName: string };
  answers: Array<{ answer: string; author: string; at: string }>;
  mayAct: QuestionAction[];
  reviewFlags: ReviewFlag[];
}
interface RiskView {
  id: string;
  /** `Credential removed — under review` while the record is cleaned and under review. */
  quarantineLabel?: string | null;
  description: string;
  severity: Severity;
  status: RiskStatus;
  mitigation: string | null;
  reviewOn: string | null;
  responsible: { id: string; displayName: string } | null;
  mayAct: RiskAction[];
  handedOverTo: { projectId: string; name: string } | null;
  handedOverFrom: { projectId: string; name: string } | null;
  reviewFlags: ReviewFlag[];
}
interface DecisionView {
  id: string;
  /** `Credential removed — under review` while the record is cleaned and under review. */
  quarantineLabel?: string | null;
  statement: string;
  rationale: string | null;
  status: 'active' | 'superseded' | 'withdrawn' | string;
  authorisedBy: string;
  authorisedAt: string;
  replaces: { id: string | null; statement: string } | null;
  replacedBy: { id: string | null; statement: string } | null;
  changeWaiting: boolean;
  mayAct: Array<'supersede' | 'withdraw'>;
}
export interface Records {
  tasks: TaskView[];
  decisions: DecisionView[];
  questions: QuestionView[];
  risks: RiskView[];
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The project's authorised work: tasks (with subtasks), questions, decisions and risks. */
export function Work({
  projectId, people, canPropose, canClear, focusId, roles, status, delegated,
}: {
  projectId: string; people: Person[]; canPropose: boolean; canClear: boolean; focusId?: string;
  roles: ProjectRole[]; status: ProjectStatus; delegated: boolean;
}) {
  const [records, setRecords] = useState<Records | null>(null);
  const mayDelete = mayDeleteRecord(roles, status, delegated);
  const { requests, reload: reloadRequests } = useRequests(projectId);
  // Whether "Export CSV" and "Save as output" are shown: the server says (D106); hidden otherwise.
  const { policy } = useOutputPolicy(projectId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<Records>(`/projects/${projectId}/records`).then(
      (r) => {
        setRecords(r);
        setLoadError(null);
      },
      (e: Error) => setLoadError(e.message),
    );
    reloadRequests();
  }, [projectId, reloadRequests]);
  useEffect(load, [load]);
  useFocusItem(focusId, records !== null);
  const { error: changeError, setError, notice, setNotice, act, propose, changed } = useRecordChanges(projectId, load);
  const error = changeError ?? loadError;

  if (!records) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  const hasChildren = new Set(records.tasks.map((t) => t.parentId).filter(Boolean));
  const work: WorkContext = { people, tasks: records.tasks, decisions: records.decisions, questions: records.questions, risks: records.risks };
  // Waiting requests: those the viewer may approve first, then the ones they can revise, then the rest.
  const rank = (r: RequestView) => (r.mayApprove ? 0 : r.mayRevise ? 1 : 2);
  const waiting = requests.filter((r) => r.status === 'pending').sort((a, b) => rank(a) - rank(b));
  const exported = (m: string) => {
    setError(null);
    setNotice(m);
  };
  const titles = new Map(records.tasks.map((t) => [t.id, t.title]));

  const taskColumns: Column<TaskView>[] = [
    {
      key: 'task',
      header: 'Task',
      sortValue: (t) => t.title.toLowerCase(),
      cell: (t) => (
        <span className={`work-title depth-${t.depth}`}>
          <a href={taskHref(projectId, t.id)}>{t.title}</a>
          {t.parentId && <span className="meta work-parent">Subtask of {titles.get(t.parentId) ?? 'another task'}</span>}
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (t) => TASK_STATUS_LABEL[t.status], cell: (t) => <TaskLabels t={t} /> },
    {
      key: 'assignee',
      header: 'Assignee',
      sortValue: (t) => t.assignee.displayName.toLowerCase(),
      cell: (t) => (
        <span>
          {t.assignee.displayName}
          {t.ownerAsWritten && <span className="meta work-parent">The notes say: {t.ownerAsWritten}</span>}
        </span>
      ),
    },
    { key: 'due', header: 'Due', sortValue: (t) => t.dueOn, cell: (t) => <span>{t.dueOn}<ModeLabel /></span> },
    {
      key: 'details',
      header: 'Details and actions',
      wide: true,
      cell: (t) => (
        <TaskDetails projectId={projectId} t={t} hasChildren={hasChildren.has(t.id)} work={work} act={act} propose={propose} canPropose={canPropose} canClear={canClear} mayDelete={mayDelete} onChanged={changed} />
      ),
    },
  ];
  const questionColumns: Column<QuestionView>[] = [
    { key: 'question', header: 'Question', sortValue: (q) => q.text.toLowerCase(), cell: (q) => q.text },
    { key: 'status', header: 'Status', sortValue: (q) => QUESTION_STATUS_LABEL[q.status], cell: (q) => <StatusLabel meaning={QUESTION_STATUS_MEANING[q.status]} word={QUESTION_STATUS_LABEL[q.status]} /> },
    { key: 'requester', header: 'Requested by', sortValue: (q) => q.requester.displayName.toLowerCase(), cell: (q) => q.requester.displayName },
    {
      key: 'details',
      header: 'Answers and actions',
      wide: true,
      cell: (q) => <QuestionDetails projectId={projectId} q={q} act={act} canClear={canClear} mayDelete={mayDelete} onChanged={changed} />,
    },
  ];
  const decisionColumns: Column<DecisionView>[] = [
    { key: 'decision', header: 'Decision', sortValue: (d) => d.statement.toLowerCase(), cell: (d) => d.statement },
    {
      key: 'status',
      header: 'Status',
      sortValue: (d) => DECISION_STATUS_LABEL[d.status] ?? d.status,
      cell: (d) => (
        <span className="label-stack">
          <StatusLabel meaning={decisionMeaning(d.status)} word={DECISION_STATUS_LABEL[d.status] ?? d.status} />
          {d.changeWaiting && <StatusLabel meaning="review" word="Change waiting" />}
        </span>
      ),
    },
    { key: 'authorised', header: 'Authorised', sortValue: (d) => d.authorisedAt, cell: (d) => `${d.authorisedBy}, ${formatWhen(d.authorisedAt)}` },
    {
      key: 'details',
      header: 'Details and actions',
      wide: true,
      cell: (d) => <DecisionDetails projectId={projectId} d={d} work={work} propose={propose} mayDelete={mayDelete} onChanged={changed} />,
    },
  ];
  const riskColumns: Column<RiskView>[] = [
    { key: 'risk', header: 'Risk', sortValue: (r) => r.description.toLowerCase(), cell: (r) => r.description },
    { key: 'status', header: 'Status', sortValue: (r) => RISK_STATUS_LABEL[r.status], cell: (r) => <StatusLabel meaning={RISK_STATUS_MEANING[r.status]} word={RISK_STATUS_LABEL[r.status]} /> },
    { key: 'severity', header: 'Severity', sortValue: (r) => SEVERITY_ORDER.indexOf(r.severity), cell: (r) => SEVERITY_LABEL[r.severity] },
    { key: 'responsible', header: 'Responsible', sortValue: (r) => r.responsible?.displayName.toLowerCase() ?? '', cell: (r) => r.responsible?.displayName ?? 'No responsible person yet' },
    { key: 'review', header: 'Review on', sortValue: (r) => r.reviewOn ?? '', cell: (r) => r.reviewOn ?? 'Not set' },
    {
      key: 'details',
      header: 'Details and actions',
      wide: true,
      cell: (r) => <RiskDetails projectId={projectId} r={r} people={people} act={act} canClear={canClear} mayDelete={mayDelete} onChanged={changed} />,
    },
  ];
  const itemId = (row: { id: string }) => `item-${row.id}`;

  return (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      <section aria-labelledby="waiting-heading" className="box">
        <h2 id="waiting-heading" className="box-title">Waiting for authorisation</h2>
        {waiting.length === 0 ? (
          <p className="meta">Nothing is waiting for authorisation.</p>
        ) : (
          waiting.map((r) => <ChangeRequestPanel key={`${r.id}:${r.version}`} request={r} work={work} onChanged={changed} projectId={projectId} />)
        )}
      </section>
      <section aria-labelledby="tasks-heading" className="box">
        <h2 id="tasks-heading" className="box-title">Tasks</h2>
        <ExportControls projectId={projectId} kind="tasks" policy={policy} onSaved={exported} />
        {records.tasks.length === 0 ? (
          <p className="empty">No tasks yet. Authorise an action on the review screen to create one.</p>
        ) : (
          <DataTable caption="Tasks, each subtask under its parent task" columns={taskColumns} rows={records.tasks} rowKey={(t) => t.id} rowId={itemId} empty="No tasks yet." />
        )}
      </section>
      <section aria-labelledby="questions-heading" className="box">
        <h2 id="questions-heading" className="box-title">Questions</h2>
        <ExportControls projectId={projectId} kind="questions" policy={policy} onSaved={exported} />
        {records.questions.length === 0 ? (
          <p className="meta">No questions yet.</p>
        ) : (
          <DataTable caption="Questions" columns={questionColumns} rows={records.questions} rowKey={(q) => q.id} rowId={itemId} empty="No questions yet." />
        )}
      </section>
      <section aria-labelledby="decisions-heading" className="box">
        <h2 id="decisions-heading" className="box-title">Decisions</h2>
        <ExportControls projectId={projectId} kind="decisions" policy={policy} onSaved={exported} />
        {records.decisions.length === 0 ? (
          <p className="meta">No decisions yet.</p>
        ) : (
          <DataTable caption="Decisions" columns={decisionColumns} rows={records.decisions} rowKey={(d) => d.id} rowId={itemId} empty="No decisions yet." />
        )}
      </section>
      <section aria-labelledby="risks-heading" className="box">
        <h2 id="risks-heading" className="box-title">Risks</h2>
        <ExportControls projectId={projectId} kind="risks" policy={policy} onSaved={exported} />
        {records.risks.length === 0 ? (
          <p className="meta">No risks yet.</p>
        ) : (
          <DataTable caption="Risks" columns={riskColumns} rows={records.risks} rowKey={(r) => r.id} rowId={itemId} empty="No risks yet." />
        )}
      </section>
    </>
  );
}

const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high', 'critical'];

/** A task's state and what else is true of it, each as a label with its symbol and word. */
export function TaskLabels({ t }: { t: TaskView & { dueSoon?: boolean } }) {
  return (
    <span className="label-stack">
      <StatusLabel meaning={TASK_STATUS_MEANING[t.status]} word={TASK_STATUS_LABEL[t.status]} />
      {t.overdue && <StatusLabel meaning="overdue" word="Overdue" />}
      {t.dueSoon && <StatusLabel meaning="dueSoon" word="Due soon" />}
      {t.awaitingMembership && <StatusLabel meaning="review" word={`Awaiting Membership${t.invitation ? ` (invitation ${t.invitation})` : ''}`} />}
      {t.dueAfterParent && <StatusLabel meaning="review" word="Due after its parent task" />}
      {t.changeWaiting && <StatusLabel meaning="review" word="Change waiting" />}
      {t.deadlineReviewRequired && <StatusLabel meaning="overdue" word="Deadline review required" />}
      {t.parentCancelled && <StatusLabel meaning="review" word="Parent cancelled" />}
    </span>
  );
}

/** "Review: decision changed" flags on a record, each with the decision and (for the Project Manager or a Deputy) Clear. */
function Flags({ flags, canClear }: { flags: ReviewFlag[]; canClear: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const shown = flags.filter((f) => !cleared.has(f.id));
  if (shown.length === 0) return null;
  return (
    <ul className="plain review-flags">
      {shown.map((f) => (
        <li key={f.id}>
          <StatusLabel meaning="review" word="Review: decision changed" />{' '}
          <span className="meta">{flagSentence(f.decision)}</span>
          {canClear && open !== f.id && (
            <button className="link-button" onClick={() => { setOpen(f.id); setError(null); }}>Clear</button>
          )}
          {open === f.id && (
            <form
              className="inline-form"
              aria-label="Clear this review flag"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.post(`/review-flags/${f.id}/clear`, { note });
                  setCleared(new Set([...cleared, f.id]));
                  setOpen(null);
                  setNote('');
                } catch (err) {
                  setError(errText(err, 'That did not work. Try again.'));
                }
              }}
            >
              <label>
                Note: what was reviewed <input required value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button className="primary">Clear</button>
              <button type="button" onClick={() => setOpen(null)}>Cancel</button>
              {error && <span role="alert" className="error">{error}</span>}
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The passage a record came from: the quote, the discussion message it came from, a review flag, or a note that the source is restricted. */
export function Evidence({ source, projectId }: { source: EvidenceSource; projectId: string }) {
  const ev = evidenceView(source, projectId);
  if (ev.kind === 'restricted') return <p className="quote restricted-evidence">{ev.text}</p>;
  return (
    <>
      <blockquote className="quote">{ev.quote}</blockquote>
      {ev.flag && <p className="warn" role="note">{ev.flag}</p>}
      {!('restricted' in source) && source.quoteChanged && <p className="warn" role="note">{source.quoteChanged}</p>}
      {ev.from && <p className="meta">{ev.href ? <a href={ev.href}>{ev.from}</a> : ev.from}</p>}
    </>
  );
}

type TaskForm = TaskAction | 'amend' | 'subtask' | 'cancel' | 'followup';

interface TaskActionsProps {
  projectId: string; t: TaskView; hasChildren: boolean; work: WorkContext; act: Act; propose: Propose; canPropose: boolean; canClear: boolean;
  mayDelete: boolean; onChanged: (message: string) => void;
}

/** A task's source, then its actions with its history: the last cell of its row. */
function TaskDetails(props: TaskActionsProps) {
  const { projectId, t } = props;
  return (
    <div className="work-details">
      {(t.follows || t.followedBy) && (
        <p className="meta">
          {t.follows ? `Follows ${t.follows.title}` : ''}
          {t.follows && t.followedBy ? ' · ' : ''}
          {t.followedBy ? `Followed by ${t.followedBy.title}` : ''}
        </p>
      )}
      {t.source && <Evidence source={t.source} projectId={projectId} />}
      <TaskActions {...props} withHistory />
    </div>
  );
}

/** A task's report button, review flags, actions and their forms: in its row of the Work tab (with its history) and on its page. */
export function TaskActions({
  projectId, t, hasChildren, work, act, propose, canPropose, canClear, mayDelete, onChanged, withHistory = false,
}: TaskActionsProps & { withHistory?: boolean }) {
  const [open, setOpen] = useState<TaskForm | null>(null);
  const [note, setNote] = useState('');
  const [override, setOverride] = useState('');
  const [history, setHistory] = useState<TaskHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Opening a form replaces the buttons, so focus goes to its first field; closing it, sent or cancelled, gives focus back to the button that opened it.
  const opener = (form: TaskForm) => `${t.id}:${form}`;
  useReturnFocus(open === null ? null : opener(open));
  const formBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open !== null) formBox.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, [open]);
  async function toggleHistory() {
    if (history) return setHistory(null);
    setHistoryError(null);
    try {
      setHistory((await api.get<{ history: TaskHistoryEntry[] }>(`/records/tasks/${t.id}`)).history);
    } catch (e) {
      setHistoryError((e as Error).message);
    }
  }
  async function run(action: TaskAction) {
    if (TASK_ACTION_PROMPT[action] === null) return act(`/records/tasks/${t.id}/${action}`, {}, `${TASK_ACTION_LABEL[action]}: done.`);
    setOpen(action);
    return true;
  }
  const isAction = (o: TaskForm | null): o is TaskAction => o !== null && o in TASK_ACTION_LABEL;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isAction(open)) return;
    if (await act(`/records/tasks/${t.id}/${open}`, { note, ...(override ? { overrideReason: override } : {}) }, `${TASK_ACTION_LABEL[open]}: done.`)) {
      setOpen(null);
      setNote('');
      setOverride('');
    }
  }
  /** Sends a proposal; closes the form when it was accepted. */
  const send = (kind: string) => async (terms: Record<string, unknown>) => {
    const ok = await propose(kind, 'task', t.id, terms);
    if (ok) setOpen(null);
    return ok;
  };
  const finished = t.status === 'completed' || t.status === 'cancelled';
  // Whether the viewer may propose is the server's call (an assignee, PM, Deputy, Owner or Sponsor); it answers with the reason.
  const mayProposeChange = canPropose && !finished && !t.changeWaiting;
  const mayAddSubtask = mayProposeChange && t.depth < 2 && work.people.length > 0;
  const mayFollowUp = canPropose && t.status === 'cancelled';
  const cancel = () => setOpen(null);
  return (
    <>
      <QuarantineBar projectId={projectId} kind="task" id={t.id} label={`task “${t.title}”`} quarantineLabel={t.quarantineLabel} onReported={() => onChanged('Reported. The task is held while the text is removed.')} />
      <Flags flags={t.reviewFlags} canClear={canClear} />
      {open === null && (
        <div className="decision">
          {t.mayAct.map((a) => (
            <button key={a} data-opener={opener(a)} onClick={() => void run(a)}>
              {TASK_ACTION_LABEL[a]}
            </button>
          ))}
          {mayProposeChange && <button className="link-button" data-opener={opener('amend')} onClick={() => setOpen('amend')}>Propose a change</button>}
          {mayAddSubtask && <button className="link-button" data-opener={opener('subtask')} onClick={() => setOpen('subtask')}>Add subtask</button>}
          {mayProposeChange && <button className="link-button" data-opener={opener('cancel')} onClick={() => setOpen('cancel')}>Propose cancellation</button>}
          {mayFollowUp && <button className="link-button" data-opener={opener('followup')} onClick={() => setOpen('followup')}>Propose follow-up task</button>}
          {withHistory && (
            <button className="link-button" aria-expanded={history !== null} onClick={() => void toggleHistory()}>
              {history ? 'Hide history' : 'History'}
            </button>
          )}
          {mayDelete && <DeleteAction kind="task" id={t.id} label={`task “${t.title}”`} onDone={onChanged} />}
        </div>
      )}
      {historyError && <p role="alert" className="error">{historyError}</p>}
      {history && (
        <ol className="history" aria-label={`History of ${t.title}`}>
          {history.map((h, i) => (
            <li key={i}>{historyLine(h)}</li>
          ))}
        </ol>
      )}
      <div ref={formBox}>
        {isAction(open) && (
          <form className="inline-form stack change-form" onSubmit={submit} aria-label={`${TASK_ACTION_LABEL[open]} task`}>
            <label>
              {TASK_ACTION_PROMPT[open]} <input required value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {open === 'complete' && hasChildren && (
              <label>
                Override reason (only if subtasks are unfinished; Project Manager or Deputy)
                <input value={override} onChange={(e) => setOverride(e.target.value)} />
              </label>
            )}
            <div className="decision">
              <button className="primary">{TASK_ACTION_LABEL[open]}</button>
              <button type="button" onClick={cancel}>Cancel</button>
            </div>
          </form>
        )}
        {open === 'amend' && <AmendForm task={t} people={work.people} onSubmit={send('amend_task')} onCancel={cancel} />}
        {open === 'subtask' && <AddSubtaskForm task={t} people={work.people} onSubmit={send('amend_task')} onCancel={cancel} />}
        {open === 'cancel' && <CancelForm task={t} tasks={work.tasks} onSubmit={send('cancel_task')} onCancel={cancel} />}
        {open === 'followup' && (
          <FollowUpForm
            task={t}
            onCancel={cancel}
            onSubmit={async (body) => {
              const ok = await act(`/records/tasks/${t.id}/follow-up`, body, 'Follow-up proposed. An Owner or Sponsor can authorise it from the Proposals tab.');
              if (ok) setOpen(null);
              return ok;
            }}
          />
        )}
      </div>
    </>
  );
}

/** A decision's rationale, what it replaces or was replaced by, and the proposals that may be made about it. */
function DecisionDetails({ projectId, d, work, propose, mayDelete, onChanged }: { projectId: string; d: DecisionView; work: WorkContext; propose: Propose; mayDelete: boolean; onChanged: (message: string) => void }) {
  const [open, setOpen] = useState<'supersede' | 'withdraw' | null>(null);
  const send = (kind: string) => async (terms: Record<string, unknown>) => {
    const ok = await propose(kind, 'decision', d.id, terms);
    if (ok) setOpen(null);
    return ok;
  };
  const notes = [d.rationale, d.replaces ? `Replaces: ${d.replaces.statement}` : null, d.replacedBy ? `Replaced by: ${d.replacedBy.statement}` : null].filter(Boolean);
  return (
    <div className="work-details">
      {notes.length > 0 && <p className="meta">{notes.join(' · ')}</p>}
      <QuarantineBar projectId={projectId} kind="decision" id={d.id} label={`decision “${d.statement}”`} quarantineLabel={d.quarantineLabel} onReported={() => onChanged('Reported. The decision is held while the text is removed.')} />
      {open === null && ((d.mayAct.length > 0 && !d.changeWaiting) || mayDelete) && (
        <div className="decision">
          {!d.changeWaiting && d.mayAct.includes('supersede') && <button className="link-button" onClick={() => setOpen('supersede')}>Propose a replacement</button>}
          {!d.changeWaiting && d.mayAct.includes('withdraw') && <button className="link-button" onClick={() => setOpen('withdraw')}>Propose withdrawal</button>}
          {mayDelete && <DeleteAction kind="decision" id={d.id} label={`decision “${d.statement}”`} onDone={onChanged} />}
        </div>
      )}
      {open === 'supersede' && <SupersedeForm decision={d} work={work} onSubmit={send('supersede_decision')} onCancel={() => setOpen(null)} />}
      {open === 'withdraw' && <WithdrawForm decision={d} work={work} onSubmit={send('withdraw_decision')} onCancel={() => setOpen(null)} />}
    </div>
  );
}

const Q_LABEL: Record<QuestionAction, string> = { answer: 'Answer', resolve: 'Resolve', reopen: 'Reopen', withdraw: 'Withdraw' };
const Q_FIELD: Record<QuestionAction, { name: string; prompt: string } | null> = {
  answer: { name: 'text', prompt: 'Your answer' },
  resolve: null,
  reopen: { name: 'reason', prompt: 'Why reopen it?' },
  withdraw: { name: 'reason', prompt: 'Why withdraw it?' },
};

/** A question's answers, flags and actions. */
function QuestionDetails({ projectId, q, act, canClear, mayDelete, onChanged }: { projectId: string; q: QuestionView; act: Act; canClear: boolean; mayDelete: boolean; onChanged: (message: string) => void }) {
  const [open, setOpen] = useState<QuestionAction | null>(null);
  const [value, setValue] = useState('');
  return (
    <div className="work-details">
      <QuarantineBar projectId={projectId} kind="question" id={q.id} label={`question “${q.text}”`} quarantineLabel={q.quarantineLabel} onReported={() => onChanged('Reported. The question is held while the text is removed.')} />
      <Flags flags={q.reviewFlags} canClear={canClear} />
      {q.answers.length > 0 ? (
        <ul className="plain answers">
          {q.answers.map((a, i) => (
            <li key={i}>
              {a.answer} <span className="meta">— {a.author}, {formatWhen(a.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="meta">No answer yet.</p>
      )}
      {open === null ? (
        <div className="decision">
          {q.mayAct.map((a) => (
            <button key={a} onClick={() => (Q_FIELD[a] ? setOpen(a) : void act(`/records/questions/${q.id}/${a}`, {}, `${Q_LABEL[a]}: done.`))}>
              {Q_LABEL[a]}
            </button>
          ))}
          {mayDelete && <DeleteAction kind="question" id={q.id} label={`question “${q.text}”`} onDone={onChanged} />}
        </div>
      ) : (
        <form
          className="inline-form stack change-form"
          aria-label={`${Q_LABEL[open]} the question`}
          onSubmit={async (e) => {
            e.preventDefault();
            const field = Q_FIELD[open];
            if (field && (await act(`/records/questions/${q.id}/${open}`, { [field.name]: value }, `${Q_LABEL[open]}: done.`))) {
              setOpen(null);
              setValue('');
            }
          }}
        >
          <label>
            {Q_FIELD[open]?.prompt} <input required value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          <div className="decision">
            <button className="primary">{Q_LABEL[open]}</button>
            <button type="button" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

const R_LABEL: Record<RiskAction, string> = { mitigate: 'Start mitigating', update: 'Update', accept: 'Accept exposure', resolve: 'Approve resolution', reopen: 'Reopen' };

/** A risk's mitigation, hand-over, flags and actions. */
function RiskDetails({ projectId, r, people, act, canClear, mayDelete, onChanged }: { projectId: string; r: RiskView; people: Person[]; act: Act; canClear: boolean; mayDelete: boolean; onChanged: (message: string) => void }) {
  const [open, setOpen] = useState<RiskAction | null>(null);
  const [note, setNote] = useState('');
  const [mitigation, setMitigation] = useState(r.mitigation ?? '');
  const [responsible, setResponsible] = useState(r.responsible?.id ?? '');
  const [reviewOn, setReviewOn] = useState(r.reviewOn ?? '');
  const showFields = open === 'mitigate' || open === 'update' || open === 'accept';
  const notes = [
    r.mitigation ? `Mitigation: ${r.mitigation}` : null,
    r.handedOverFrom ? `Handed over from ${r.handedOverFrom.name}` : null,
    r.handedOverTo ? `Handed over to ${r.handedOverTo.name}` : null,
  ].filter(Boolean);
  return (
    <div className="work-details">
      {notes.length > 0 && <p className="meta">{notes.join(' · ')}</p>}
      <Flags flags={r.reviewFlags} canClear={canClear} />
      <QuarantineBar projectId={projectId} kind="risk" id={r.id} label={`risk “${r.description}”`} quarantineLabel={r.quarantineLabel} onReported={() => onChanged('Reported. The risk is held while the text is removed.')} />
      {open === null ? (
        <div className="decision">
          {r.mayAct.map((a) => (
            <button key={a} onClick={() => setOpen(a)}>
              {R_LABEL[a]}
            </button>
          ))}
          {mayDelete && <DeleteAction kind="risk" id={r.id} label={`risk “${r.description}”`} onDone={onChanged} />}
        </div>
      ) : (
        <form
          className="inline-form stack change-form"
          aria-label={`${R_LABEL[open]}: risk`}
          onSubmit={async (e) => {
            e.preventDefault();
            const body = { note, ...(showFields ? { mitigation, responsibleId: responsible || null, reviewOn: reviewOn || null } : {}) };
            if (await act(`/records/risks/${r.id}/${open}`, body, `${R_LABEL[open]}: done.`)) {
              setOpen(null);
              setNote('');
            }
          }}
        >
          <label>
            {open === 'accept' ? 'Why accept the remaining exposure?' : open === 'resolve' ? 'How was it resolved?' : open === 'reopen' ? 'Why reopen it?' : 'What is being done?'}{' '}
            <input required value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {showFields && (
            <>
              <label>
                Mitigation <input value={mitigation} onChange={(e) => setMitigation(e.target.value)} />
              </label>
              <label>
                Risk Responsible Person
                <select value={responsible} onChange={(e) => setResponsible(e.target.value)}>
                  <option value="">Not yet</option>
                  {people.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Review date <input type="date" value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} />
              </label>
            </>
          )}
          <div className="decision">
            <button className="primary">{R_LABEL[open]}</button>
            <button type="button" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
