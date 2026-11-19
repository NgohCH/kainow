import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { QuarantineNote, ReportSecret } from './ReportSecret.tsx';
import { ApiError } from '../api.ts';
import {
  CATEGORIES,
  CATEGORY_LABEL,
  canEscalate,
  type Category,
  escalateFeedback,
  type FeedbackView,
  feedbackErrors,
  listFeedback,
  MAX_NOTE,
  sendFeedback,
  setFeedbackStatus,
  STATUS_LABEL,
  statusActions,
  TARGET_LABEL,
  type TargetKind,
} from '../feedback.ts';
import { formatWhen } from '../format.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** A "Give feedback" button that opens a small form under it. Feedback never changes the output it is about. */
export function FeedbackButton({ projectId, targetKind, targetId, label = 'Give feedback', defaultCategory = '' }: {
  projectId: string;
  targetKind: TargetKind;
  targetId: string;
  label?: string;
  defaultCategory?: Category | '';
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category | ''>(defaultCategory);
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const found = feedbackErrors(category, note);
    setProblems(found);
    if (found.length > 0 || category === '') return;
    setBusy(true);
    try {
      await sendFeedback(projectId, { targetKind, targetId, category, note: note.trim() });
      setSent(true);
      setOpen(false);
      setNote('');
      setCategory(defaultCategory);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="feedback">
      <button type="button" className="quiet" aria-expanded={open} onClick={() => { setOpen(!open); setSent(false); }}>{label}</button>
      {sent && <span role="status" className="meta"> Feedback sent. The Project Manager will see it; it does not change this output.</span>}
      {open && (
        <form className="panel stack" onSubmit={send} aria-label={`Feedback on ${TARGET_LABEL[targetKind].toLowerCase()}`} noValidate>
          <fieldset>
            <legend>What was wrong?</legend>
            {CATEGORIES.map((c) => (
              <label key={c} className="check">
                <input type="radio" name={`fb-${targetKind}-${targetId}`} checked={category === c} onChange={() => setCategory(c)} /> {CATEGORY_LABEL[c]}
              </label>
            ))}
          </fieldset>
          <label>
            Correction note
            <textarea rows={3} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} />
            <span className="hint">Do not include passwords or keys. Up to {MAX_NOTE.toLocaleString('en-US')} characters.</span>
          </label>
          {problems.length > 0 && <p role="alert" className="error">{problems.join(' ')}</p>}
          {error && <p role="alert" className="error">{error}</p>}
          <span className="actions">
            <button className="primary" disabled={busy}>Send feedback</button>
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          </span>
        </form>
      )}
    </span>
  );
}

function Item({ projectId, f, canReview, onChanged }: { projectId: string; f: FeedbackView; canReview: boolean; onChanged: (f: FeedbackView) => void }) {
  const [acting, setActing] = useState<{ kind: 'status'; to: FeedbackView['status']; label: string } | { kind: 'escalate' } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!acting) return;
    setError(null);
    if (note.trim() === '') return setError('Write a note.');
    setBusy(true);
    try {
      onChanged(acting.kind === 'status' ? await setFeedbackStatus(f.id, acting.to, note.trim()) : await escalateFeedback(f.id, note.trim()));
      setActing(null);
      setNote('');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="panel stack">
      <p>
        <strong>{CATEGORY_LABEL[f.category]}</strong> · {TARGET_LABEL[f.targetKind]} · <span className={`badge badge-${f.status}`}>{STATUS_LABEL[f.status]}</span>
        {f.escalatedAt && <span className="badge"> Escalated to the Administrator</span>}
      </p>
      <p className="meta">{f.reporterName}, {formatWhen(f.createdAt)}</p>
      <p><ReportSecret projectId={projectId} kind="feedback" id={f.id} label="this feedback note" /></p>
      <QuarantineNote text={f.quarantineLabel} />
      <p>{f.note}</p>
      {canReview && (
        <span className="actions">
          {statusActions(f.status, canReview).map((a) => (
            <button key={a.to} type="button" onClick={() => { setActing({ kind: 'status', to: a.to, label: a.label }); setNote(''); setError(null); }}>{a.label}</button>
          ))}
          {canEscalate(f, canReview) && <button type="button" onClick={() => { setActing({ kind: 'escalate' }); setNote(''); setError(null); }}>Escalate to Administrator</button>}
        </span>
      )}
      {acting && (
        <form className="stack" onSubmit={submit}>
          <label>
            {acting.kind === 'escalate' ? 'Note for the Administrator (only this note, the project, category, model and run are sent)' : `Note for “${acting.label}”`}
            <textarea rows={2} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <span className="actions">
            <button className="primary" disabled={busy}>{acting.kind === 'escalate' ? 'Escalate' : acting.label}</button>
            <button type="button" onClick={() => setActing(null)}>Cancel</button>
          </span>
        </form>
      )}
    </li>
  );
}

/** Project → Feedback. The Project Manager and Deputy see the project's feedback and can move it along; others see their own. */
export function Feedback({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ feedback: FeedbackView[]; canReview: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listFeedback(projectId).then(setData, (e) => setError(errText(e)));
  }, [projectId]);
  const changed = useCallback((f: FeedbackView) => setData((d) => (d ? { ...d, feedback: d.feedback.map((x) => (x.id === f.id ? f : x)) } : d)), []);

  if (!data) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  return (
    <section aria-label="Feedback" className="stack">
      <h2>Feedback on AI output</h2>
      <p className="meta">
        {data.canReview ? 'Everything reported on this project.' : 'What you have reported, and where it stands.'} Feedback never trains a model or changes a draft, a record or a setting.
      </p>
      {data.feedback.length === 0 && <p className="empty">No feedback yet.</p>}
      <ul className="plain stack">
        {data.feedback.map((f) => <Item key={f.id} projectId={projectId} f={f} canReview={data.canReview} onChanged={changed} />)}
      </ul>
    </section>
  );
}
