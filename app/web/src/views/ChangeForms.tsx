import { type FormEvent, type ReactNode, useState } from 'react';
import { isPastDay } from '../changes.ts';
import { INVITE, type Person, who } from './AuthoriseForm.tsx';
import { NonWorkingDayNote } from './ProjectCalendar.tsx';

export interface WorkTask {
  id: string;
  parentId: string | null;
  depth: number;
  title: string;
  assignee: { id: string; displayName: string };
  dueOn: string;
  status: string;
}
export interface WorkDecision {
  id: string;
  statement: string;
  rationale: string | null;
}
/** What the forms and the request panel need to know of the project's work. */
export interface WorkContext {
  people: Person[];
  tasks: WorkTask[];
  decisions: WorkDecision[];
  questions: Array<{ id: string; text: string; status: string }>;
  risks: Array<{ id: string; description: string; status: string }>;
}

export type Submit = (terms: Record<string, unknown>) => Promise<boolean>;
const FINISHED = ['completed', 'cancelled'];

function Form({ label, children, onSubmit, onCancel, action }: { label: string; children: ReactNode; onSubmit: () => Promise<boolean>; onCancel: () => void; action: string }) {
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="inline-form stack change-form" onSubmit={submit} aria-label={label}>
      {children}
      <div className="decision">
        <button className="primary" disabled={busy}>{action}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function PastWarning({ day }: { day: string }) {
  return isPastDay(day) ? <p className="warn" role="status">This date is already past, so the task will be overdue as soon as the change is authorised.</p> : null;
}

/** A person to choose, or an email to invite. `keepLabel` set means choosing nobody is allowed ("keep the current assignee"). */
function PersonField({ label, people, value, email, onChange, onEmail, keepLabel }: {
  label: string; people: Person[]; value: string; email: string; onChange: (v: string) => void; onEmail: (v: string) => void; keepLabel?: string;
}) {
  return (
    <>
      <label>
        {label}
        <select required={keepLabel === undefined} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{keepLabel ?? 'Choose a person'}</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>{p.displayName} ({p.email})</option>
          ))}
          <option value={INVITE}>Invite by email…</option>
        </select>
      </label>
      {value === INVITE && (
        <label>
          Their work email
          <input type="email" required value={email} onChange={(e) => onEmail(e.target.value)} />
        </label>
      )}
    </>
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Propose a change to a task's wording, assignee or due date. */
export function AmendForm({ task, people, initial, onSubmit, onCancel }: { task: WorkTask; people: Person[]; initial?: Record<string, unknown>; onSubmit: Submit; onCancel: () => void }) {
  const [title, setTitle] = useState(str(initial?.title) || task.title);
  const [assignee, setAssignee] = useState(str(initial?.inviteEmail) ? INVITE : str(initial?.assigneeId));
  const [email, setEmail] = useState(str(initial?.inviteEmail));
  const [dueOn, setDueOn] = useState(str(initial?.dueOn) || task.dueOn);
  const [reason, setReason] = useState(str(initial?.reason));
  return (
    <Form
      label={`Propose a change to ${task.title}`}
      action="Propose change"
      onCancel={onCancel}
      onSubmit={() =>
        onSubmit({
          ...(title.trim() !== task.title ? { title } : {}),
          ...(assignee ? who(assignee, email) : {}),
          ...(dueOn !== task.dueOn ? { dueOn } : {}),
          reason,
        })
      }
    >
      <label>Wording <input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <PersonField label="Assignee" people={people} value={assignee} email={email} onChange={setAssignee} onEmail={setEmail} keepLabel={`Keep ${task.assignee.displayName}`} />
      <label>Due date <input type="date" required value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
      {dueOn !== task.dueOn && <PastWarning day={dueOn} />}
      {dueOn !== task.dueOn && <NonWorkingDayNote date={dueOn} />}
      <label>Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    </Form>
  );
}

/** Propose a new subtask under a task. */
export function AddSubtaskForm({ task, people, initial, onSubmit, onCancel }: { task: WorkTask; people: Person[]; initial?: Record<string, unknown>; onSubmit: Submit; onCancel: () => void }) {
  const add = obj(initial?.addSubtask);
  const [title, setTitle] = useState(str(add.title));
  const [assignee, setAssignee] = useState(str(add.inviteEmail) ? INVITE : str(add.assigneeId));
  const [email, setEmail] = useState(str(add.inviteEmail));
  const [dueOn, setDueOn] = useState(str(add.dueOn) || task.dueOn);
  const [reason, setReason] = useState(str(initial?.reason));
  return (
    <Form
      label="Propose a subtask"
      action="Propose subtask"
      onCancel={onCancel}
      onSubmit={() => onSubmit({ addSubtask: { title, ...who(assignee, email), dueOn }, reason })}
    >
      <label>Wording <input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <PersonField label="Assignee" people={people} value={assignee} email={email} onChange={setAssignee} onEmail={setEmail} />
      <label>Due date <input type="date" required value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
      <PastWarning day={dueOn} />
      <NonWorkingDayNote date={dueOn} />
      <label>Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    </Form>
  );
}

/** Every unfinished subtask below a task, at any depth, in the list's order. */
export function unfinishedBelow(tasks: WorkTask[], taskId: string): WorkTask[] {
  const out: WorkTask[] = [];
  const walk = (id: string) => {
    for (const t of tasks) {
      if (t.parentId !== id) continue;
      if (!FINISHED.includes(t.status)) out.push(t);
      walk(t.id);
    }
  };
  walk(taskId);
  return out;
}

