import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { QuarantineNote, ReportSecret } from './ReportSecret.tsx';
import { ApiError, type Membership } from '../api.ts';
import {
  AI_DRAFT_LABEL,
  type AudienceView,
  type DraftView,
  diffLines,
  draftBanner,
  draftMinutesWarning,
  getMinutes,
  getMinutesVersion,
  type MinutesView,
  publishConfirmation,
  publishDraft,
  requestMinutesDraft,
  saveMinutes,
  submitDraft,
} from '../discussion.ts';
import { canFlagDraft } from '../feedback.ts';
import { formatWhen } from '../format.ts';
import { FeedbackButton } from './Feedback.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** The meeting's draft minutes, loaded again whenever `tick` changes (the thread poll) or `reload` is called. */
export function useMinutes(threadId: string, enabled: boolean, tick: number): { minutes: MinutesView | null; reload: () => void } {
  const [minutes, setMinutes] = useState<MinutesView | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    getMinutes(threadId).then(
      (m) => !stale && setMinutes(m),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [threadId, enabled, tick, bump]);
  return { minutes, reload: useCallback(() => setBump((b) => b + 1), []) };
}

type Mode = 'view' | 'edit' | 'compare';

/** The Draft minutes panel: current draft, version list, compare, Edit, Draft minutes, Publish and Submit for publication. */
export function MinutesPanel({
  threadId,
  projectId,
  title,
  minutes,
  reload,
  audience,
  memberships,
}: {
  threadId: string;
  projectId: string;
  title: string;
  minutes: MinutesView | null;
  reload: () => void;
  audience: AudienceView;
  memberships: Membership[];
}) {
  const [picked, setPicked] = useState<number | null>(null); // a version other than the newest, being looked at
  const [pickedDraft, setPickedDraft] = useState<DraftView | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [editText, setEditText] = useState('');
  const [editBase, setEditBase] = useState(0);
  const [compare, setCompare] = useState<{ a: number; b: number; aText: string; bText: string } | null>(null);
  const [confirming, setConfirming] = useState<'publish' | 'submit' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ href: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<number, DraftView>());

  const newest = minutes?.current ?? null;
  const shown = picked !== null && picked !== newest?.versionNo ? pickedDraft : newest;

  useEffect(() => {
    if (picked === null || picked === newest?.versionNo) {
      setPickedDraft(null);
      return;
    }
    let stale = false;
    getMinutesVersion(threadId, picked).then(
      (d) => !stale && setPickedDraft(d),
      (e) => !stale && setError(errText(e)),
    );
    return () => {
      stale = true;
    };
  }, [threadId, picked, newest?.versionNo]);

  async function bodyOf(versionNo: number): Promise<string> {
    if (newest && versionNo === newest.versionNo) return newest.body;
    const hit = cache.current.get(versionNo);
    if (hit) return hit.body;
    const d = await getMinutesVersion(threadId, versionNo);
    cache.current.set(versionNo, d);
    return d.body;
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setLink(null);
    try {
      await work();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const askForDraft = () =>
    run(async () => {
      await requestMinutesDraft(threadId);
      setNotice('A new AI draft was requested. It appears here when it is ready.');
    });

  async function save(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      try {
        await saveMinutes(threadId, editText, editBase);
        setMode('view');
        setPicked(null);
        reload();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Someone saved a newer version: show it, keep this person's text, now based on the newer version.
          const current = (err.data as { current?: DraftView | null } | undefined)?.current;
          setEditBase(current?.versionNo ?? editBase);
          reload();
          throw new ApiError(`${err.message}. The newest version is now shown; your text is kept. Save again to replace it, or cancel.`, 409);
        }
        throw err;
      }
    });
  }

  const publish = () =>
    run(async () => {
      if (!shown) return;
      const r = await publishDraft(threadId, shown.versionNo);
      setConfirming(null);
      setNotice(r.notice ?? 'Published.');
      setLink({ href: `#/notes/${r.sourceId}`, text: 'Open the published minutes' });
    });

  const submit = () =>
    run(async () => {
      if (!shown) return;
      const r = await submitDraft(threadId, shown.versionNo);
      setConfirming(null);
      setNotice('Submitted for publication. A reviewer will publish it or return it with a reason.');
      setLink({ href: `#/notes/${r.id}`, text: 'Open the submission' });
    });

  async function startCompare(other: number, base: number) {
    await run(async () => {
      setCompare({ a: other, b: base, aText: await bodyOf(other), bText: await bodyOf(base) });
      setMode('compare');
    });
  }

  const warning = draftMinutesWarning(minutes?.hasHumanVersion ?? false);
  const banner = shown ? draftBanner(shown) : null;
  const canSubmit = !!minutes && minutes.canEdit && !minutes.canPublish;
  const versions = minutes?.versions ?? [];

  return (
    <aside className="panel minutes" aria-label="Draft minutes">
      <h2>Draft minutes</h2>
      {!minutes && <p className="loading">Loading</p>}
      {minutes && !shown && (
        <p className="empty">
          There is no draft yet. Press Draft minutes to have the AI write one from the messages{minutes.canEdit ? ', or write the minutes yourself' : ''}.
        </p>
      )}
      {shown && banner && mode === 'view' && (
        <div className={banner.className} tabIndex={0} aria-label={`Version ${shown.versionNo} of the draft minutes`}>
          <p className="badge ai-label">{banner.label}</p>
          <QuarantineNote text={shown.quarantineLabel} />
          <p className="meta">
            Version {shown.versionNo}, {formatWhen(shown.createdAt)}, covers messages up to #{shown.coversThroughNo}
            {banner.fromLine ? ` · ${banner.fromLine}` : ''}
          </p>
          <pre className="minutes-text">{shown.body}</pre>
        </div>
      )}
      {mode === 'edit' && (
        <form className="stack" onSubmit={save}>
          <label>
            Edit the minutes (plain Markdown, up to 100,000 characters)
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={16} maxLength={100000} required autoFocus />
          </label>
          <span className="actions">
            <button className="primary" disabled={busy || editText.trim() === ''}>Save as a new version</button>
            <button type="button" onClick={() => { setMode('view'); setError(null); }}>Cancel</button>
          </span>
        </form>
      )}
      {mode === 'compare' && compare && (
        <section aria-label="Compare versions">
          <h3>Version {compare.a} compared with version {compare.b}</h3>
          <div className="diff" role="group" aria-label="Differences">
            {diffLines(compare.aText, compare.bText).map((l, i) => (
              <div key={i} className={`diff-${l.kind}`}>
                <span className="diff-mark">{l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ' '}</span>
                <span className="visually-hidden">{l.kind === 'added' ? 'Added: ' : l.kind === 'removed' ? 'Removed: ' : 'Unchanged: '}</span>
                {l.text || ' '}
              </div>
            ))}
          </div>
          <button type="button" className="quiet" onClick={() => { setMode('view'); setCompare(null); }}>Close the comparison</button>
        </section>
      )}

      {versions.length > 0 && (
        <nav aria-label="Draft versions">
          <p className="meta">Versions</p>
          <ul className="versions-list">
            {versions.map((v) => (
              <li key={v.versionNo}>
                <button
                  type="button"
                  className="quiet"
                  aria-current={(shown?.versionNo ?? 0) === v.versionNo ? 'true' : undefined}
                  onClick={() => { setPicked(v.versionNo); setMode('view'); setCompare(null); }}
                >
                  Version {v.versionNo}
                </button>{' '}
                <span className="meta">
                  {v.origin === 'ai' ? AI_DRAFT_LABEL : `Edited by ${v.author?.displayName ?? 'a person'}`}{v.origin === 'ai' && v.label ? ` (${v.label})` : ''}, {formatWhen(v.createdAt)}
                </span>
              </li>
            ))}
          </ul>
          {versions.length > 1 && shown && (
            <label>
              Compare version {shown.versionNo} with
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) void startCompare(Number(e.target.value), shown.versionNo);
                }}
              >
                <option value="">Choose a version</option>
                {versions.filter((v) => v.versionNo !== shown.versionNo).map((v) => (
                  <option key={v.versionNo} value={v.versionNo}>Version {v.versionNo}</option>
                ))}
              </select>
            </label>
          )}
        </nav>
      )}

      <div className="actions">
        <button type="button" disabled={busy} onClick={askForDraft}>Draft minutes</button>
        {minutes?.canEdit && mode !== 'edit' && newest && (
          <button
            type="button"
            disabled={busy || shown?.versionNo !== newest.versionNo}
            onClick={() => { setEditText(newest.body); setEditBase(newest.versionNo); setMode('edit'); setError(null); }}
          >
            Edit
          </button>
        )}
        {minutes?.canEdit && mode !== 'edit' && !newest && (
          <button type="button" disabled={busy} onClick={() => { setEditText(''); setEditBase(0); setMode('edit'); setError(null); }}>Write minutes</button>
        )}
        {minutes?.canPublish && shown && <button type="button" className="primary" disabled={busy} onClick={() => setConfirming('publish')}>Publish</button>}
        {canSubmit && shown && <button type="button" className="primary" disabled={busy} onClick={() => setConfirming('submit')}>Submit for publication</button>}
        {shown && mode === 'view' && shown.id && <ReportSecret projectId={projectId} kind="minutes_draft" id={shown.id} label={`version ${shown.versionNo} of the draft minutes`} />}
        {shown && mode === 'view' && canFlagDraft(shown) && shown.id && (
          <FeedbackButton projectId={projectId} targetKind="minutes_draft" targetId={shown.id} label={`Give feedback on version ${shown.versionNo}`} />
        )}
      </div>
      {warning && <p className="warn" role="note">{warning}</p>}
      {confirming && shown && (
        <div className="panel" role="group" aria-label={confirming === 'publish' ? 'Confirm publishing' : 'Confirm submitting'}>
          <p>
            {confirming === 'publish'
              ? publishConfirmation(title, shown.versionNo, audience, memberships)
              : `Submit version ${shown.versionNo} of ${title} for a reviewer to publish. Only you and the reviewers can see it until then.`}
          </p>
          <span className="actions">
            <button type="button" className="primary" disabled={busy} onClick={confirming === 'publish' ? publish : submit}>
              {confirming === 'publish' ? 'Publish' : 'Submit'}
            </button>
            <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
          </span>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && (
        <p role="status" className="meta">
          {notice} {link && <a href={link.href}>{link.text}</a>}
        </p>
      )}
    </aside>
  );
}
