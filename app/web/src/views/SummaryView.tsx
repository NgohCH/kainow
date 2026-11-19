import { type FormEvent, type KeyboardEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QuarantineNote, ReportSecret } from './ReportSecret.tsx';
import { ApiError, type Membership } from '../api.ts';
import { go } from '../App.tsx';
import {
  approvalLines,
  approveSummary,
  askSummaryApproval,
  confirmSummary,
  editSummary,
  FROM_RESTRICTED_LABEL,
  getSummary,
  getSummaryVersion,
  highlightPieces,
  leaveOutCounter,
  leaveOutProblem,
  markIntended,
  markKindText,
  markProgress,
  openMarks,
  marksResolved,
  MAX_BODY,
  MAX_LEAVE_OUT,
  newSummaryBody,
  type NewSummary,
  type SummaryAny,
  requestSummaryForSource,
  requestSummaryForThread,
  REVIEW_REQUIRED_LABEL,
  SUMMARY_APPROVED_LABEL,
  SUMMARY_DRAFT_LABEL,
  SUMMARY_POLL_MS,
  summaryPath,
  type SummaryFullView,
  withdrawSummary,
} from '../assist.ts';
import { type Person, readersOf } from '../discussion.ts';
import { formatWhen } from '../format.ts';
import { AudienceChoice, namablePeople } from './AudiencePanel.tsx';
import { ReasonForm } from './AssistReview.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
const names = (people: Person[]) => people.map((p) => p.displayName).join(', ') || 'no one';

