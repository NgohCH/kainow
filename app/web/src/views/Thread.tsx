import { type FormEvent, useEffect, useReducer, useRef, useState } from 'react';
import { ApiError, api, type Project } from '../api.ts';
import {
  audienceTag,
  editMessage,
  getThread,
  initialThread,
  type MessageActionName,
  messageActions,
  messageLines,
  type MessageVersion,
  messageVersions,
  type MessageView,
  moderate,
  type ModerationAction,
  pollDelay,
  postMessage,
  threadReducer,
  type ThreadView,
} from '../discussion.ts';
import { formatWhen } from '../format.ts';
import { AnalysisStatus } from './AnalysisStatus.tsx';
import { useFocusItem } from './useFocusItem.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** One discussion thread or meeting: the messages, the composer and the analysis status. */
export function Thread({ projectId, threadId, meId, messageNo }: { projectId: string; threadId: string; meId: string; messageNo: number | null }) {
  const [first, setFirst] = useState<ThreadView | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getThread(threadId).then(setFirst, (e) => setError(e instanceof ApiError && e.status === 404 ? 'This thread is not available to you.' : errText(e)));
    api.get<{ project: Project }>(`/projects/${projectId}`).then(
      (r) => setRoles(r.project.myRoles),
      () => undefined,
    );
  }, [threadId, projectId]);

  if (!first) {
    return (
      <main className="page narrow">
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
        <a href={`#/projects/${projectId}/notes`}>Back to Notes &amp; discussion</a>
      </main>
    );
  }
  return <ThreadBody key={threadId} first={first} projectId={projectId} meId={meId} messageNo={messageNo} canRestore={roles.some((r) => r === 'pm' || r === 'deputy_pm')} />;
}

function ThreadBody({ first, projectId, meId, messageNo, canRestore }: { first: ThreadView; projectId: string; meId: string; messageNo: number | null; canRestore: boolean }) {
  const [s, dispatch] = useReducer(threadReducer, undefined, () => initialThread(first, meId));
  const [tick, setTick] = useState(0);
  const [pollError, setPollError] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const t = s.thread;

  // Poll: every 5 seconds while the tab is visible, every 30 seconds otherwise; coming back to the tab polls at once.
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(run, pollDelay(!document.hidden));
    };
    const run = () => {
      window.clearTimeout(timer);
      getThread(t.id).then(
        (fresh) => {
          if (stopped) return;
          dispatch({ type: 'polled', thread: fresh });
          setTick((n) => n + 1);
          setPollError(null);
          schedule();
        },
        (e) => {
          if (stopped) return;
          setPollError(errText(e));
          schedule();
        },
      );
    };
    const onVisible = () => {
      if (!document.hidden) run();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [t.id]);

  // A link from search (`?m=<no>`) scrolls to the message and focuses it.
  useFocusItem(messageNo === null ? undefined : String(messageNo), true);

  async function post(e: FormEvent) {
    e.preventDefault();
    setPosting(true);
    setPostError(null);
    try {
      const message = await postMessage(t.id, s.draft, s.replyToId ?? undefined);
      dispatch({ type: 'posted', message });
      composer.current?.focus();
    } catch (err) {
      // The text stays in the box, so nothing is lost when the post is refused.
      setPostError(errText(err));
    } finally {
      setPosting(false);
    }
  }

  const replyTarget = s.replyToId ? t.messages.find((m) => m.id === s.replyToId) : undefined;
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const visibleIds = new Set(t.messages.filter((m) => m.state === 'visible').map((m) => m.id));
  const chosen = selected.filter((id) => visibleIds.has(id));
  const audienceLine =
    t.audience.mode === 'project'
      ? audienceTag('project')
      : `${audienceTag('restricted')}: ${t.audience.namedUsers.map((u) => u.displayName).join(', ') || 'no one named'}, plus the Project Manager, Deputies, Owner and Sponsors`;

  return (
    <main className="page narrow thread">
      <p><a href={`#/projects/${projectId}/notes`}>Back to Notes &amp; discussion</a></p>
      <h1>{t.title}</h1>
      <p className="meta">
        {t.kind === 'meeting' ? 'Meeting' : 'Discussion'}
        {t.meetingDate ? ` · ${t.meetingDate}` : ''}
        {t.state === 'ended' ? ' · Ended' : ''}
        {' · '}
        {audienceLine}
      </p>
      {t.kind === 'meeting' && t.present.length > 0 && <p className="meta">Present: {t.present.map((p) => p.displayName).join(', ')}</p>}
      {t.state === 'ended' && <p className="meta">This meeting has ended, so no more messages can be posted.</p>}
      {!t.canPost && t.state !== 'ended' && <p className="meta">You can read this thread but not write in it.</p>}
      {pollError && <p role="status" className="warn">Could not refresh just now: {pollError}. Trying again.</p>}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{s.announce}</div>

      <AnalysisStatus threadId={t.id} refresh={tick} canRequest={t.kind === 'discussion' && t.canPost} selected={chosen} onRequested={() => undefined} />

      <section aria-label="Messages">
        {t.messages.length === 0 && <p className="empty">No messages yet.</p>}
        <ol className="messages">
          {t.messages.map((m) => (
            <MessageItem
              key={m.id}
              m={m}
              s={s}
              canPost={t.canPost}
              canModerate={t.canModerate}
              canRestore={canRestore}
              meId={meId}
              selectable={t.kind === 'discussion' && t.canPost && m.state === 'visible'}
              checked={chosen.includes(m.id)}
              onToggle={() => toggle(m.id)}
              dispatch={dispatch}
              onReply={() => {
                dispatch({ type: 'replyTo', id: m.id });
                composer.current?.focus();
              }}
            />
          ))}
        </ol>
      </section>

      {t.canPost && (
        <form className="stack composer" onSubmit={post}>
          {replyTarget && (
            <p className="meta">
              Replying to #{replyTarget.no} by {replyTarget.author.displayName}{' '}
              <button type="button" className="quiet" onClick={() => dispatch({ type: 'replyTo', id: null })}>Cancel reply</button>
            </p>
          )}
          <label>
            Write a message
            <textarea ref={composer} value={s.draft} onChange={(e) => dispatch({ type: 'draft', text: e.target.value })} rows={4} maxLength={10000} required />
            <span className="hint">Plain text, up to 10,000 characters. Do not paste passwords or keys.</span>
          </label>
          {postError && <p role="alert" className="error">{postError}</p>}
          <button className="primary" disabled={posting || s.draft.trim() === ''}>{posting ? 'Posting' : 'Post'}</button>
        </form>
      )}
    </main>
  );
}

