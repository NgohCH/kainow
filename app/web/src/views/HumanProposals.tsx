import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QuarantineNote, ReportSecret } from './ReportSecret.tsx';
import { ApiError, api, type DueReading } from '../api.ts';
import { formatWhen } from '../format.ts';
import { recordHref } from '../proposalLinks.ts';
import { AuthoriseForm, DescriptionField, type Person } from './AuthoriseForm.tsx';
import { type ProposedSubtask, manyCandidates } from '../authoriseMany.ts';
import type { CopiedFrom } from '../duplicate.ts';
import { AuthoriseSeveral } from './AuthoriseSeveral.tsx';
import { CopiedFromLabel } from './CopiedFromLabel.tsx';
import { useFocusItem } from './useFocusItem.ts';
import { ChangeRequestPanel, pendingAuthorisation, useRequests } from './ChangeRequest.tsx';
import { waitingLine, type RequestView } from '../changes.ts';

type Kind = 'action' | 'decision' | 'question' | 'risk';
interface Proposal {
  /** "Possible credential removed — awaiting check" while this is a possible copy masked at once (history spec 7.4). */
  quarantineLabel?: string | null;
  id: string;
  kind: Kind;
  text: string;
  description: string | null;
  owner: string | null;
  due: string | null;
  proposedBy: string;
  proposedAt: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  rejectReason: string | null;
  label: string;
  record: { kind: string; id: string } | null;
  /** The record is in view today: it can be linked to. */
  recordOpens?: boolean;
  dueReading: DueReading;
  /** Carried over by duplicating a project (D140): where from, and the subtasks to create with it. */
  copiedFrom?: CopiedFrom;
  proposedSubtasks?: ProposedSubtask[] | null;
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
  const [several, setSeveral] = useState(false);
  const severalButton = useRef<HTMLButtonElement>(null);
  const [form, setForm] = useState({ kind: 'action' as Kind, text: '', description: '', owner: '', due: '' });
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

  const candidates = useMemo(() => manyCandidates(proposals, new Set(requests.filter((r) => r.kind === 'authorise_proposal' && r.status === 'pending').map((r) => r.target.id))), [proposals, requests]);

  /** Typed terms are not thrown away unasked; what is unsaved elsewhere on the page stays guarded. */
  const mayCloseSeveral = useRef(() => true);
  function closeSeveral() {
    if (!mayCloseSeveral.current()) return;
    setSeveral(false);
    severalButton.current?.focus();
  }

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
    if (await run(() => api.post(`/projects/${projectId}/proposals`, { ...form, description: form.kind === 'action' ? form.description : undefined }), 'Proposed. The Owner or a Sponsor reviews it.')) {
      setOpen(false);
      setForm({ kind: 'action', text: '', description: '', owner: '', due: '' });
    }
  }

  return (
    <section aria-labelledby="human-proposals-heading">
      <div className="row">
        <h2 id="human-proposals-heading">Proposals from people</h2>
        {canReview && (candidates.length > 1 || several) && (
          <button ref={severalButton} className="quiet" onClick={() => (several ? closeSeveral() : setSeveral(true))} aria-expanded={several}>
            {several ? 'Close authorise several' : 'Authorise several'}
          </button>
        )}
        {canPropose && (
          <button className="quiet" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Close' : 'Propose something'}
          </button>
        )}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {several && canReview && (
        <AuthoriseSeveral
          projectId={projectId}
          proposals={candidates}
          people={people}
          onDone={load}
          onClose={closeSeveral}
          mayClose={mayCloseSeveral}
        />
      )}
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
          {form.kind === 'action' && <DescriptionField value={form.description} onChange={(description) => setForm({ ...form, description })} />}
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
              {p.description && <p className="task-description">{p.description}</p>}
              {p.proposedSubtasks && p.proposedSubtasks.length > 0 && (
                <details>
                  <summary>{p.proposedSubtasks.length} {p.proposedSubtasks.length === 1 ? 'subtask' : 'subtasks'}</summary>
                  <ul>
                    {p.proposedSubtasks.map((s, i) => (
                      <li key={i}>{s.title}{s.due ? ` (by ${s.due})` : ''}{s.description && <p className="task-description">{s.description}</p>}</li>
                    ))}
                  </ul>
                </details>
              )}
              <QuarantineNote text={p.quarantineLabel} />
              <span className="meta">
                {p.label}, by {p.proposedBy}, {formatWhen(p.proposedAt)}
                {p.copiedFrom && <> · <CopiedFromLabel from={p.copiedFrom} /></>}
                {p.owner ? ` · who: ${p.owner}` : ''}
                {p.due ? ` · by when: ${p.due}` : ''}
                {p.reviewStatus === 'rejected' ? ` · rejected: ${p.rejectReason}` : ''}
                {p.record && !p.recordOpens ? ' · authorised (see the Work tab)' : ''}
                {p.record && p.recordOpens && (
                  <> · <a href={recordHref(projectId, p.record)}>authorised: open the {p.record.kind}<span className="visually-hidden"> “{p.text}”</span></a></>
                )}
              </span>
              {' '}
              <ReportSecret projectId={projectId} kind="human_proposal" id={p.id} label="this proposal" onReported={() => void load()} />
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
                  description={p.description}
                  copiedSubtasks={p.proposedSubtasks ?? undefined}
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
