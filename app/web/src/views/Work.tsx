import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  QUESTION_STATUS_LABEL,
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
import type { Person } from './AuthoriseForm.tsx';
import { type RequestView } from '../changes.ts';
import { ChangeRequestPanel, useRequests } from './ChangeRequest.tsx';
import { AddSubtaskForm, AmendForm, CancelForm, FollowUpForm, SupersedeForm, WithdrawForm, type WorkContext } from './ChangeForms.tsx';

interface ReviewFlag {
  id: string;
  decision: { id: string; statement: string; status: string };
  raisedAt: string;
}

interface TaskView {
  id: string;
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
  source: { quote: string } | null;
  changeWaiting: boolean;
  parentCancelled: boolean;
  deadlineReviewRequired: boolean;
  follows: { id: string; title: string } | null;
  followedBy: { id: string; title: string } | null;
  reviewFlags: ReviewFlag[];
}
interface QuestionView {
  id: string;
  text: string;
  status: QuestionStatus;
  requester: { id: string; displayName: string };
  answers: Array<{ answer: string; author: string; at: string }>;
  mayAct: QuestionAction[];
  reviewFlags: ReviewFlag[];
}
interface RiskView {
  id: string;
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
  statement: string;
  rationale: string | null;
  status: 'active' | 'superseded' | 'withdrawn' | string;
  authorisedBy: string;
  authorisedAt: string;
  replaces: { id: string; statement: string } | null;
  replacedBy: { id: string; statement: string } | null;
  changeWaiting: boolean;
  mayAct: Array<'supersede' | 'withdraw'>;
}
interface Records {
  tasks: TaskView[];
  decisions: DecisionView[];
  questions: QuestionView[];
  risks: RiskView[];
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The project's authorised work: tasks (with subtasks), questions, decisions and risks. */
export function Work({ projectId, people, canPropose, canClear }: { projectId: string; people: Person[]; canPropose: boolean; canClear: boolean }) {
  const [records, setRecords] = useState<Records | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { requests, reload: reloadRequests } = useRequests(projectId);
  const load = useCallback(() => {
    api.get<Records>(`/projects/${projectId}/records`).then(setRecords, (e: Error) => setError(e.message));
    reloadRequests();
  }, [projectId, reloadRequests]);
  useEffect(load, [load]);

  /** Sends one change and reloads; shows the server's reason when it is refused. */
  const act = useCallback(
    async (path: string, body: object, done: string) => {
      setError(null);
      setNotice(null);
      try {
        await api.post(path, body);
        setNotice(done);
        load();
        return true;
      } catch (e) {
        setError(errText(e, 'That did not work. Try again.'));
        return false;
      }
    },
    [load],
  );

  /** Proposes a change for authorisation; the request then appears under Waiting for authorisation. */
  const propose = useCallback(
    async (kind: string, targetKind: string, targetId: string, terms: Record<string, unknown>) => {
      setError(null);
      setNotice(null);
      try {
        await api.post(`/projects/${projectId}/changes`, { kind, targetKind, targetId, terms, reason: String(terms.reason ?? '') });
        setNotice('Proposed. It now waits for authorisation.');
        load();
        return true;
      } catch (e) {
        setError(errText(e, 'That did not work. Try again.'));
        return false;
      }
    },
    [projectId, load],
  );

  if (!records) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  const hasChildren = new Set(records.tasks.map((t) => t.parentId).filter(Boolean));
  const work: WorkContext = { people, tasks: records.tasks, decisions: records.decisions, questions: records.questions, risks: records.risks };
  // Waiting requests: those the viewer may approve first, then the ones they can revise, then the rest.
  const rank = (r: RequestView) => (r.mayApprove ? 0 : r.mayRevise ? 1 : 2);
  const waiting = requests.filter((r) => r.status === 'pending').sort((a, b) => rank(a) - rank(b));
  const changed = (message: string) => {
    setError(null);
    setNotice(message);
    load();
  };
  return (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      <section aria-labelledby="waiting-heading">
        <h2 id="waiting-heading">Waiting for authorisation</h2>
        {waiting.length === 0 ? (
          <p className="meta">Nothing is waiting for authorisation.</p>
        ) : (
          waiting.map((r) => <ChangeRequestPanel key={`${r.id}:${r.version}`} request={r} work={work} onChanged={changed} />)
        )}
      </section>
      <section aria-labelledby="tasks-heading">
        <h2 id="tasks-heading">Tasks</h2>
        {records.tasks.length === 0 ? (
          <p className="empty">No tasks yet. Authorise an action on the review screen to create one.</p>
        ) : (
          <ul className="plain work-list">
            {records.tasks.map((t) => (
              <TaskRow key={t.id} t={t} hasChildren={hasChildren.has(t.id)} work={work} act={act} propose={propose} canPropose={canPropose} canClear={canClear} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="questions-heading">
        <h2 id="questions-heading">Questions</h2>
        {records.questions.length === 0 ? (
          <p className="meta">No questions yet.</p>
        ) : (
          <ul className="plain work-list">
            {records.questions.map((q) => (
              <QuestionRow key={q.id} q={q} act={act} canClear={canClear} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="decisions-heading">
        <h2 id="decisions-heading">Decisions</h2>
        {records.decisions.length === 0 ? (
          <p className="meta">No decisions yet.</p>
        ) : (
          <ul className="plain work-list">
            {records.decisions.map((d) => (
              <DecisionRow key={d.id} d={d} work={work} propose={propose} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="risks-heading">
        <h2 id="risks-heading">Risks</h2>
        {records.risks.length === 0 ? (
          <p className="meta">No risks yet.</p>
        ) : (
          <ul className="plain work-list">
            {records.risks.map((r) => (
              <RiskRow key={r.id} r={r} people={people} act={act} canClear={canClear} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

type Propose = (kind: string, targetKind: string, targetId: string, terms: Record<string, unknown>) => Promise<boolean>;

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
          <span className="badge badge-pending">Review: decision changed</span>{' '}
          <span className="meta">
            “{f.decision.statement}” is now {f.decision.status}
          </span>
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

type Act = (path: string, body: object, done: string) => Promise<boolean>;
type TaskForm = TaskAction | 'amend' | 'subtask' | 'cancel' | 'followup';

function TaskRow({
  t, hasChildren, work, act, propose, canPropose, canClear,
}: {
  t: TaskView; hasChildren: boolean; work: WorkContext; act: Act; propose: Propose; canPropose: boolean; canClear: boolean;
}) {
  const [open, setOpen] = useState<TaskForm | null>(null);
  const [note, setNote] = useState('');
  const [override, setOverride] = useState('');
  const [history, setHistory] = useState<TaskHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
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
    <li className={`work-item depth-${t.depth}`}>
      <div>
        <strong>{t.title}</strong>{' '}
        <span className={`badge status-${t.status}`}>{TASK_STATUS_LABEL[t.status]}</span>
        {t.overdue && <span className="badge badge-rejected">Overdue</span>}
        {t.awaitingMembership && <span className="badge badge-pending">Awaiting Membership{t.invitation ? ` (invitation ${t.invitation})` : ''}</span>}
        {t.dueAfterParent && <span className="badge badge-pending">Due after its parent task</span>}
        {t.changeWaiting && <span className="badge badge-pending">Change waiting</span>}
        {t.deadlineReviewRequired && <span className="badge badge-rejected">Deadline review required</span>}
        {t.parentCancelled && <span className="badge badge-pending">Parent cancelled</span>}
      </div>
      <span className="meta">
        {t.assignee.displayName} · due {t.dueOn}
        {t.ownerAsWritten ? ` · the notes say: ${t.ownerAsWritten}` : ''}
        {t.follows ? ` · Follows ${t.follows.title}` : ''}
        {t.followedBy ? ` · Followed by ${t.followedBy.title}` : ''}
      </span>
      {t.source && <blockquote className="quote">{t.source.quote}</blockquote>}
      <Flags flags={t.reviewFlags} canClear={canClear} />
      {open === null && (
        <div className="decision">
          {t.mayAct.map((a) => (
            <button key={a} onClick={() => void run(a)}>
              {TASK_ACTION_LABEL[a]}
            </button>
          ))}
          {mayProposeChange && <button className="link-button" onClick={() => setOpen('amend')}>Propose a change</button>}
          {mayAddSubtask && <button className="link-button" onClick={() => setOpen('subtask')}>Add subtask</button>}
          {mayProposeChange && <button className="link-button" onClick={() => setOpen('cancel')}>Propose cancellation</button>}
          {mayFollowUp && <button className="link-button" onClick={() => setOpen('followup')}>Propose follow-up task</button>}
          <button className="link-button" aria-expanded={history !== null} onClick={() => void toggleHistory()}>
            {history ? 'Hide history' : 'History'}
          </button>
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
      {isAction(open) && (
        <form className="inline-form stack" onSubmit={submit} aria-label={`${TASK_ACTION_LABEL[open]} task`}>
          <label>
            {TASK_ACTION_PROMPT[open]} <input required value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {open === 'complete' && hasChildren && (
            <label>
              Override reason (only if subtasks are unfinished; Project Manager or Deputy)
              <input value={override} onChange={(e) => setOverride(e.target.value)} />
            </label>
          )}
          <button className="primary">{TASK_ACTION_LABEL[open]}</button>
          <button type="button" onClick={cancel}>Cancel</button>
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
            const ok = await act(`/records/tasks/${t.id}/follow-up`, body, 'Follow-up proposed. An Owner or Sponsor can authorise it from the Notes tab.');
            if (ok) setOpen(null);
            return ok;
          }}
        />
      )}
    </li>
  );
}

const DECISION_STATUS: Record<string, string> = { active: 'Active', superseded: 'Superseded', withdrawn: 'Withdrawn' };

function DecisionRow({ d, work, propose }: { d: DecisionView; work: WorkContext; propose: Propose }) {
  const [open, setOpen] = useState<'supersede' | 'withdraw' | null>(null);
  const send = (kind: string) => async (terms: Record<string, unknown>) => {
    const ok = await propose(kind, 'decision', d.id, terms);
    if (ok) setOpen(null);
    return ok;
  };
  return (
    <li className="work-item">
      <strong>{d.statement}</strong>{' '}
      <span className={`badge ${d.status === 'active' ? 'badge-approved' : 'badge-pending'}`}>{DECISION_STATUS[d.status] ?? d.status}</span>
      {d.changeWaiting && <span className="badge badge-pending">Change waiting</span>}
      <span className="meta">
        {' '}
        authorised by {d.authorisedBy}, {formatWhen(d.authorisedAt)}
        {d.rationale ? ` · ${d.rationale}` : ''}
        {d.replaces ? ` · Replaces: ${d.replaces.statement}` : ''}
        {d.replacedBy ? ` · Replaced by: ${d.replacedBy.statement}` : ''}
      </span>
      {open === null && d.mayAct.length > 0 && !d.changeWaiting && (
        <div className="decision">
          {d.mayAct.includes('supersede') && <button className="link-button" onClick={() => setOpen('supersede')}>Propose a replacement</button>}
          {d.mayAct.includes('withdraw') && <button className="link-button" onClick={() => setOpen('withdraw')}>Propose withdrawal</button>}
        </div>
      )}
      {open === 'supersede' && <SupersedeForm decision={d} work={work} onSubmit={send('supersede_decision')} onCancel={() => setOpen(null)} />}
      {open === 'withdraw' && <WithdrawForm decision={d} work={work} onSubmit={send('withdraw_decision')} onCancel={() => setOpen(null)} />}
    </li>
  );
}

const Q_LABEL: Record<QuestionAction, string> = { answer: 'Answer', resolve: 'Resolve', reopen: 'Reopen', withdraw: 'Withdraw' };
const Q_FIELD: Record<QuestionAction, { name: string; prompt: string } | null> = {
  answer: { name: 'text', prompt: 'Your answer' },
  resolve: null,
  reopen: { name: 'reason', prompt: 'Why reopen it?' },
  withdraw: { name: 'reason', prompt: 'Why withdraw it?' },
};

function QuestionRow({ q, act, canClear }: { q: QuestionView; act: Act; canClear: boolean }) {
  const [open, setOpen] = useState<QuestionAction | null>(null);
  const [value, setValue] = useState('');
  return (
    <li className="work-item">
      <div>
        <strong>{q.text}</strong> <span className="badge badge-pending">{QUESTION_STATUS_LABEL[q.status]}</span>
      </div>
      <span className="meta">Requested by {q.requester.displayName}</span>
      <Flags flags={q.reviewFlags} canClear={canClear} />
      {q.answers.length > 0 && (
        <ul className="plain answers">
          {q.answers.map((a, i) => (
            <li key={i}>
              {a.answer} <span className="meta">— {a.author}, {formatWhen(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
      {open === null ? (
        <div className="decision">
          {q.mayAct.map((a) => (
            <button key={a} onClick={() => (Q_FIELD[a] ? setOpen(a) : void act(`/records/questions/${q.id}/${a}`, {}, `${Q_LABEL[a]}: done.`))}>
              {Q_LABEL[a]}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="inline-form"
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
          <button className="primary">{Q_LABEL[open]}</button>
          <button type="button" onClick={() => setOpen(null)}>Cancel</button>
        </form>
      )}
    </li>
  );
}

const R_LABEL: Record<RiskAction, string> = { mitigate: 'Start mitigating', update: 'Update', accept: 'Accept exposure', resolve: 'Approve resolution', reopen: 'Reopen' };

function RiskRow({ r, people, act, canClear }: { r: RiskView; people: Person[]; act: Act; canClear: boolean }) {
  const [open, setOpen] = useState<RiskAction | null>(null);
  const [note, setNote] = useState('');
  const [mitigation, setMitigation] = useState(r.mitigation ?? '');
  const [responsible, setResponsible] = useState(r.responsible?.id ?? '');
  const [reviewOn, setReviewOn] = useState(r.reviewOn ?? '');
  const showFields = open === 'mitigate' || open === 'update' || open === 'accept';
  return (
    <li className="work-item">
      <div>
        <strong>{r.description}</strong> <span className="badge badge-pending">{RISK_STATUS_LABEL[r.status]}</span>{' '}
        <span className="badge">{SEVERITY_LABEL[r.severity]}</span>
      </div>
      <span className="meta">
        {r.responsible ? `Responsible: ${r.responsible.displayName}` : 'No responsible person yet'}
        {r.reviewOn ? ` · review on ${r.reviewOn}` : ''}
        {r.mitigation ? ` · mitigation: ${r.mitigation}` : ''}
        {r.handedOverFrom ? ` · Handed over from ${r.handedOverFrom.name}` : ''}
        {r.handedOverTo ? ` · Handed over to ${r.handedOverTo.name}` : ''}
      </span>
      <Flags flags={r.reviewFlags} canClear={canClear} />
      {open === null ? (
        <div className="decision">
          {r.mayAct.map((a) => (
            <button key={a} onClick={() => setOpen(a)}>
              {R_LABEL[a]}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="inline-form stack"
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
          <button className="primary">{R_LABEL[open]}</button>
          <button type="button" onClick={() => setOpen(null)}>Cancel</button>
        </form>
      )}
    </li>
  );
}
