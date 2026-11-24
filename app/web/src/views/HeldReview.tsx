import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import { formatDay } from '../format.ts';
import {
  type AwaitingCase,
  type CaseView,
  CASE_STATE_TEXT,
  HELD_LABEL,
  type HeldCase,
  MARKER_EQUIVALENT,
  type PossibleCopy,
  awaitingText,
  copyLine,
  decideCopies,
  getCase,
  kindNoun,
  listAwaiting,
  listCopies,
  listHeld,
  markMore,
  markerSegments,
  releaseCase,
  reportProblems,
} from '../quarantine.ts';
import { ReasonDialog } from './DeleteRestore.tsx';
import { selectedPageText } from './ReportSecret.tsx';
import { Box } from '../ui/Box.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Meaning } from '../ui/meanings.ts';

const CASE_MEANING: Record<string, Meaning> = { held: 'attention', cleaned: 'review', released: 'ok', released_unchanged: 'off' };

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const quiet = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404);

/**
 * Cleaned text with each `[credential removed]` drawn apart: boxed, bold and underlined, and carrying the words
 * themselves, so it is not told by colour alone (WCAG 1.4.1). The original is never on this screen.
 */
export function MarkedText({ text }: { text: string }) {
  return (
    <>
      {markerSegments(text).map((s, i) =>
        s.removed ? (
          <mark key={i} className="credential-removed" title={MARKER_EQUIVALENT}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** The project's open cases a Project Manager, Owner or Sponsor may review. Shows nothing when there are none or the viewer may not see them. */
export function HeldForReviewList({ projectId }: { projectId: string }) {
  const [cases, setCases] = useState<HeldCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listHeld(projectId).then(setCases, (e) => setError(quiet(e) ? null : errText(e)));
  }, [projectId]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!cases || cases.length === 0) return null;
  return (
    <Box meaning="review">
      <h2 id="held-heading" className="box-title">Held for review</h2>
      <p className="meta">Suspected credentials reported in this project. You see the cleaned text only, never the original.</p>
      <ul className="list">
        {cases.map((c) => (
          <li key={c.caseId}>
            <a href={`#/quarantine/cases/${c.caseId}`}>
              <strong>{`A ${kindNoun(c.kind)}${c.reference ? ` — ${c.reference}` : ''}`}</strong>
              <span className="meta">
                Reported by {c.reporter}, {formatDay(c.reportedAt)} · {CASE_STATE_TEXT[c.state] ?? c.state}
              </span>
              <span className="warn">{c.label ?? (c.state === 'held' ? HELD_LABEL : 'Credential removed — under review')}</span>
            </a>
          </li>
        ))}
      </ul>
    </Box>
  );
}

/** Open cases with places awaiting a decision, for the Project Manager and Deputies; each links to the case's Possible copies. */
export function CopiesAwaitingList({ projectId }: { projectId: string }) {
  const [cases, setCases] = useState<AwaitingCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listAwaiting(projectId).then(setCases, (e) => setError(quiet(e) ? null : errText(e)));
  }, [projectId]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!cases || cases.length === 0) return null;
  return (
    <Box meaning="review">
      <h2 id="awaiting-heading" className="box-title">Possible copies awaiting check</h2>
      <p className="meta">The text reported as a suspected credential also appeared in these places. They were masked at once; confirm or dismiss each.</p>
      <ul className="list">
        {cases.map((c) => (
          <li key={c.caseId}>
            <a href={`#/quarantine/cases/${c.caseId}/copies`}>
              <strong>{`Reported in a ${kindNoun(c.kind)}, ${formatDay(c.reportedAt)}`}</strong>
              <span className="meta">{awaitingText(c.awaiting)}</span>
            </a>
          </li>
        ))}
      </ul>
    </Box>
  );
}

/** Mark more: further text of the cleaned item is selected (or pasted) and removed in the same case. */
function MarkMore({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [marked, setMarked] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (open) box.current?.focus();
    else if (was.current) button.current?.focus();
    was.current = open;
  }, [open]);

  const close = () => {
    setOpen(false);
    setMarked('');
    setProblem(null);
    setError(null);
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const p = reportProblems({ marked: [marked], reason: 'x' }).marked;
    setProblem(p);
    setError(null);
    if (p) return box.current?.focus();
    setBusy(true);
    try {
      const r = await markMore(caseId, [marked]);
      close();
      setResult(`Removed. ${r.rows} stored ${r.rows === 1 ? 'value was' : 'values were'} cleaned${r.places > 0 ? `, and ${r.places} other ${r.places === 1 ? 'place was' : 'places were'} masked for the Project Manager to check` : ''}.`);
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        ref={button}
        aria-expanded={open}
        onClick={() => {
          if (open) return close();
          setMarked(selectedPageText());
          setResult(null);
          setOpen(true);
        }}
      >
        Mark more
      </button>
      {result && <p role="status" className="meta">{result}</p>}
      {open && (
        <form
          className="panel stack delete-dialog"
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${uid}-title`}
          noValidate
          onSubmit={submit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <h3 id={`${uid}-title`}>Mark more text to remove</h3>
          <p className="meta">Select further text in the cleaned text before opening this form, or paste it (at least 4 characters, exactly as it appears).</p>
          <label htmlFor={`${uid}-marked`}>Text to remove</label>
          <textarea id={`${uid}-marked`} ref={box} rows={2} value={marked} autoComplete="off" spellCheck={false} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${uid}-p` : undefined} onChange={(e) => setMarked(e.target.value)} />
          {problem && <p id={`${uid}-p`} role="alert" className="error">{problem}</p>}
          {error && <p role="alert" className="error">{error}</p>}
          <div className="decision">
            <button className="primary" disabled={busy} aria-disabled={busy}>Remove it</button>
            <button type="button" onClick={close}>Cancel</button>
          </div>
        </form>
      )}
    </>
  );
}

