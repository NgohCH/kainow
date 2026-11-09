import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Project } from '../api.ts';
import { isPastDay, todayUtc8 } from '../changes.ts';
import { membershipStateLabel, type MembershipState } from '../projects.ts';
import { ChangeRequestPanel, useRequests } from './ChangeRequest.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface MarkedTask {
  id: string;
  title: string;
  depth: number;
  parentId: string | null;
  status: string;
  assignee: { id: string; displayName: string };
  membershipState: string;
  previousDueOn: string;
  parentDueOn: string | null;
  pendingRequest: { id: string; kind: string; version: number; dueOn: string | null } | null;
}
interface Review {
  projectStatus: string;
  tasks: MarkedTask[];
}
interface BatchResult {
  requestId: string;
  taskId: string;
  outcome: 'applied' | 'waiting' | 'refused';
  reason?: string;
}

const stateText = (s: string) => (s === 'none' ? 'No longer on the project' : membershipStateLabel(s as MembershipState));
const flagged = (s: string) => s === 'expired' || s === 'on_hold' || s === 'none';

/** The Deadline review screen: a new date for each marked task, the waiting requests, and finished-during-the-pause confirmations. */
export function DeadlineReview({ project }: { project: Project }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>({});
  const [reconciling, setReconciling] = useState<string | null>(null);
  const { requests, reload } = useRequests(project.id);
  const base = `#/projects/${project.id}`;

  const load = useCallback(() => {
    api.get<Review>(`/projects/${project.id}/deadline-review`).then(
      (r) => {
        setReview(r);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  }, [project.id]);
  useEffect(load, [load]);

  const changed = (message: string) => {
    setNotice(message);
    load();
    reload();
  };

  const waiting = requests.filter((r) => r.status === 'pending' && (r.kind === 'deadline_review' || r.kind === 'reconcile_completion'));
  const batches = [...new Set(waiting.filter((r) => r.kind === 'deadline_review' && r.mayApprove && r.batchId).map((r) => r.batchId as string))];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const tasks = Object.entries(dates).filter(([, d]) => d !== '').map(([taskId, dueOn]) => ({ taskId, dueOn }));
    try {
      await api.post(`/projects/${project.id}/deadline-review`, { tasks });
      setDates({});
      changed(`${tasks.length} new ${tasks.length === 1 ? 'date' : 'dates'} sent for authorisation.`);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function approveAll(batchId: string) {
    setError(null);
    setNotice(null);
    try {
      const r = await api.post<{ results: BatchResult[] }>(`/changes/batch/${batchId}/approve`);
      const count = (o: string) => r.results.filter((x) => x.outcome === o).length;
      const refused = r.results.filter((x) => x.outcome === 'refused');
      const titleOf = (id: string) => review?.tasks.find((t) => t.id === id)?.title ?? 'A task';
      changed(
        `${count('applied')} applied, ${count('waiting')} waiting for more approvals, ${refused.length} not approved.` +
          refused.map((x) => ` ${titleOf(x.taskId)}: ${x.reason ?? 'Not approved.'}`).join(''),
      );
    } catch (err) {
      setError(errText(err));
    }
  }

  const open = review?.tasks.filter((t) => !t.pendingRequest) ?? [];
  const anyDate = Object.values(dates).some((d) => d !== '');

  return (
    <>
      <p><a href={base}>Back to the project overview</a></p>
      <h2>Deadline review</h2>
      <p className="meta">
        These tasks were left unfinished when the project paused or closed. Each needs a new, authorised due date before it can restart, or
        confirmation that the work was finished.
      </p>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {!review && !error && <p className="loading">Loading</p>}
      {review && review.tasks.length === 0 && <p className="empty">No tasks are waiting for a deadline review.</p>}

      {waiting.length > 0 && (
        <section aria-labelledby="dr-waiting">
          <div className="row">
            <h3 id="dr-waiting">Waiting for authorisation</h3>
            {batches.map((b) => (
              <button key={b} className="primary" onClick={() => void approveAll(b)}>Approve all</button>
            ))}
          </div>
          {waiting.map((r) => (
            <div key={`${r.id}:${r.version}`}>
              <p><strong>{review?.tasks.find((t) => t.id === r.target.id)?.title ?? 'A task'}</strong></p>
              <ChangeRequestPanel request={r} onChanged={changed} />
            </div>
          ))}
        </section>
      )}

      {review && open.length > 0 && (
        <form className="stack" onSubmit={submit} aria-label="New due dates">
          <h3>New due dates</h3>
          <ul className="plain">
            {open.map((t) => {
              const date = dates[t.id] ?? '';
              return (
                <li key={t.id} className="panel" style={t.depth ? { marginLeft: `${t.depth * 1.5}rem` } : undefined}>
                  <p><strong>{t.title}</strong></p>
                  <p className="meta">
                    {t.status} · {t.assignee.displayName}
                    {flagged(t.membershipState) ? <span className="warn inline">{stateText(t.membershipState)}</span> : null} · was due {t.previousDueOn}
                  </p>
                  <label>
                    New due date
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDates({ ...dates, [t.id]: e.target.value })}
                      aria-describedby={`dr-hint-${t.id}`}
                    />
                  </label>
                  <span id={`dr-hint-${t.id}`} className="hint">
                    {date !== '' && date === t.previousDueOn && 'This is the date it already has. Choose a different one.'}
                    {date !== '' && isPastDay(date) && `This date is before today (${todayUtc8()}).`}
                    {date !== '' && t.parentDueOn && date > t.parentDueOn && `Later than its parent task, due ${t.parentDueOn}. It will be flagged, not changed.`}
                  </span>
                  <button type="button" className="link-button" aria-expanded={reconciling === t.id} onClick={() => setReconciling(reconciling === t.id ? null : t.id)}>
                    This work was finished during the pause
                  </button>
                  {reconciling === t.id && <ReconcileForm projectId={project.id} task={t} onDone={(m) => { setReconciling(null); changed(m); }} />}
                </li>
              );
            })}
          </ul>
          <button className="primary" disabled={!anyDate}>Send for authorisation</button>
        </form>
      )}
    </>
  );
}

function ReconcileForm({ projectId, task, onDone }: { projectId: string; task: MarkedTask; onDone: (message: string) => void }) {
  const [completedOn, setCompletedOn] = useState('');
  const [explanation, setExplanation] = useState('');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/projects/${projectId}/changes`, {
        kind: 'reconcile_completion',
        targetKind: 'task',
        targetId: task.id,
        terms: { completedOn, explanation, ...(evidence ? { evidence } : {}) },
        reason: explanation,
      });
      onDone('Sent for authorisation.');
    } catch (err) {
      setError(errText(err));
    }
  }
  return (
    <form className="change-form stack" onSubmit={submit} aria-label={`Confirm that ${task.title} was finished`}>
      <label>
        Finished on
        <input type="date" required max={todayUtc8()} value={completedOn} onChange={(e) => setCompletedOn(e.target.value)} />
      </label>
      <label>
        How it was finished
        <textarea required rows={2} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
      </label>
      <label>
        Evidence (optional text or link)
        <input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary">Send for authorisation</button>
    </form>
  );
}
