import { type FormEvent, useState } from 'react';
import type { DueReading } from '../api.ts';
import { SEVERITY_LABEL, type Severity, defaultDueOn, likelyAssignee, splitNames } from '../records.ts';

export interface Person {
  userId: string;
  displayName: string;
  email: string;
}

type Kind = 'action' | 'decision' | 'question' | 'risk';
export const INVITE = '__invite__';

/** A person picker with "Invite by email" for tasks. Returns the body fields for that person. */
function Assignee({
  label,
  people,
  value,
  onChange,
  email,
  onEmail,
}: {
  label: string;
  people: Person[];
  value: string;
  onChange: (v: string) => void;
  email: string;
  onEmail: (v: string) => void;
}) {
  return (
    <>
      <label>
        {label}
        <select required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a person</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.displayName} ({p.email})
            </option>
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

export const who = (value: string, email: string) => (value === INVITE ? { inviteEmail: email } : { assigneeId: value });

/**
 * Authorising turns a proposal into its record. For an action: one accountable person and a due date, and
 * when several people are named, optional subtasks for the others. For a question: the requester. For a
 * risk: severity and an optional responsible person.
 */
export function AuthoriseForm({
  kind,
  text,
  owner,
  due,
  people,
  meId,
  onSubmit,
  onCancel,
}: {
  kind: Kind;
  text: string;
  owner: string | null;
  due: DueReading | null;
  people: Person[];
  meId: string;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const names = splitNames(owner);
  const [lead, setLead] = useState(likelyAssignee(names[0] ?? null, people) ?? '');
  const [leadEmail, setLeadEmail] = useState('');
  const [dueOn, setDueOn] = useState((due && defaultDueOn(due)) ?? '');
  const [split, setSplit] = useState(names.length > 1);
  const [subs, setSubs] = useState(
    names.slice(1).map((n) => ({ name: n, title: `${text} (${n})`, assignee: likelyAssignee(n, people) ?? '', email: '', dueOn: (due && defaultDueOn(due)) ?? '' })),
  );
  const [requester, setRequester] = useState(meId);
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [responsible, setResponsible] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    let body: Record<string, unknown> = {};
    if (kind === 'action') {
      body = {
        ...who(lead, leadEmail),
        dueOn,
        subtasks: split ? subs.map((s) => ({ title: s.title, ...who(s.assignee, s.email), dueOn: s.dueOn })) : [],
      };
    } else if (kind === 'question') body = { requesterId: requester };
    else if (kind === 'risk') body = { severity, responsibleId: responsible || null };
    else body = { rationale };
    setBusy(true);
    try {
      await onSubmit(body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel stack authorise-form" onSubmit={submit} aria-label="Authorise this proposal">
      {kind === 'action' && (
        <>
          {owner && <p className="meta">The notes name: {owner}</p>}
          <Assignee label="Accountable person" people={people} value={lead} onChange={setLead} email={leadEmail} onEmail={setLeadEmail} />
          <label>
            Due date
            <input type="date" required value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </label>
          {names.length > 1 && (
            <label className="check">
              <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> Split into subtasks for the other people named
            </label>
          )}
          {split &&
            subs.map((s, i) => (
              <fieldset key={i} className="subtask-row">
                <legend>Subtask for {s.name}</legend>
                <label>
                  Wording
                  <input required value={s.title} onChange={(e) => setSubs(subs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                </label>
                <Assignee
                  label="Assignee"
                  people={people}
                  value={s.assignee}
                  onChange={(v) => setSubs(subs.map((x, j) => (j === i ? { ...x, assignee: v } : x)))}
                  email={s.email}
                  onEmail={(v) => setSubs(subs.map((x, j) => (j === i ? { ...x, email: v } : x)))}
                />
                <label>
                  Due date
                  <input type="date" required value={s.dueOn} onChange={(e) => setSubs(subs.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)))} />
                </label>
              </fieldset>
            ))}
        </>
      )}
      {kind === 'question' && (
        <label>
          Requester (who needs the answer)
          <select value={requester} onChange={(e) => setRequester(e.target.value)}>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'risk' && (
        <>
          <label>
            Severity
            <select required value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
              <option value="">Choose a severity</option>
              {(Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Risk Responsible Person (optional)
            <select value={responsible} onChange={(e) => setResponsible(e.target.value)}>
              <option value="">Not yet</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {kind === 'decision' && (
        <label>
          Rationale (optional)
          <textarea rows={2} maxLength={4000} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </label>
      )}
      <div className="decision">
        <button className="primary" disabled={busy}>
          Authorise
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