const ACTION_LABEL: Record<MessageActionName, string> = {
  reply: 'Reply',
  edit: 'Edit',
  hide: 'Hide',
  unhide: 'Unhide',
  delete: 'Delete',
  restore: 'Restore',
};

function MessageItem({
  m,
  s,
  canPost,
  canModerate,
  canRestore,
  meId,
  selectable,
  checked,
  onToggle,
  dispatch,
  onReply,
}: {
  m: MessageView;
  s: ReturnType<typeof initialThread>;
  canPost: boolean;
  canModerate: boolean;
  canRestore: boolean;
  meId: string;
  selectable: boolean;
  checked: boolean;
  onToggle: () => void;
  dispatch: (a: Parameters<typeof threadReducer>[1]) => void;
  onReply: () => void;
}) {
  const lines = messageLines(m);
  const actions = messageActions(m, { meId, canPost, canModerate, canRestore });
  const [reasonFor, setReasonFor] = useState<ModerationAction | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<MessageVersion[] | null>(null);
  const editing = s.editing?.id === m.id ? s.editing : null;

  async function runModeration(e: FormEvent) {
    e.preventDefault();
    if (!reasonFor) return;
    setBusy(true);
    setError(null);
    try {
      dispatch({ type: 'merged', message: await moderate(m.id, reasonFor, reason) });
      setReasonFor(null);
      setReason('');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      dispatch({ type: 'merged', message: await editMessage(m.id, editing.text, editing.basedOn) });
      dispatch({ type: 'cancelEdit' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else changed it: show their copy and keep this person's text, now based on the newer version.
        const current = (err.data as { current?: MessageView } | undefined)?.current;
        if (current) {
          dispatch({ type: 'merged', message: current });
          dispatch({ type: 'startEdit', id: m.id, text: editing.text, basedOn: current.version });
          setError(`${err.message}. The message now reads as shown above; your text is kept. Save again to replace it, or cancel.`);
        } else setError(err.message);
      } else setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleVersions() {
    if (versions) return setVersions(null);
    try {
      setVersions(await messageVersions(m.id));
    } catch (err) {
      setError(errText(err));
    }
  }

  function act(a: MessageActionName) {
    if (a === 'reply') return onReply();
    if (a === 'edit') return dispatch({ type: 'startEdit', id: m.id, text: m.text ?? '', basedOn: m.version });
    setReasonFor(a);
    setReason('');
    setError(null);
  }

  return (
    <li id={`item-${m.no}`} tabIndex={-1} className={`message message-${m.state}`}>
      <p className="meta byline">
        {selectable && (
          <label className="check inline-check">
            <input type="checkbox" checked={checked} onChange={onToggle} />
            <span className="visually-hidden">Select message {m.no} for analysis</span>
          </label>
        )}
        {lines.byline}
        {lines.edited && (
          <>
            {' · '}
            <button type="button" className="quiet" aria-expanded={versions !== null} onClick={toggleVersions}>edited</button>
          </>
        )}
      </p>
      {lines.replyLine && <p className="reply-quote">{lines.replyLine}</p>}
      {lines.notice && <p className="notice">{lines.notice}</p>}
      {editing ? (
        <form className="stack" onSubmit={saveEdit}>
          <label>
            Edit message {m.no}
            <textarea value={editing.text} onChange={(e) => dispatch({ type: 'editText', text: e.target.value })} rows={4} maxLength={10000} required autoFocus />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <span className="actions">
            <button className="primary" disabled={busy}>Save</button>
            <button type="button" onClick={() => { dispatch({ type: 'cancelEdit' }); setError(null); }}>Cancel</button>
          </span>
        </form>
      ) : (
        lines.text !== null && <p className="message-text">{lines.text}</p>
      )}
      {versions && (
        <ol className="meta versions-list" aria-label={`Earlier versions of message ${m.no}`}>
          {versions.map((v) => (
            <li key={v.versionNo}>
              Version {v.versionNo}, {formatWhen(v.createdAt)}: <span className="message-text">{v.text}</span>
            </li>
          ))}
        </ol>
      )}
      {!editing && actions.length > 0 && (
        <div className="actions">
          {actions.map((a) => (
            <button key={a} type="button" className="quiet" onClick={() => act(a)} aria-label={`${ACTION_LABEL[a]} message ${m.no}`}>
              {ACTION_LABEL[a]}
            </button>
          ))}
        </div>
      )}
      {reasonFor && (
        <form className="inline-form" onSubmit={runModeration}>
          <label>
            Reason to {reasonFor} message {m.no}
            <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
          </label>
          <button className="primary" disabled={busy || reason.trim() === ''}>{ACTION_LABEL[reasonFor]}</button>
          <button type="button" onClick={() => { setReasonFor(null); setError(null); }}>Cancel</button>
        </form>
      )}
      {!editing && error && <p role="alert" className="error">{error}</p>}
    </li>
  );
}
