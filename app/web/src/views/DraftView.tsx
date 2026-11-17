import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import {
  diffWord,
  DRAFT_POLL_MS,
  draftDownloadUrl,
  type DraftVersion,
  type DraftView,
  editDraft,
  getDraft,
  getDraftVersion,
  isDraftActive,
  lineDiff,
  MAX_BODY,
  parseMarkdown,
  regenerateDraft,
  REGENERATE_WARNING,
  shareDraft,
  staleCurrent,
  unshareDraft,
  versionLabel,
} from '../assist.ts';
import { formatDay } from '../due.ts';
import { formatWhen } from '../format.ts';
import { FeedbackButton } from './Feedback.tsx';
import { Markdown } from './Markdown.tsx';
import { QuarantineNote, ReportSecret } from './ReportSecret.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** One draft: its text, versions, edit, compare, regenerate, share and download. */
export function DraftDetail({ projectId, draftId }: { projectId: string; draftId: string }) {
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null); // from something the person did
  const [loadError, setLoadError] = useState<string | null>(null); // from loading or polling; cleared by the next good load
  const [info, setInfo] = useState('');
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState<number | null>(null); // the version on screen; null follows the newest
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [base, setBase] = useState(0);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [compareA, setCompareA] = useState(0);
  const [compareB, setCompareB] = useState(0);
  const [comparing, setComparing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const prevCount = useRef(0);
  const pending = useRef(new Set<number>());
  const editButton = useRef<HTMLButtonElement>(null);
  const regenButton = useRef<HTMLButtonElement>(null);
  const focusAfterBusy = useRef(false);
  const focusLater = (r: { current: HTMLElement | null }) => requestAnimationFrame(() => r.current?.focus());

  const apply = useCallback((d: DraftView) => {
    setDraft(d);
    if (d.current) setTexts((t) => ({ ...t, [d.current!.no]: d.current!.body }));
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await getDraft(draftId));
      setLoadError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else setLoadError(errText(e));
    }
  }, [draftId, apply]);
  useEffect(() => void load(), [load]);
  // The heading takes focus once, when the draft first arrives.
  const arrived = draft !== null;
  useEffect(() => {
    if (arrived) heading.current?.focus();
  }, [arrived]);

  const active = draft !== null && isDraftActive(draft);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void load().finally(() => setTick((n) => n + 1)), DRAFT_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [active, tick, load]);

  // A new version arriving (a regenerate finishing) is announced.
  useEffect(() => {
    if (!draft) return;
    if (prevCount.current > 0 && draft.versions.length > prevCount.current) setInfo('A new version of this draft is ready');
    prevCount.current = draft.versions.length;
  }, [draft]);

  // After a new version is requested the button is disabled while the request runs; focus returns once it is done (to the heading if the button is gone).
  useEffect(() => {
    if (busy || !focusAfterBusy.current) return;
    focusAfterBusy.current = false;
    requestAnimationFrame(() => (regenButton.current ?? heading.current)?.focus());
  }, [busy]);

  const newest = draft?.versions[draft.versions.length - 1];
  const shownNo = shown ?? newest?.no ?? 0;
  const shownVersion = draft?.versions.find((v) => v.no === shownNo);

  const ensureText = useCallback(
    async (no: number) => {
      if (texts[no] !== undefined || pending.current.has(no)) return;
      pending.current.add(no);
      try {
        const v = await getDraftVersion(draftId, no);
        setTexts((t) => ({ ...t, [no]: v.body }));
      } catch (e) {
        setError(errText(e));
      } finally {
        pending.current.delete(no);
      }
    },
    [draftId, texts],
  );
  useEffect(() => {
    if (shownNo > 0) void ensureText(shownNo);
  }, [shownNo, ensureText]);
  useEffect(() => {
    if (comparing && compareA > 0 && compareB > 0) {
      void ensureText(compareA);
      void ensureText(compareB);
    }
  }, [comparing, compareA, compareB, ensureText]);

  const body = texts[shownNo];
  const known = useMemo(() => {
    const set = new Set<string>();
    if (body) for (const b of parseMarkdown(body)) if (b.t === 'defs') for (const d of b.items) set.add(d.marker);
    return set;
  }, [body]);

  if (gone) return <p className="empty">This draft was not found.</p>;
  if (!draft) return error || loadError ? <p role="alert" className="error">{error ?? loadError}</p> : <p className="loading">Loading</p>;

  const isNewest = shownNo === newest?.no;
  const idPrefix = `draft-${draft.id}-${shownNo}`;

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'versions' in r) apply(r as DraftView);
      else await load();
      setInfo(done);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      apply(await editDraft(draft!.id, text, base));
      setShown(null);
      setEditing(false);
      focusLater(editButton);
      setStale(false);
      setInfo('Your edit was saved as a new version');
    } catch (e) {
      const cur = staleCurrent(e);
      if (cur) {
        // The current version is offered: it is shown, and the person's text stays in the box to look over and save again.
        apply(cur);
        setShown(null);
        setBase(cur.current?.no ?? base);
        setStale(true);
      }
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function closeConfirm(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setConfirming(false);
    focusLater(regenButton);
  }

  function startEdit() {
    if (!draft?.current) return;
    setText(draft.current.body);
    setBase(draft.current.no);
    setStale(false);
    setError(null);
    setEditing(true);
  }

  function toggleCompare() {
    const vs = draft!.versions;
    setCompareA(vs[vs.length - 2].no);
    setCompareB(vs[vs.length - 1].no);
    setComparing((v) => !v);
  }

  const verText = (v: DraftVersion) => `Version ${v.no}: ${versionLabel(v)}`;
  const diff = compareA > 0 && compareB > 0 && texts[compareA] !== undefined && texts[compareB] !== undefined ? lineDiff(texts[compareA], texts[compareB]) : null;

  return (
    <section aria-labelledby="draft-heading">
      <p><a href={`#/projects/${projectId}/drafts`}>All drafts</a></p>
      <h2 id="draft-heading" tabIndex={-1} ref={heading}>{draft.title}</h2>
      <p><ReportSecret projectId={projectId} kind="report_draft" id={draftId} label="this draft" onReported={() => setTick((n) => n + 1)} /></p>
      <p className="meta">
        {draft.kindLabel} · requested by {draft.requestedBy.displayName} · {formatWhen(draft.createdAt)}
        {draft.period ? ` · period ${formatDay(draft.period.from)} to ${formatDay(draft.period.to)}` : ''}
        {draft.shared ? (draft.inReview ? ' · shared, waiting for review' : ' · shared') : ' · not shared'}
      </p>
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{info}</div>
      {active && <p className="meta" role="status">{draft.status === 'queued' ? 'Waiting to start' : 'Being drafted'}</p>}
      <QuarantineNote text={draft.quarantineLabel} />
      {draft.notice && <p className="warn" role="alert">{draft.notice}</p>}
      {(error ?? loadError) && <p role="alert" className="error">{error ?? loadError}</p>}

      {draft.versions.length > 0 && (
        <>
          <label>
            Version
            <select value={shownNo} onChange={(e) => setShown(Number(e.target.value))}>
              {[...draft.versions].reverse().map((v) => (
                <option key={v.no} value={v.no}>{verText(v)} · {formatWhen(v.createdAt)}</option>
              ))}
            </select>
          </label>
          {shownVersion && (
            <div className="ai-proposed answer-text draft-text">
              <p className="meta">
                {shownVersion.origin === 'ai' ? <span className="ai-label">{versionLabel(shownVersion)}</span> : <span>{versionLabel(shownVersion)} (from an AI draft, not approved)</span>}
                {!isNewest && ` · version ${shownVersion.no}, not the newest`}
              </p>
              {body === undefined ? (
                <p className="loading">Loading</p>
              ) : (
                <Markdown markdown={body} idPrefix={idPrefix} known={(m) => known.has(m)} onMarker={(m) => document.getElementById(`${idPrefix}-fn-${m}`)?.focus()} />
              )}
            </div>
          )}
        </>
      )}
      {draft.versions.length === 0 && !active && !draft.notice && <p className="empty">This draft has no version yet.</p>}

      {!editing && (
        <div className="actions">
          {draft.canEdit && (
            <button type="button" ref={editButton} disabled={!isNewest} aria-describedby={isNewest ? undefined : "edit-old"} onClick={startEdit}>Edit</button>
          )}
          {draft.canRegenerate && <button type="button" ref={regenButton} disabled={busy} onClick={() => setConfirming(true)}>Regenerate</button>}
          {draft.canShare && <button type="button" disabled={busy} onClick={() => void act(() => shareDraft(draft.id), 'This draft is shared')}>Share</button>}
          {draft.canUnshare && <button type="button" disabled={busy} onClick={() => void act(() => unshareDraft(draft.id), 'This draft is no longer shared')}>Unshare</button>}
          {shownVersion && <a href={draftDownloadUrl(draft.id, shownNo)} download>Download Markdown (version {shownNo})</a>}
          {draft.versions.length > 1 && <button type="button" aria-expanded={comparing} onClick={toggleCompare}>Compare versions</button>}
          {shownVersion && <FeedbackButton projectId={projectId} targetKind="report_version" targetId={shownVersion.id} label="Give feedback on this draft" />}
        </div>
      )}

      {draft.canEdit && !isNewest && !editing && <p id="edit-old" className="meta">Editing starts from the newest version. Choose it in the version list to edit.</p>}

      {confirming && (
        <div className="panel" role="alertdialog" onKeyDown={closeConfirm} aria-labelledby="regen-title" aria-describedby="regen-warning">
          <p id="regen-title"><strong>Make a new AI version?</strong></p>
          <p id="regen-warning" className="warn">{REGENERATE_WARNING}</p>
          <div className="actions">
            <button type="button" className="primary" autoFocus disabled={busy} onClick={() => { setConfirming(false); focusAfterBusy.current = true; void act(() => regenerateDraft(draft.id), 'A new AI version was requested'); }}>Make a new version</button>
            <button type="button" onClick={() => { setConfirming(false); focusLater(regenButton); }}>Cancel</button>
          </div>
        </div>
      )}

      {editing && (
        <form className="panel stack" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="Edit this draft">
          {stale && <p className="warn">The current version (version {draft.current?.no}) is now shown above. Your text is kept below: look it over, then save again to base it on that version.</p>}
          <label>
            Draft text (Markdown), based on version {base}
            <textarea rows={18} value={text} maxLength={MAX_BODY} onChange={(e) => setText(e.target.value)} autoFocus />
          </label>
          <span className="hint">{text.length.toLocaleString('en')} / {MAX_BODY.toLocaleString('en')} characters. Do not paste passwords or keys. Saving makes a new version marked as edited by you.</span>
          <div className="actions">
            <button className="primary" disabled={busy || text.trim() === ''}>Save as a new version</button>
            <button type="button" onClick={() => { setEditing(false); focusLater(editButton); setStale(false); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}

      {comparing && draft.versions.length > 1 && (
        <div className="panel stack" role="region" aria-label="Compare versions">
          <div className="actions">
            <label>
              From
              <select value={compareA} onChange={(e) => setCompareA(Number(e.target.value))}>
                {draft.versions.map((v) => <option key={v.no} value={v.no}>{verText(v)}</option>)}
              </select>
            </label>
            <label>
              To
              <select value={compareB} onChange={(e) => setCompareB(Number(e.target.value))}>
                {draft.versions.map((v) => <option key={v.no} value={v.no}>{verText(v)}</option>)}
              </select>
            </label>
          </div>
          {diff === null ? (
            <p className="loading">Loading</p>
          ) : diff.every((l) => l.op === 'same') ? (
            <p className="meta">These two versions are the same.</p>
          ) : (
            <pre className="diff" role="group" aria-label={`Changes from version ${compareA} to version ${compareB}`}>
              {diff.map((l, i) => (
                <span key={i} className={`diff-${l.op}`}>
                  <span className="visually-hidden">{diffWord(l.op)}: </span>
                  <span aria-hidden="true">{l.op === 'added' ? '+ ' : l.op === 'removed' ? '− ' : '  '}</span>
                  {l.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
          <p className="meta">Lines marked + (Added) are only in version {compareB}. Lines marked − (Removed) are only in version {compareA}.</p>
        </div>
      )}
    </section>
  );
}
