import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import {
  confirmSummary,
  decideReview,
  listAssistReview,
  listSummariesToReview,
  MAX_REASON,
  reasonProblem,
  type ReviewItem,
  REVIEW_REQUIRED_LABEL,
  reviewActions,
  safeHref,
  summaryPath,
  type SummaryListItem,
  withdrawSummary,
} from '../assist.ts';
import { formatWhen } from '../format.ts';
import { QuarantineNote } from './ReportSecret.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** One action that needs a written reason: the box, the buttons, Escape to cancel. The reason is sent only when it is 1 to 500 characters. */
export function ReasonForm({
  legend,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  legend: string;
  submitLabel: string;
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = reasonProblem(reason);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <form className="inline-form stack" onSubmit={submit} onKeyDown={esc} aria-label={legend}>
      <label>
        {legend} (reason required)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={MAX_REASON} required autoFocus aria-invalid={error !== null} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <span className="actions">
        <button className="primary" disabled={busy || reason.trim() === ''}>{submitLabel}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}

type Pending = { key: string; action: 'clear' | 'confirm' | 'withdraw' } | null;
const ACTION_WORD = { clear: 'Clear', confirm: 'Confirm', withdraw: 'Withdraw' } as const;
const ACTION_HELP = {
  clear: 'Clear: it shows again, and each person still sees only what they may read.',
  confirm: 'Confirm: the summary stays approved for sharing.',
  withdraw: 'Withdraw: it is hidden for good; the record is kept.',
} as const;

/**
 * The Review tab: answers and drafts shared before some material was removed (Project Manager and Deputy), and the
 * summaries that are waiting for an approval or an access review (Project Manager, Owner and Sponsor).
 */
export function AssistReview({ projectId, roles }: { projectId: string; roles: string[] }) {
  const answerActions = reviewActions('answer', roles);
  const summaryActions = reviewActions('summary', roles);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [summaries, setSummaries] = useState<SummaryListItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [summariesError, setSummariesError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [info, setInfo] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const summariesHeading = useRef<HTMLHeadingElement>(null);
  const openButtons = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(async () => {
    // A list that cannot be reloaded is emptied and the error shown, so a stale row is never left to act on.
    if (answerActions.length > 0) {
      await listAssistReview(projectId).then(
        (r) => { setItems(r); setItemsError(null); },
        (e) => { setItems([]); setItemsError(`Could not load the answers and drafts to review. ${errText(e)}`); },
      );
    }
    if (summaryActions.length > 0) {
      await listSummariesToReview(projectId).then(
        (r) => { setSummaries(r); setSummariesError(null); },
        (e) => { setSummaries([]); setSummariesError(`Could not load the summaries to review. ${errText(e)}`); },
      );
    }
    // The roles never change while the tab is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, answerActions.length, summaryActions.length]);
  useEffect(() => void load(), [load]);

  /** After a decision the row is gone from the list: say so, and put focus on the list's heading. */
  async function decided(done: string, to: 'answers' | 'summaries') {
    setPending(null);
    await load();
    setInfo(done);
    requestAnimationFrame(() => (to === 'answers' ? heading : summariesHeading).current?.focus());
  }

  const cancel = (key: string) => {
    setPending(null);
    requestAnimationFrame(() => openButtons.current.get(key)?.focus());
  };
  const reg = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) openButtons.current.set(key, el);
    else openButtons.current.delete(key);
  };

  if (answerActions.length === 0 && summaryActions.length === 0)
    return (
      <p className="empty box">
        Nothing here is for your role to review. A summary you drafted is opened from the <a href={`#/projects/${projectId}/notes`}>note</a> or <a href={`#/projects/${projectId}/discussion`}>meeting</a> it came from.
      </p>
    );

  return (
    <section aria-labelledby="review-heading">
      <h2 id="review-heading">Review</h2>
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{info}</div>
      <div className="stat-grid">
        {answerActions.length > 0 && (
          <StatTile label="Answers and drafts to review" value={items === null ? '…' : String(items.length)} meaning={items && items.length > 0 ? 'review' : undefined} />
        )}
        {summaryActions.length > 0 && (
          <StatTile label="Summaries to review" value={summaries === null ? '…' : String(summaries.length)} meaning={summaries && summaries.length > 0 ? 'review' : undefined} />
        )}
      </div>

      {answerActions.length > 0 && (
        <section aria-labelledby="review-answers-heading" className="box">
          <h3 id="review-answers-heading" className="box-title" tabIndex={-1} ref={heading}>Answers and drafts to review</h3>
          <p className="meta">Shared AI answers and drafts that used something since removed. Until you decide, only the Project Manager and Deputies see them.</p>
          {itemsError && <p role="alert" className="error">{itemsError}</p>}
          {items === null && !itemsError && <p className="loading">Loading</p>}
          {items?.length === 0 && !itemsError && <p className="empty">Nothing is waiting for review.</p>}
          <ul className="ask-list">
            {items?.map((i) => {
              const key = `${i.kind}:${i.id}`;
              const href = safeHref(i.href);
              return (
                <li key={key} className="ask-card ai-proposed">
                  <p>
                    <span className="ai-label">{i.kind === 'answer' ? 'AI answer' : 'AI draft'}</span>{' '}
                    {href ? <a href={href}><strong>{i.title}</strong></a> : <strong>{i.title}</strong>}{' '}
                    <StatusLabel meaning="review" />
                  </p>
                  <p className="meta">By {i.by.displayName}{i.flaggedAt ? ` · flagged ${formatWhen(i.flaggedAt)}` : ''}</p>
                  <p><strong>Why it needs review:</strong> {i.reason}</p>
                  {pending?.key === key ? (
                    <ReasonForm
                      legend={`${ACTION_WORD[pending.action]} this ${i.kind}`}
                      submitLabel={ACTION_WORD[pending.action]}
                      onCancel={() => cancel(key)}
                      onSubmit={async (reason) => {
                        await decideReview(i.kind, i.id, pending.action === 'withdraw' ? 'withdraw' : 'clear', reason);
                        await decided(pending.action === 'withdraw' ? `The ${i.kind} was withdrawn` : `The ${i.kind} was cleared`, 'answers');
                      }}
                    />
                  ) : (
                    <div className="actions">
                      {answerActions.map((a) => (
                        <button key={a} type="button" ref={a === 'clear' ? reg(key) : undefined} aria-describedby={`help-${a}`} onClick={() => setPending({ key, action: a as 'clear' | 'withdraw' })}>
                          {ACTION_WORD[a]}<span className="visually-hidden"> {i.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="hint"><span id="help-clear">{ACTION_HELP.clear}</span> <span id="help-withdraw">{ACTION_HELP.withdraw}</span></p>
        </section>
      )}

      {summaryActions.length > 0 && (
        <section aria-labelledby="review-summaries-heading" className="box">
          <h3 id="review-summaries-heading" className="box-title" tabIndex={-1} ref={summariesHeading}>Summaries to review</h3>
          <p className="meta">Shareable summaries of restricted sources and meetings: drafts waiting for approval, and approved ones whose access needs a check.</p>
          {summariesError && <p role="alert" className="error">{summariesError}</p>}
          {summaries === null && !summariesError && <p className="loading">Loading</p>}
          {summaries?.length === 0 && !summariesError && <p className="empty">No summaries are waiting.</p>}
          <ul className="ask-list">
            {summaries?.map((s) => {
              const key = `summary:${s.id}`;
              const inReview = s.state === 'review_required' || s.state === 'hidden';
              return (
                <li key={key} className="ask-card ai-proposed">
                  <p>
                    <span className="ai-label">{inReview ? REVIEW_REQUIRED_LABEL : s.label}</span>{' '}
                    <a href={summaryPath(s.id)}><strong>{s.original.title}</strong></a>{' '}
                    {inReview ? <StatusLabel meaning="review" word="Access review" /> : (s.approvalRequested ? <StatusLabel meaning="review" word="Approval asked for" /> : <StatusLabel meaning="draft" />)}
                  </p>
                  <QuarantineNote text={s.quarantineLabel} />
                  <p className="meta">
                    {s.original.kind === 'meeting' ? 'Meeting' : 'Source'} · requested by {s.requestedBy.displayName} · {formatWhen(s.createdAt)}
                    {s.latestVersionNo !== null ? ` · version ${s.latestVersionNo}` : ' · not drafted yet'}
                    {!inReview && s.latestVersionNo !== null ? ` · ${s.openMarks === 0 ? 'every mark resolved' : `${s.openMarks} ${s.openMarks === 1 ? 'mark' : 'marks'} to resolve`}` : ''}
                    {!inReview && s.approvalRequested ? ' · approval asked for' : ''}
                  </p>
                  {inReview && s.reason && <p><strong>Why it needs review:</strong> {s.reason}</p>}
                  {inReview &&
                    (pending?.key === key ? (
                      <ReasonForm
                        legend={`${ACTION_WORD[pending.action]} this summary`}
                        submitLabel={ACTION_WORD[pending.action]}
                        onCancel={() => cancel(key)}
                        onSubmit={async (reason) => {
                          await (pending.action === 'withdraw' ? withdrawSummary : confirmSummary)(s.id, reason);
                          await decided(pending.action === 'withdraw' ? 'The summary was withdrawn' : 'The summary was confirmed', 'summaries');
                        }}
                      />
                    ) : (
                      <div className="actions">
                        {summaryActions.map((a) => (
                          <button key={a} type="button" ref={a === 'confirm' ? reg(key) : undefined} onClick={() => setPending({ key, action: a as 'confirm' | 'withdraw' })}>
                            {ACTION_WORD[a]}<span className="visually-hidden"> {s.original.title}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                </li>
              );
            })}
          </ul>
          <p className="hint"><span>{ACTION_HELP.confirm}</span> <span>{ACTION_HELP.withdraw}</span></p>
        </section>
      )}
    </section>
  );
}
