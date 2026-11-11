import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type DueReading } from '../api.ts';
import { formatWhen } from '../format.ts';
import { AuthoriseForm, type Person } from './AuthoriseForm.tsx';
import { useFocusItem } from './useFocusItem.ts';
import { ChangeRequestPanel, pendingAuthorisation, useRequests } from './ChangeRequest.tsx';
import { waitingLine, type RequestView } from '../changes.ts';

type Kind = 'action' | 'decision' | 'question' | 'risk';
interface Proposal {
  id: string;
  kind: Kind;
  text: string;
  owner: string | null;
  due: string | null;
  proposedBy: string;
  proposedAt: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  rejectReason: string | null;
  label: string;
  record: { kind: string; id: string } | null;
  dueReading: DueReading;
}

const KIND_LABEL: Record<Kind, string> = { action: 'Action', decision: 'Decision', question: 'Question', risk: 'Risk' };

/** People's own proposals, without a discussion source: propose, and (Owner or Sponsor) authorise or reject. */
export function HumanProposals({
  projectId,
  canPropose,
  canReview,
  people,
  meId,
  focusId,
}: {
  projectId: string;
  canPropose: boolean;
  canReview: boolean;
  people: Person[];
  meId: string;
  focusId?: string;
}) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ kind: 'action' as Kind, text: '', owner: '', due: '' });
  const [authorising, setAuthorising] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const { requests, reload: reloadRequests } = useRequests(projectId);

  const load = useCallback(() => {
    api.get<{ proposals: Proposal[] }>(`/projects/${projectId}/proposals`).then((r) => setProposals(r.proposals), (e: Error) => setError(e.message));
    reloadRequests();
  }, [projectId, reloadRequests]);
  useEffect(load, [load]);
  useFocusItem(focusId, proposals.length > 0);

  async function run(work: () => Promise<unknown>, done: string | ((result: unknown) => string)) {
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      setNotice(typeof done === 'string' ? done : done(result));
      load();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
      return false;
    }
  }

  async function propose(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api.post(`/projects/${projectId}/proposals`, form), 'Proposed. The Owner or a Sponsor reviews it.')) {
      setOpen(false);
      setForm({ kind: 'action', text: '', owner: '', due: '' });
    }
  }

  return (
    <section aria-labelledby="human-proposals-heading">
      <div className="row">
        <h2 id="human-proposals-heading">Proposals from people</h2>
        {canPropose && (
          <button className="quiet" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Close' : 'Propose something'}
          </button>
        )}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {open && (
        <form className="panel stack" onSubmit={propose} aria-label="Propose something">
          <label>
            Kind
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })}>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            What you propose
            <textarea required rows={3} maxLength={2000} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          </label>
          {form.kind === 'action' && (
            <div className="grid-2">
              <label>
                Who (optional)
                <input maxLength={200} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
              </label>
              <label>
                By when (optional)
                <input maxLength={200} value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
              </label>
            </div>
          )}
          <button className="primary">Propose</button>
          <p className="meta">It is labelled "Human proposal — no discussion source" with your name, and becomes a record only when the Owner or a Sponsor authorises it.</p>
        </form>
      )}
      {proposals.length === 0 ? (
        <p className="meta">None yet.</p>
      ) : (
        <ul className="plain work-list">
          {proposals.map((p) => (
            <li key={p.id} id={`item-${p.id}`} tabIndex={-1} className="work-item">
              <div>
                <span className="badge">{KIND_LABEL[p.kind]}</span> <strong>{p.text}</strong>
              </div>
              <span className="meta">
                {p.label}, by {p.proposedBy}, {formatWhen(p.proposedAt)}
                {p.owner ? ` · who: ${p.owner}` : ''}
                {p.due ? ` · by when: ${p.due}` : ''}
                {p.reviewStatus === 'rejected' ? ` · rejected: ${p.rejectReason}` : ''}
                {p.record ? ' · authorised (see the Work tab)' : ''}
              </span>
              {canReview && p.reviewStatus === 'pending' && authorising !== p.id && rejecting !== p.id && !pendingAuthorisation(requests, p.id) && (
                <div className="decision">
                  <button className="approve" onClick={() => setAuthorising(p.id)}>Authorise</button>
                  <button className="reject" onClick={() => setRejecting(p.id)}>Reject</button>
                </div>
              )}
              {p.reviewStatus === 'pending' && pendingAuthorisation(requests, p.id) && (
                <ChangeRequestPanel request={pendingAuthorisation(requests, p.id) as RequestView} onChanged={(m) => void run(async () => undefined, m)} />
              )}
              {authorising === p.id && !pendingAuthorisation(requests, p.id) && (
                <AuthoriseForm
                  kind={p.kind}
                  text={p.text}
                  owner={p.owner}
                  due={p.dueReading}
                  people={people}
                  meId={meId}
                  onSubmit={async (body) => {
                    const ok = await run(
                      () => api.post<{ request?: RequestView }>(`/proposals/${p.id}/authorise`, body),
                      (r) => ((r as { request?: RequestView }).request ? `${waitingLine((r as { request: RequestView }).request)}. Another Owner or Sponsor can approve it here.` : 'Authorised: it is now on the Work tab.'),
                    );
                    if (ok) setAuthorising(null);
                    return ok;
                  }}
                  onCancel={() => setAuthorising(null)}
                />
              )}
              {rejecting === p.id && (
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => api.post(`/proposals/${p.id}/reject`, { reason }), 'Rejected.')) {
                      setRejecting(null);
                      setReason('');
                    }
                  }}
                >
                  <label>
                    Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} />
                  </label>
                  <button className="reject">Reject</button>
                  <button type="button" onClick={() => setRejecting(null)}>Cancel</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