/** "Draft shareable summary" on a Restricted source or meeting: the audience it is meant for, and what to leave out. */
export function SummaryRequest({
  target,
  memberships,
}: {
  target: { kind: 'source' | 'thread'; id: string };
  memberships: Membership[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'project' | 'restricted'>('project');
  const [named, setNamed] = useState<string[]>([]);
  const [leaveOut, setLeaveOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const problem = leaveOutProblem(leaveOut);
  const covers = readersOf(memberships, mode, named);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const body: NewSummary = newSummaryBody(mode, named, leaveOut);
      const view = await (target.kind === 'source' ? requestSummaryForSource : requestSummaryForThread)(target.id, body);
      go(summaryPath(view.id));
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <div className="summary-request">
      <button type="button" ref={opener} aria-expanded={open} onClick={() => setOpen((v) => !v)}>Draft shareable summary</button>
      {open && (
        <form className="panel stack" onSubmit={submit} aria-label="Draft shareable summary" onKeyDown={(e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)}>
          <p className="hint">
            An AI draft of this {target.kind === 'source' ? 'restricted source' : 'restricted meeting'} that people who cannot read the original could be given. It is not shared until a Project Manager, Owner or Sponsor approves it.
          </p>
          <AudienceChoice
            legend="Who is the summary for?"
            mode={mode}
            named={named}
            candidates={namablePeople(memberships, [])}
            onMode={(m) => { setMode(m); setNamed([]); }}
            onNamed={setNamed}
            canRestrict
          />
          <p className="meta" role="status">This would cover: {names(covers)}.</p>
          <label>
            Leave out (optional)
            <textarea rows={4} value={leaveOut} onChange={(e) => setLeaveOut(e.target.value)} aria-invalid={problem !== null} aria-describedby="leave-out-hint" />
          </label>
          <span id="leave-out-hint" className="hint">
            Phrases or topics the summary must not mention, one per line or separated by commas. {leaveOutCounter(leaveOut)} characters (up to {MAX_LEAVE_OUT.toLocaleString('en')}). Do not paste passwords or keys.
          </span>
          {problem && <p role="alert" className="error">{problem}</p>}
          {error && <p role="alert" className="error">{error}</p>}
          <span className="actions">
            <button className="primary" disabled={busy || problem !== null}>{busy ? 'Requesting' : 'Draft the summary'}</button>
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          </span>
        </form>
      )}
    </div>
  );
}

/** The summary's page: the draft with its marks, versions and Approve, or (for the wider audience) the approved text. */
export function SummaryPage({ summaryId }: { summaryId: string }) {
  const [view, setView] = useState<SummaryAny | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [info, setInfo] = useState('');
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState<number | null>(null);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [base, setBase] = useState(0);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reviewing, setReviewing] = useState<'confirm' | 'withdraw' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const marksHeading = useRef<HTMLHeadingElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const approveButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(new Set<number>());
  // A button that was disabled while its request ran gets focus back once it is enabled (or the marks heading if it is gone).
  const refocus = useRef<HTMLElement | null>(null);
  const focusLater = (r: { current: HTMLElement | null }) => requestAnimationFrame(() => r.current?.focus());

  const apply = useCallback((v: SummaryFullView) => {
    setView(v);
    if (v.current) setTexts((t) => ({ ...t, [v.current!.no]: v.current!.body }));
  }, []);

  const load = useCallback(async () => {
    try {
      const v = await getSummary(summaryId);
      if (v.view === 'full') apply(v);
      else setView(v);
      setLoadError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else setLoadError(errText(e));
    }
  }, [summaryId, apply]);
  useEffect(() => void load(), [load]);

  const arrived = view !== null;
  useEffect(() => {
    if (arrived) heading.current?.focus();
  }, [arrived]);

  const active = !gone && view?.view === 'full' && (view.status === 'queued' || view.status === 'running');
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void load().finally(() => setTick((n) => n + 1)), SUMMARY_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [active, tick, load]);

  const full = view?.view === 'full' ? view : null;
  const newest = full?.versions[full.versions.length - 1];
  const shownNo = shown ?? newest?.no ?? 0;
  const isNewest = shownNo === newest?.no;

  useEffect(() => {
    if (!full || shownNo === 0 || texts[shownNo] !== undefined || pending.current.has(shownNo)) return;
    pending.current.add(shownNo);
    getSummaryVersion(full.id, shownNo)
      .then((v) => setTexts((t) => ({ ...t, [shownNo]: v.body })))
      .catch((e) => setError(errText(e)))
      .finally(() => pending.current.delete(shownNo));
  }, [full, shownNo, texts]);

  useEffect(() => {
    if (busy || !refocus.current) return;
    const el = refocus.current;
    refocus.current = null;
    requestAnimationFrame(() => (el.isConnected && !(el as HTMLButtonElement).disabled ? el : marksHeading.current)?.focus());
  }, [busy]);

  const marks = full?.current?.marks ?? [];
  const body = texts[shownNo];
  const pieces = useMemo(() => (body !== undefined && isNewest ? highlightPieces(body, marks) : null), [body, isNewest, marks]);

  if (gone) return <main className="page narrow"><p className="empty">This summary was not found.</p></main>;
  if (!view) return <main className="page narrow">{loadError ? <p role="alert" className="error">{loadError}</p> : <p className="loading">Loading</p>}</main>;

  if (view.view === 'shared') {
    return (
      <main className="page narrow">
        <h1 tabIndex={-1} ref={heading}>Shareable summary</h1>
        <p className="meta">
          <span className="ai-label">{view.label}</span> · {view.approved} · {view.from}
        </p>
        <QuarantineNote text={view.quarantineLabel} />
        <p><a href={`#/notes/${view.sourceId}`}>Open as a note</a></p>
        <div className="ai-proposed answer-text draft-text source" role="region" aria-label="Approved summary text">{view.body}</div>
      </main>
    );
  }

  const v: SummaryFullView = view;
  const cur = v.current;
  const resolved = marksResolved(marks);
  const approvedNow = cur?.approved === true;
  const label = approvedNow ? SUMMARY_APPROVED_LABEL : SUMMARY_DRAFT_LABEL;
  const originalHref = v.original.kind === 'source' ? `#/notes/${v.original.id}` : `#/projects/${v.projectId}/threads/${v.original.id}`;

  /** Someone changed the summary since it was opened: show the current version and say so. */
  async function showNewer(): Promise<void> {
    try {
      const fresh = await getSummary(v.id);
      if (fresh.view === 'full') apply(fresh);
      else setView(fresh);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return setGone(true);
    }
    setShown(null);
    setInfo('A newer version is shown. Check it, then try again.');
  }

  async function act(fn: () => Promise<SummaryFullView>, done: string, button?: HTMLElement | null) {
    setBusy(true);
    setError(null);
    refocus.current = button ?? null;
    try {
      apply(await fn());
      setInfo(done);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await showNewer();
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      apply(await editSummary(v.id, text, base));
      setShown(null);
      setEditing(false);
      setStale(false);
      setInfo('Your edit was saved as a new version. Its marks were found again.');
      focusLater(marksHeading);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone changed it: show the current version; the person's text stays in the box to look over and save again.
        const fresh = await getSummary(v.id).catch(() => null);
        if (fresh?.view === 'full') {
          apply(fresh);
          setBase(fresh.current?.no ?? base);
        }
        setShown(null);
        setStale(true);
      }
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    if (!cur) return;
    setText(cur.body);
    setBase(cur.no);
    setStale(false);
    setError(null);
    setEditing(true);
  }


  return (
    <main className="page">
      <p>
        {v.canReview || v.approval ? <a href={`#/projects/${v.projectId}/review`}>Back to Review</a> : <a href={originalHref}>Back to {v.original.kind === 'meeting' ? 'the meeting' : 'the source'}</a>}
      </p>
      <h1 tabIndex={-1} ref={heading}>Shareable summary of {v.original.title}</h1>
      <p><ReportSecret projectId={v.projectId} kind="summary" id={summaryId} label="this summary" /></p>
      <p className="meta">
        <span className="badge badge-pending">{FROM_RESTRICTED_LABEL}</span>{' '}
        {v.reviewLabel && <span className="badge badge-pending">{v.reviewLabel}</span>}{' '}
        {v.original.kind === 'meeting' ? 'Meeting' : 'Source'}: <a href={originalHref}>{v.original.title}</a> · requested by {v.requestedBy.displayName} · {formatWhen(v.createdAt)}
      </p>
      <p className="meta">
        Meant for: <strong>{v.intendedAudience.mode === 'project' ? 'Project-wide' : 'Restricted, named people'}</strong>
        {v.intendedAudience.mode === 'restricted' ? ` (${names(v.intendedAudience.namedUsers)})` : ''}. Would cover: {names(v.intendedAudience.covers)}.
        {v.leaveOut.trim() !== '' && <> Leave out: <span className="message-text">{v.leaveOut}</span></>}
      </p>
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{info}</div>
      {active && <p className="meta" role="status">{v.status === 'queued' ? 'Waiting to start' : 'Being drafted'}</p>}
      <QuarantineNote text={v.quarantineLabel} />
      {v.notice && <p className="warn" role="alert">{v.notice}</p>}
      {v.reviewLabel && (
        <p className="warn" role="note">
          <strong>{v.reviewLabel}.</strong> {v.reviewReason ?? ''}
        </p>
      )}
      {v.approved && (
        <p className="meta">
          Version {v.approved.versionNo} was approved by {v.approved.by.displayName} on {formatWhen(v.approved.at)}.
          {v.approved.sourceId && <> <a href={`#/notes/${v.approved.sourceId}`}>Open the approved summary as a note</a></>}
        </p>
      )}
      {(error ?? loadError) && <p role="alert" className="error">{error ?? loadError}</p>}

      {v.versions.length > 0 && (
        <>
          <label>
            Version
            <select value={shownNo} onChange={(e) => setShown(Number(e.target.value))}>
              {[...v.versions].reverse().map((x) => (
                <option key={x.no} value={x.no}>
                  Version {x.no}: {x.approved ? SUMMARY_APPROVED_LABEL : x.origin === 'ai' ? SUMMARY_DRAFT_LABEL : `${x.editedByLabel ?? 'Edited by a person'}, ${SUMMARY_DRAFT_LABEL}`} · {formatWhen(x.createdAt)}
                </option>
              ))}
            </select>
          </label>
          <div className={approvedNow && isNewest ? 'answer-text draft-text' : 'ai-proposed answer-text draft-text'}>
            <p className="meta">
              <span className={approvedNow && isNewest ? 'ai-label approved' : 'ai-label'}>{isNewest ? label : v.versions.find((x) => x.no === shownNo)?.label}</span>
              {!isNewest && ` · version ${shownNo}, not the newest`}
            </p>
            {body === undefined ? (
              <p className="loading">Loading</p>
            ) : (
              <div className="summary-text source" role="region" aria-label={`Summary text, version ${shownNo}`}>
                {pieces
                  ? pieces.map((p, i) =>
                      p.marks.length === 0 ? (
                        <Fragment key={i}>{p.text}</Fragment>
                      ) : (
                        <mark key={i} className={`summary-mark${p.marks.every((m) => m.intended) ? ' intended' : ''}`}>
                          <span className="visually-hidden">Start of marked text: {p.marks.map((m) => `${markKindText(m.kind)}${m.intended ? ', intended' : ''}`).join('; ')}. </span>
                          {p.text}
                          <span className="visually-hidden"> End of marked text.</span>
                        </mark>
                      ),
                    )
                  : body}
              </div>
            )}
            {cur && cur.omittedCategories.length > 0 && isNewest && <p className="meta">Left out by the AI: {cur.omittedCategories.join(', ')}.</p>}
          </div>
        </>
      )}
      {v.versions.length === 0 && !active && !v.notice && <p className="empty">This summary has no version yet.</p>}

      {cur && (
        <section aria-labelledby="marks-heading" className="panel">
          <h2 id="marks-heading" tabIndex={-1} ref={marksHeading}>Marked phrases and names</h2>
          <p className="meta" role="status">{markProgress(marks)} In version {cur.no}.</p>
          <p className="hint">Each mark must be removed by editing the summary, or ticked Intended (you mean it to stay). Highlights in the text match this list.</p>
          {marks.length > 0 && (
            <ul className="marks">
              {marks.map((m) => (
                <li key={m.id}>
                  <strong>{markKindText(m.kind)}</strong>: <q>{m.phrase}</q>
                  {' — '}
                  {m.intended ? <span>Intended{m.intendedBy ? `, ticked by ${m.intendedBy.displayName}` : ''}</span> : <span>not yet resolved</span>}
                  {m.places.length > 1 ? ` · appears ${m.places.length} times` : ''}
                  {!m.intended && v.canMarkIntended && (
                    <>
                      {' '}
                      <button type="button" disabled={busy || !isNewest} onClick={(e) => void act(() => markIntended(v.id, m.id, cur.no), `${markKindText(m.kind)} ticked Intended`, e.currentTarget)}>
                        Intended<span className="visually-hidden">: keep {m.phrase} in the summary</span>
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!isNewest && marks.length > 0 && <p className="meta">Marks can only be ticked on the newest version.</p>}
        </section>
      )}

      {!editing && !approving && !reviewing && (
        <div className="actions">
          {v.canEdit && <button type="button" ref={editButton} disabled={!isNewest} onClick={startEdit}>Edit</button>}
          {v.canAskApproval && cur && (
            <button type="button" disabled={busy || !isNewest} onClick={(e) => void act(() => askSummaryApproval(v.id, cur.no), 'Approval was asked for: the Project Manager, Owner and Sponsors were told', e.currentTarget)}>
              {cur.approvalRequested ? 'Ask for approval again' : 'Ask for approval'}
            </button>
          )}
          {v.approval && (
            <button
              type="button"
              ref={approveButton}
              className="primary"
              disabled={busy || !isNewest || !v.canApprove || !resolved}
              aria-describedby="approve-why"
              onClick={() => setApproving(true)}
            >
              Approve for sharing
            </button>
          )}
          {v.canReview && (
            <>
              <button type="button" disabled={busy} onClick={() => setReviewing('confirm')}>Confirm</button>
              <button type="button" disabled={busy} onClick={() => setReviewing('withdraw')}>Withdraw</button>
            </>
          )}
        </div>
      )}
      {v.approval && !editing && (
        <p id="approve-why" className="meta">
          {!resolved
            ? `Approve is off until every mark is removed or ticked Intended (${openMarks(marks).length} to go).`
            : !isNewest
              ? 'Approve works on the newest version.'
              : v.canApprove
                ? 'Approving shows exactly who gains access before it is done.'
                : 'This version cannot be approved now.'}
        </p>
      )}

      {approving && v.approval && (
        <div className="panel stack" role="alertdialog" aria-labelledby="approve-title" aria-describedby="approve-lines" onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setApproving(false); focusLater(approveButton); } }}>
          <p id="approve-title"><strong>Approve this summary for sharing?</strong></p>
          <div id="approve-lines">
            {approvalLines(v.approval).map((l, i) => <p key={i}>{l}</p>)}
            <p className="hint">Approving does not take back anything people have already read. Once approved, the summary can be read and used as a source by the audience above, and it is never treated as evidence.</p>
          </div>
          <ReasonForm
            legend="Approve version"
            submitLabel="Approve"
            onCancel={() => { setApproving(false); focusLater(approveButton); }}
            onSubmit={async (reason) => {
              let r;
              try {
                r = await approveSummary(v.id, v.approval!.versionNo, reason);
              } catch (e) {
                if (!(e instanceof ApiError && e.status === 409)) throw e;
                setApproving(false);
                await showNewer();
                setError(errText(e));
                focusLater(heading);
                return;
              }
              apply(r);
              setApproving(false);
              setInfo(`Version ${v.approval!.versionNo} was approved for sharing. ${r.gainedAccess.length} ${r.gainedAccess.length === 1 ? 'person gained' : 'people gained'} access.`);
              focusLater(heading);
            }}
          />
        </div>
      )}

      {reviewing && (
        <div className="panel">
          <ReasonForm
            legend={reviewing === 'confirm' ? 'Confirm this summary' : 'Withdraw this summary'}
            submitLabel={reviewing === 'confirm' ? 'Confirm' : 'Withdraw'}
            onCancel={() => { setReviewing(null); focusLater(heading); }}
            onSubmit={async (reason) => {
              await (reviewing === 'confirm' ? confirmSummary : withdrawSummary)(v.id, reason);
              const done = reviewing === 'confirm' ? 'The summary was confirmed' : 'The summary was withdrawn';
              setReviewing(null);
              await load();
              setInfo(done);
              focusLater(heading);
            }}
          />
        </div>
      )}

      {editing && (
        <form className="panel stack" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="Edit this summary">
          {stale && (
            <p className="warn">
              The current version (version {cur?.no}) is now shown above. Your text is kept below, now based on that version: look it over, then save again.
            </p>
          )}
          <label>
            Summary text, based on version {base}
            <textarea rows={14} value={text} maxLength={MAX_BODY} onChange={(e) => setText(e.target.value)} autoFocus />
          </label>
          <span className="hint">{text.length.toLocaleString('en')} / {MAX_BODY.toLocaleString('en')} characters. Removing a marked phrase resolves its mark. Saving makes a new version marked as edited by you.</span>
          <div className="actions">
            <button className="primary" disabled={busy || text.trim() === ''}>Save as a new version</button>
            <button type="button" onClick={() => { setEditing(false); setStale(false); setError(null); focusLater(editButton); }}>Cancel</button>
          </div>
        </form>
      )}
    </main>
  );
}

