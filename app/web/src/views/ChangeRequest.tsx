import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { type CurrentView, type RequestView, approvalsLine, kindLabel, termsRows, waitingLine } from '../changes.ts';
import { formatWhen } from '../format.ts';
import { AddSubtaskForm, AmendForm, CancelForm, SupersedeForm, type WorkContext, WithdrawForm } from './ChangeForms.tsx';

/** A project's waiting change requests (newest first), reloaded on demand. Failing to load them leaves the list empty. */
export function useRequests(projectId: string | undefined): { requests: RequestView[]; reload: () => void } {
  const [requests, setRequests] = useState<RequestView[]>([]);
  const reload = useCallback(() => {
    if (!projectId) return;
    api.get<{ requests: RequestView[] }>(`/projects/${projectId}/changes?status=pending`).then(
      (r) => setRequests(r.requests),
      () => setRequests([]),
    );
  }, [projectId]);
  useEffect(reload, [reload]);
  return { requests, reload };
}

/** The pending request to authorise a given proposal, if there is one. */
export const pendingAuthorisation = (requests: RequestView[], proposalId: string): RequestView | undefined =>
  requests.find((r) => r.status === 'pending' && r.kind === 'authorise_proposal' && r.target.id === proposalId);

/** What the viewer already knows of the request's target, to set beside the proposal. */
function currentFor(request: RequestView, work?: WorkContext): CurrentView {
  if (!work) return {};
  const names = Object.fromEntries(work.people.map((p) => [p.userId, p.displayName]));
  const task = request.target.kind === 'task' ? work.tasks.find((t) => t.id === request.target.id) : undefined;
  const decision = request.target.kind === 'decision' ? work.decisions.find((d) => d.id === request.target.id) : undefined;
  return {
    names,
    subtaskTitles: Object.fromEntries(work.tasks.map((t) => [t.id, t.title])),
    ...(task ? { title: task.title, assigneeId: task.assignee.id, dueOn: task.dueOn } : {}),
    ...(decision ? { statement: decision.statement } : {}),
  };
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/**
 * One change request: current and proposed terms side by side, the approvals so far, the reason, and the actions
 * the server says this viewer may take (or why there are none). `onChanged` gets a short message to show.
 */
export function ChangeRequestPanel({ request, work, onChanged }: { request: RequestView; work?: WorkContext; onChanged: (message: string) => void }) {
  const [mode, setMode] = useState<'reject' | 'withdraw' | 'revise' | 'accept' | null>(null);
  const [reason, setReason] = useState('');
  const [responsible, setResponsible] = useState('');
  const [reviewOn, setReviewOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = termsRows(request.kind, request.terms, request.currentTerms ?? currentFor(request, work));
  const pending = request.status === 'pending';

  /** Sends one action; shows the server's refusal if it fails. */
  async function send(path: string, body: object, message: (r: { request: RequestView; applied?: unknown }) => string): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ request: RequestView; applied?: unknown }>(`/changes/${request.id}/${path}`, body);
      setMode(null);
      setReason('');
      onChanged(message(r));
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const approve = (terms?: object) =>
    send('approve', { version: request.version, ...(terms ? { terms } : {}) }, (r) => (r.applied ? 'Approved: the change has been made.' : `Approved. ${waitingLine(r.request)}.`));
  const needsAcceptanceTerms = request.kind === 'risk_handover';
  const reviseKinds = ['amend_task', 'cancel_task', 'supersede_decision', 'withdraw_decision'];
  const task = request.target.kind === 'task' && work ? work.tasks.find((t) => t.id === request.target.id) : undefined;
  const decision = request.target.kind === 'decision' && work ? work.decisions.find((d) => d.id === request.target.id) : undefined;
  const mayReviseHere = request.mayRevise && !!work && reviseKinds.includes(request.kind) && (task !== undefined || decision !== undefined);
  const anyAction = (request.mayApprove) || mayReviseHere || request.mayWithdraw;

  function reviseForm() {
    if (!work) return null;
    const onSubmit = async (terms: Record<string, unknown>) => send('revise', { terms, reason: String(terms.reason ?? '') }, () => 'Revised. It waits for approval again.');
    const onCancel = () => setMode(null);
    const initial = request.terms;
    if (task && request.kind === 'amend_task') {
      return initial.addSubtask !== undefined ? (
        <AddSubtaskForm task={task} people={work.people} initial={initial} onSubmit={onSubmit} onCancel={onCancel} />
      ) : (
        <AmendForm task={task} people={work.people} initial={initial} onSubmit={onSubmit} onCancel={onCancel} />
      );
    }
    if (task && request.kind === 'cancel_task') return <CancelForm task={task} tasks={work.tasks} initial={initial} onSubmit={onSubmit} onCancel={onCancel} />;
    if (decision && request.kind === 'supersede_decision') return <SupersedeForm decision={decision} work={work} initial={initial} onSubmit={onSubmit} onCancel={onCancel} />;
    if (decision && request.kind === 'withdraw_decision') return <WithdrawForm decision={decision} work={work} initial={initial} onSubmit={onSubmit} onCancel={onCancel} />;
    return null;
  }

  async function reasoned(e: FormEvent, path: 'reject' | 'withdraw', done: string) {
    e.preventDefault();
    await send(path, { reason }, () => done);
  }

  return (
    <article className="panel change-request" aria-label={`${kindLabel(request.kind)}, proposed by ${request.submittedBy}`}>
      <h3>{kindLabel(request.kind)}</h3>
      <p className="meta">
        Proposed by {request.submittedBy}, {formatWhen(request.submittedAt)}
        {request.batchId ? ' · part of a group of changes' : ''}
      </p>
      {request.offer && (
        <p>
          From {request.offer.fromProject.name}: <strong>{request.offer.risk.description}</strong> <span className="meta">(severity: {request.offer.risk.severity})</span>
        </p>
      )}
      {rows.length > 0 && (
        <table className="table terms">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Now</th>
              <th scope="col">Proposed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r.label}</th>
                <td>{r.from || '—'}</td>
                <td>{r.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {request.reason && <p>Reason: {request.reason}</p>}
      <p className="meta">{approvalsLine(request)}</p>
      {!pending && (
        <p className="meta">
          {request.status === 'authorised' ? 'Authorised.' : request.status === 'rejected' ? 'Rejected' : request.status === 'withdrawn' ? 'Withdrawn' : request.status}
          {request.outcomeReason ? `: ${request.outcomeReason}` : ''}
        </p>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {pending && mode === null && (
        <div className="decision">
          {request.mayApprove && !needsAcceptanceTerms && (
            <button className="approve" disabled={busy} onClick={() => void approve()}>Approve</button>
          )}
          {request.mayApprove && needsAcceptanceTerms && (
            <button className="approve" onClick={() => setMode('accept')}>Accept the risk</button>
          )}
          {request.mayApprove && (
            <button className="reject" onClick={() => setMode('reject')}>{needsAcceptanceTerms ? 'Decline' : 'Reject'}</button>
          )}
          {mayReviseHere && <button onClick={() => setMode('revise')}>Revise</button>}
          {request.mayWithdraw && <button onClick={() => setMode('withdraw')}>Withdraw</button>}
          {!anyAction && request.why && <span className="meta">{request.why}</span>}
        </div>
      )}
      {mode === 'accept' && (
        <form
          className="inline-form stack"
          aria-label="Accept the risk"
          onSubmit={(e) => {
            e.preventDefault();
            void approve({ responsibleId: responsible, reviewOn });
          }}
        >
          <label>
            Risk Responsible Person
            <select required value={responsible} onChange={(e) => setResponsible(e.target.value)}>
              <option value="">Choose a person</option>
              {(work?.people ?? []).map((p) => (
                <option key={p.userId} value={p.userId}>{p.displayName}</option>
              ))}
            </select>
          </label>
          <label>
            Review date <input type="date" required value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} />
          </label>
          <button className="primary" disabled={busy}>Accept</button>
          <button type="button" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {(mode === 'reject' || mode === 'withdraw') && (
        <form
          className="inline-form"
          aria-label={mode === 'reject' ? 'Reject this change' : 'Withdraw this change'}
          onSubmit={(e) => void reasoned(e, mode, mode === 'reject' ? 'Rejected.' : 'Withdrawn.')}
        >
          <label>
            Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className={mode === 'reject' ? 'reject' : 'primary'} disabled={busy}>{mode === 'reject' ? 'Reject' : 'Withdraw'}</button>
          <button type="button" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === 'revise' && reviseForm()}
    </article>
  );
}