/** Possible copies (spec 7.4): places that also held the reported text, masked at once; the Project Manager or a Deputy confirms or dismisses each. */
export function PossibleCopies({ caseId, onChanged }: { caseId: string; onChanged?: () => void }) {
  const [copies, setCopies] = useState<PossibleCopy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const load = useCallback(() => {
    listCopies(caseId).then(
      (c) => {
        setCopies(c);
        setTicked(new Set());
      },
      (e) => (quiet(e) ? setHidden(true) : setError(errText(e))),
    );
  }, [caseId]);
  useEffect(load, [load]);
  if (hidden || (copies && copies.length === 0 && !error)) return null;
  const key = (c: PossibleCopy) => `${c.kind}:${c.id}`;
  const open = (copies ?? []).filter((c) => c.decision === null);

  async function decide(decision: 'confirmed' | 'dismissed') {
    const places = open.filter((c) => ticked.has(key(c)));
    if (places.length === 0) return setError('Tick at least one place first.');
    setBusy(true);
    setError(null);
    try {
      await decideCopies(caseId, places, decision);
      setResult(decision === 'confirmed' ? `${places.length} confirmed as copies. They stay cleaned and are released with the case.` : `${places.length} dismissed. Their original text is back in place.`);
      load();
      onChanged?.();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box meaning="review">
      <h2 id="copies-heading" className="box-title">Possible copies</h2>
      <p className="meta">These places held the same text and were masked at once. The text is never shown here. Confirm a place if it held the secret; dismiss it if it did not, and its original text goes back.</p>
      {copies && (
        <fieldset className="stack">
          <legend className="visually-hidden">Places to decide on</legend>
          <ul className="plain">
            {copies.map((c) => {
              const line = copyLine(c);
              return (
                <li key={key(c)}>
                  {line.decided ? (
                    <span>{line.text} <span className="meta">— {line.decisionText}</span></span>
                  ) : (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={ticked.has(key(c))}
                        onChange={() =>
                          setTicked((t) => {
                            const n = new Set(t);
                            if (!n.delete(key(c))) n.add(key(c));
                            return n;
                          })
                        }
                      />{' '}
                      {line.text}
                    </label>
                  )}
                  {line.label && <span className="warn">{line.label}</span>}
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      {open.length > 0 && (
        <div className="decision">
          <button className="primary" disabled={busy} aria-disabled={busy} onClick={() => void decide('confirmed')}>Confirm selected</button>
          <button disabled={busy} aria-disabled={busy} onClick={() => void decide('dismissed')}>Dismiss — not the secret</button>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {result && <p role="status" className="meta">{result}</p>}
    </Box>
  );
}

/** One case: the cleaned text with each removal marked, Mark more, Release, and the Possible copies. Opened from the Held for review list or a notice. */
export function CasePage({ caseId }: { caseId: string }) {
  const [view, setView] = useState<CaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const releaseButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(() => {
    getCase(caseId).then(
      (v) => {
        setView(v);
        setError(null);
      },
      (e) => setError(quiet(e) ? 'You cannot review this case here. Project Managers, Owners and Sponsors in the item\'s audience can; Project Managers and Deputies can decide its possible copies.' : errText(e)),
    );
  }, [caseId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (view) heading.current?.focus();
    // once per case, not per reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view === null]);

  const open = view && (view.state === 'held' || view.state === 'cleaned');
  return (
    <main className="page">
      <header className="page-header">
        <nav aria-label="Breadcrumb" className="crumbs">
          <ol><li><a href="#/">Back to My Projects</a></li></ol>
        </nav>
        <h1 tabIndex={-1} ref={heading}>{view ? `A ${kindNoun(view.kind)} held for review` : 'Held for review'}</h1>
      </header>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {view && (
        <>
          <Box meaning={CASE_MEANING[view.state] ?? 'draft'}>
            <p>
              <StatusLabel meaning={CASE_MEANING[view.state] ?? 'draft'} word={CASE_STATE_TEXT[view.state] ?? view.state} />
            </p>
            <p className="meta">
              Reported by {view.reporter}, {formatDay(view.reportedAt)}
              {view.reference ? ` · ${view.reference}` : ''}
            </p>
            {view.reason && <p className="meta">Reason given: {view.reason}</p>}
            {view.label && <p className="warn" role="note">{view.label}</p>}
          </Box>
          {view.text !== null ? (
            <Box>
              <h2 id="cleaned-heading" className="box-title">Cleaned text</h2>
              <p className="meta">Each removed credential shows as [credential removed], boxed and underlined. The original is not shown here.</p>
              <div className="cleaned-text panel" tabIndex={0} role="region" aria-labelledby="cleaned-heading">
                <MarkedText text={view.text} />
              </div>
            </Box>
          ) : (
            !view.label && <p className="meta">There is no cleaned text to show for this case.</p>
          )}
          {open && (
            <Box title="What you can do">
              <div className="decision">
                {view.text !== null && <MarkMore caseId={view.caseId} onDone={load} />}
                <button type="button" ref={releaseButton} className="primary" aria-expanded={releasing} onClick={() => setReleasing((r) => !r)}>Release</button>
              </div>
            </Box>
          )}
          {releasing && open && (
            <ReasonDialog
              title="Release this item"
              confirm="Release"
              onClose={() => {
                setReleasing(false);
                requestAnimationFrame(() => releaseButton.current?.focus());
              }}
              onConfirm={async (reason) => {
                const r = await releaseCase(view.caseId, reason);
                setReleasing(false);
                setNotice(`Released, with ${r.copies} confirmed ${r.copies === 1 ? 'copy' : 'copies'}. The cleaned item is back with its audience. Withdrawn AI outputs do not come back, and a hidden summary stays hidden until it is confirmed.`);
                load();
              }}
            >
              <p className="meta">The cleaned item and its confirmed copies go back to the people who could read them. The reporter and the Project Manager are told.</p>
            </ReasonDialog>
          )}
        </>
      )}
      <PossibleCopies caseId={caseId} onChanged={load} />
    </main>
  );
}
