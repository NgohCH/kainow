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
  type TaskStatus,
} from '../records.ts';
import type { Person } from './AuthoriseForm.tsx';

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
}
interface QuestionView {
  id: string;
  text: string;
  status: QuestionStatus;
  requester: { id: string; displayName: string };
  answers: Array<{ answer: string; author: string; at: string }>;
  mayAct: QuestionAction[];
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
}
interface DecisionView {
  id: string;
  statement: string;
  rationale: string | null;
  status: string;
  authorisedBy: string;
  authorisedAt: string;
}
interface Records {
  tasks: TaskView[];
  decisions: DecisionView[];
  questions: QuestionView[];
  risks: RiskView[];
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The project's authorised work: tasks (with subtasks), questions, decisions and risks. */
export function Work({ projectId, people, canSplit }: { projectId: string; people: Person[]; canSplit: boolean }) {
  const [records, setRecords] = useState<Records | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<Records>(`/projects/${projectId}/records`).then(setRecords, (e: Error) => setError(e.message));
  }, [projectId]);
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

  if (!records) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  const hasChildren = new Set(records.tasks.map((t) => t.parentId).filter(Boolean));
  return (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      <section aria-labelledby="tasks-heading">
        <h2 id="tasks-heading">Tasks</h2>
        {records.tasks.length === 0 ? (
          <p className="empty">No tasks yet. Authorise an action on the review screen to create one.</p>
        ) : (
          <ul className="plain work-list">
            {records.tasks.map((t) => (
              <TaskRow key={t.id} t={t} hasChildren={hasChildren.has(t.id)} people={people} act={act} canSplit={canSplit} />
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
              <QuestionRow key={q.id} q={q} act={act} />
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
              <li key={d.id} className="work-item">
                <strong>{d.statement}</strong>
                <span className="meta">
                  {' '}
                  Active · authorised by {d.authorisedBy}, {formatWhen(d.authorisedAt)}
                  {d.rationale ? ` · ${d.rationale}` : ''}
                </span>
              </li>
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
              <RiskRow key={r.id} r={r} people={people} act={act} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

type Act = (path: string, body: object, done: string) => Promise<boolean>;

function TaskRow({ t, hasChildren, people, act, canSplit }: { t: TaskView; hasChildren: boolean; people: Person[]; act: Act; canSplit: boolean }) {
  const [open, setOpen] = useState<TaskAction | 'subtask' | null>(null);
  const [note, setNote] = useState('');
  const [override, setOverride] = useState('');
  const [sub, setSub] = useState({ title: '', assigneeId: '', dueOn: t.dueOn, reason: '' });
  async function run(action: TaskAction) {
    if (TASK_ACTION_PROMPT[action] === null) return act(`/records/tasks/${t.id}/${action}`, {}, `${TASK_ACTION_LABEL[action]}: done.`);
    setOpen(action);
    return true;
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (open === 'subtask') {
      if (await act(`/records/tasks/${t.id}/subtasks`, sub, 'Subtask added.')) setOpen(null);
      return;
    }
    if (!open) return;
    if (await act(`/records/tasks/${t.id}/${open}`, { note, ...(override ? { overrideReason: override } : {}) }, `${TASK_ACTION_LABEL[open]}: done.`)) {
      setOpen(null);
      setNote('');
      setOverride('');
    }
  }
  // The Project Manager or a Deputy splits work, two levels deep at most, while the project is Active (the server checks).
  const mayAddSubtask = canSplit && t.depth < 2 && t.status !== 'completed' && t.status !== 'cancelled';
  return (
    <li className={`work-item depth-${t.depth}`}>
      <div>
        <strong>{t.title}</strong>{' '}
        <span className={`badge status-${t.status}`}>{TASK_STATUS_LABEL[t.status]}</span>
        {t.overdue && <span className="badge badge-rejected">Overdue</span>}
        {t.awaitingMembership && <span className="badge badge-pending">Awaiting Membership{t.invitation ? ` (invitation ${t.invitation})` : ''}</span>}
        {t.dueAfterParent && <span className="badge badge-pending">Due after its parent task</span>}
      </div>
      <span className="meta">
        {t.assignee.displayName} · due {t.dueOn}
        {t.ownerAsWritten ? ` · the notes say: ${t.ownerAsWritten}` : ''}
      </span>
      {t.source && <blockquote className="quote">{t.source.quote}</blockquote>}
      {open === null && (
        <div className="decision">
          {t.mayAct.map((a) => (
            <button key={a} onClick={() => void run(a)}>
              {TASK_ACTION_LABEL[a]}
            </button>
          ))}
          {mayAddSubtask && people.length > 0 && <button className="link-button" onClick={() => setOpen('subtask')}>Add subtask</button>}
        </div>
      )}
      {open !== null && open !== 'subtask' && (
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
          <button type="button" onClick={() => setOpen(null)}>Cancel</button>
        </form>
      )}
      {open === 'subtask' && (
        <form className="inline-form stack" onSubmit={submit} aria-label="Add a subtask">
          <label>
            Wording <input required value={sub.title} onChange={(e) => setSub({ ...sub, title: e.target.value })} />
          </label>
          <label>
            Assignee
            <select required value={sub.assigneeId} onChange={(e) => setSub({ ...sub, assigneeId: e.target.value })}>
              <option value="">Choose a person</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due date <input type="date" required value={sub.dueOn} onChange={(e) => setSub({ ...sub, dueOn: e.target.value })} />
          </label>
          <label>
            Reason <input required value={sub.reason} onChange={(e) => setSub({ ...sub, reason: e.target.value })} />
          </label>
          <button className="primary">Add subtask</button>
          <button type="button" onClick={() => setOpen(null)}>Cancel</button>
        </form>
      )}
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

function QuestionRow({ q, act }: { q: QuestionView; act: Act }) {
  const [open, setOpen] = useState<QuestionAction | null>(null);
  const [value, setValue] = useState('');
  return (
    <li className="work-item">
      <div>
        <strong>{q.text}</strong> <span className="badge badge-pending">{QUESTION_STATUS_LABEL[q.status]}</span>
      </div>
      <span className="meta">Requested by {q.requester.displayName}</span>
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

function RiskRow({ r, people, act }: { r: RiskView; people: Person[]; act: Act }) {
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
      </span>
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