/** Propose cancelling a task; every unfinished subtask needs a choice. */
export function CancelForm({ task, tasks, initial, onSubmit, onCancel }: { task: WorkTask; tasks: WorkTask[]; initial?: Record<string, unknown>; onSubmit: Submit; onCancel: () => void }) {
  const below = unfinishedBelow(tasks, task.id);
  const was = obj(initial?.subtasks);
  const [reason, setReason] = useState(str(initial?.reason));
  const [choice, setChoice] = useState<Record<string, string>>(Object.fromEntries(below.map((t) => [t.id, str(was[t.id])])));
  return (
    <Form label={`Propose cancelling ${task.title}`} action="Propose cancellation" onCancel={onCancel} onSubmit={() => onSubmit({ reason, subtasks: choice })}>
      <label>Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {below.length > 0 && (
        <fieldset className="subtask-row">
          <legend>What happens to the unfinished subtasks?</legend>
          {below.map((t) => (
            <label key={t.id}>
              {t.title}
              <select required value={choice[t.id] ?? ''} onChange={(e) => setChoice({ ...choice, [t.id]: e.target.value })}>
                <option value="">Choose</option>
                <option value="cancel">Cancel it too</option>
                <option value="keep">Keep it open</option>
              </select>
            </label>
          ))}
        </fieldset>
      )}
    </Form>
  );
}

/** Propose a follow-up task for a Cancelled one (a people's proposal; an Owner or Sponsor authorises it later). */
export function FollowUpForm({ task, onSubmit, onCancel }: { task: WorkTask; onSubmit: Submit; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  return (
    <Form label={`Propose a follow-up to ${task.title}`} action="Propose follow-up" onCancel={onCancel} onSubmit={() => onSubmit({ text, ...(owner ? { owner } : {}), ...(due ? { due } : {}) })}>
      <label>What should follow <textarea required rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <label>Who (optional) <input maxLength={200} value={owner} onChange={(e) => setOwner(e.target.value)} /></label>
      <label>By when (optional) <input maxLength={200} value={due} onChange={(e) => setDue(e.target.value)} /></label>
    </Form>
  );
}

type Ref = { kind: 'task' | 'question' | 'risk'; id: string };
const key = (r: Ref) => `${r.kind}:${r.id}`;

/** The open work that a decision change should send back for review. */
function AffectedPicker({ work, value, onChange }: { work: WorkContext; value: Ref[]; onChange: (v: Ref[]) => void }) {
  const options: Array<Ref & { text: string; group: string }> = [
    ...work.tasks.filter((t) => !FINISHED.includes(t.status)).map((t) => ({ kind: 'task' as const, id: t.id, text: t.title, group: 'Task' })),
    ...work.questions.filter((q) => q.status === 'open' || q.status === 'answered').map((q) => ({ kind: 'question' as const, id: q.id, text: q.text, group: 'Question' })),
    ...work.risks.filter((r) => r.status !== 'resolved').map((r) => ({ kind: 'risk' as const, id: r.id, text: r.description, group: 'Risk' })),
  ];
  const chosen = new Set(value.map(key));
  if (options.length === 0) return <p className="meta">There is no open work to send back for review.</p>;
  return (
    <fieldset className="subtask-row">
      <legend>Open work that depends on this decision (it will be flagged for review)</legend>
      {options.map((o) => (
        <label key={key(o)} className="check">
          <input
            type="checkbox"
            checked={chosen.has(key(o))}
            onChange={(e) => onChange(e.target.checked ? [...value, { kind: o.kind, id: o.id }] : value.filter((r) => key(r) !== key(o)))}
          />{' '}
          {o.group}: {o.text}
        </label>
      ))}
    </fieldset>
  );
}

const refs = (v: unknown): Ref[] => (Array.isArray(v) ? (v as Ref[]) : []);

/** Propose replacing an Active decision with a new one. */
export function SupersedeForm({ decision, work, initial, onSubmit, onCancel }: { decision: WorkDecision; work: WorkContext; initial?: Record<string, unknown>; onSubmit: Submit; onCancel: () => void }) {
  const [statement, setStatement] = useState(str(initial?.statement) || decision.statement);
  const [rationale, setRationale] = useState(str(initial?.rationale) || decision.rationale || '');
  const [reason, setReason] = useState(str(initial?.reason));
  const [affected, setAffected] = useState<Ref[]>(refs(initial?.affected));
  return (
    <Form
      label="Propose a replacement decision"
      action="Propose replacement"
      onCancel={onCancel}
      onSubmit={() => onSubmit({ statement, ...(rationale.trim() ? { rationale } : {}), reason, affected })}
    >
      <label>The new decision <textarea required rows={2} maxLength={2000} value={statement} onChange={(e) => setStatement(e.target.value)} /></label>
      <label>Rationale (optional) <textarea rows={2} maxLength={4000} value={rationale} onChange={(e) => setRationale(e.target.value)} /></label>
      <label>Why replace it <input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <AffectedPicker work={work} value={affected} onChange={setAffected} />
    </Form>
  );
}

/** Propose withdrawing an Active decision. */
export function WithdrawForm({ decision, work, initial, onSubmit, onCancel }: { decision: WorkDecision; work: WorkContext; initial?: Record<string, unknown>; onSubmit: Submit; onCancel: () => void }) {
  const [reason, setReason] = useState(str(initial?.reason));
  const [affected, setAffected] = useState<Ref[]>(refs(initial?.affected));
  return (
    <Form label={`Propose withdrawing the decision: ${decision.statement}`} action="Propose withdrawal" onCancel={onCancel} onSubmit={() => onSubmit({ reason, affected })}>
      <label>Why withdraw it <input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <AffectedPicker work={work} value={affected} onChange={setAffected} />
    </Form>
  );
}
