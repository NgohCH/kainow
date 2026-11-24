import { type FormEvent, useEffect, useReducer, useRef, useState } from 'react';
import { ApiError, api, type Project } from '../api.ts';
import {
  accessChangedLabel,
  audienceTag,
  editMessage,
  getThread,
  initialThread,
  isAccessLost,
  type MessageActionName,
  formatMeetingDate,
  messageActions,
  messageLines,
  type MessageVersion,
  messageVersions,
  type MessageView,
  moderate,
  type ModerationAction,
  NOT_AVAILABLE,
  pollDelay,
  postMessage,
  restrictedLabel,
  threadReducer,
  type ThreadView,
} from '../discussion.ts';
import { mayDraftSummary, mergeTimeline } from '../assist.ts';
import { formatWhen } from '../format.ts';
import { deletedLabel } from '../history.ts';
import { ThreadAnswerItem } from './AiAnswer.tsx';
import { ReportSecret } from './ReportSecret.tsx';
import { AnalysisStatus } from './AnalysisStatus.tsx';
import { MeetingControls } from './Meeting.tsx';
import { MinutesPanel, useMinutes } from './MinutesPanel.tsx';
import { SummaryRequest } from './SummaryView.tsx';
import { useFocusItem } from './useFocusItem.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** One discussion thread or meeting: the messages, the composer and the analysis status. */
export function Thread({ projectId, threadId, meId, messageNo, answerId = null }: { projectId: string; threadId: string; meId: string; messageNo: number | null; answerId?: string | null }) {
  const [first, setFirst] = useState<ThreadView | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getThread(threadId).then(setFirst, (e) => setError(e instanceof ApiError && e.status === 404 ? NOT_AVAILABLE : errText(e)));
    api.get<{ project: Project }>(`/projects/${projectId}`).then(
      (r) => setProject(r.project),
      () => undefined,
    );
  }, [threadId, projectId]);

  if (!first) {
    return (
      <main className="page narrow">
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
        <a href={`#/projects/${projectId}/discussion`}>Back to Discussion</a>
      </main>
    );
  }
  return <ThreadBody key={threadId} first={first} projectId={projectId} meId={meId} messageNo={messageNo} answerId={answerId} project={project} />;
}

function ThreadBody({ first, projectId, meId, messageNo, answerId, project }: { first: ThreadView; projectId: string; meId: string; messageNo: number | null; answerId: string | null; project: Project | null }) {
  const roles: string[] = project?.myRoles ?? [];
  const memberships = project?.memberships ?? [];
  const canRestore = roles.some((r) => r === 'pm' || r === 'deputy_pm');
  const open = project ? ['draft', 'planned', 'active'].includes(project.status) : false;
  const [s, dispatch] = useReducer(threadReducer, undefined, () => initialThread(first, meId));
  const [tick, setTick] = useState(0);
  const [pollError, setPollError] = useState<string | null>(null);
  // Set when a poll finds the thread is no longer readable: the content is dropped and polling stops.
  const [gone, setGone] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const t = s.thread;

  // Poll: every 5 seconds while the tab is visible, every 30 seconds otherwise; coming back to the tab polls at once.
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    // One chain only: a request in flight re-arms the timer when it completes, so coming back to the tab cannot start a second chain.
    let inFlight = false;
    const schedule = () => {
      timer = window.setTimeout(run, pollDelay(!document.hidden));
    };
    const run = () => {
      window.clearTimeout(timer);
      if (inFlight) return;
      inFlight = true;
      getThread(t.id).then(
        (fresh) => {
          inFlight = false;
          if (stopped) return;
          dispatch({ type: 'polled', thread: fresh });
          setTick((n) => n + 1);
          setPollError(null);
          schedule();
        },
        (e) => {
          inFlight = false;
          if (stopped) return;
          if (isAccessLost(e)) {
            // Access was lost or the audience narrowed: show nothing of the thread and stop asking.
            stopped = true;
            setGone(true);
            return;
          }
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
  // A link from the review list (`?answer=<id>`) scrolls to the shared answer and focuses it, once it is in the thread.
  const answerThere = answerId !== null && (t.aiAnswers ?? []).some((a) => a.id === answerId);
  useEffect(() => {
    if (!answerId || !answerThere) return;
    const el = document.getElementById(`answer-${answerId}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    el.classList.add('found');
    const timer = window.setTimeout(() => el.classList.remove('found'), 3000);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove('found');
    };
  }, [answerId, answerThere]);

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
  const meeting = t.kind === 'meeting';
  const { minutes, reload } = useMinutes(t.id, meeting && !gone, tick);
  const changed = accessChangedLabel(t.audience.changedAt);
  const restricted = restrictedLabel(t.audience.mode);

  if (gone) {
    return (
      <main className="page narrow">
        <p role="alert" className="error">{NOT_AVAILABLE}</p>
        <a href={`#/projects/${projectId}/discussion`}>Back to Discussion</a>
      </main>
    );
  }

  const reloadThread = () =>
    getThread(t.id).then(
      (fresh) => dispatch({ type: 'polled', thread: fresh }),
      () => undefined,
    );

  return (
    <main className={meeting ? 'page thread' : 'page narrow thread'}>
      <p><a href={`#/projects/${projectId}/discussion`}>Back to Discussion</a></p>
      <h1>{t.title}</h1>
      <p className="meta">
        {meeting ? 'Meeting' : 'Discussion'}
        {t.meetingDate ? ` · ${formatMeetingDate(t.meetingDate)}` : ''}
        {t.state === 'ended' ? ' · Ended' : ''}
        {' · '}
        {audienceLine}
        {restricted && <span className="badge badge-pending">{restricted}</span>}
        {changed && <span className="badge">{changed}</span>}
      </p>
      {meeting && (
        <MeetingControls
          thread={t}
          memberships={memberships}
          canEnd={!!minutes?.canEdit}
          canChangeAudience={open && roles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor')}
          onThread={(fresh) => dispatch({ type: 'polled', thread: fresh })}
          onAudienceChanged={() => void reloadThread()}
        />
      )}
      {meeting && t.audience.mode === 'restricted' && mayDraftSummary(roles, open) && <SummaryRequest target={{ kind: 'thread', id: t.id }} memberships={memberships} />}
      {t.state === 'ended' && <p className="meta">This meeting has ended, so no more messages can be posted.</p>}
      {!t.canPost && t.state !== 'ended' && <p className="meta">You can read this thread but not write in it.</p>}
      {pollError && <p role="status" className="warn">Could not refresh just now: {pollError}. Trying again.</p>}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{s.announce}</div>

      <AnalysisStatus threadId={t.id} projectId={projectId} refresh={tick} canRequest={t.kind === 'discussion' && t.canPost} selected={chosen} onRequested={() => undefined} />

      <div className={meeting ? 'meeting-split' : undefined}>
      <div>
      <section aria-label="Messages">
        {t.messages.length === 0 && (t.aiAnswers ?? []).length === 0 && <p className="empty">No messages yet.</p>}
        <ol className="messages">
          {mergeTimeline(t.messages, t.aiAnswers ?? []).map((item) =>
            item.kind === 'answer' ? (
              <ThreadAnswerItem key={`a-${item.answer.id}`} answer={item.answer} projectId={projectId} canModerate={t.canModerate} onChanged={() => void reloadThread()} />
            ) : (
              <MessageItem
                key={item.message.id}
                projectId={projectId}
                onReported={() => void reloadThread()}
                m={item.message}
                s={s}
                canPost={t.canPost}
                canModerate={t.canModerate}
                canRestore={canRestore}
                meId={meId}
                selectable={t.kind === 'discussion' && t.canPost && item.message.state === 'visible'}
                checked={chosen.includes(item.message.id)}
                onToggle={() => toggle(item.message.id)}
                dispatch={dispatch}
                onReply={() => {
                  dispatch({ type: 'replyTo', id: item.message.id });
                  composer.current?.focus();
                }}
              />
            ),
          )}
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
      </div>
      {meeting && <MinutesPanel threadId={t.id} projectId={projectId} title={t.title} minutes={minutes} reload={reload} audience={t.audience} memberships={memberships} />}
      </div>
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
  projectId,
  onReported,
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
  projectId: string;
  onReported: () => void;
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
  const item = useRef<HTMLLIElement>(null);
  // After an edit is saved or a moderation action finishes, the form is gone: focus goes back to the message, not the page top.
  const refocus = () => requestAnimationFrame(() => item.current?.focus());

  async function runModeration(e: FormEvent) {
    e.preventDefault();
    if (!reasonFor) return;
    setBusy(true);
    setError(null);
    try {
      dispatch({ type: 'merged', message: await moderate(m.id, reasonFor, reason) });
      setReasonFor(null);
      setReason('');
      refocus();
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
      refocus();
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
    <li ref={item} id={`item-${m.no}`} tabIndex={-1} className={`message message-${m.state}`}>
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
      {m.deletedBy !== undefined && m.deletedAt !== undefined ? (
        <p className="warn" role="note">{deletedLabel(m.deletedBy, m.deletedAt, m.deleteReason ?? '')}</p>
      ) : (
        lines.notice && <p className="notice">{lines.notice}</p>
      )}
      {m.quarantineLabel && <p className="warn" role="note">{m.quarantineLabel}</p>}
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
      {m.state === 'visible' && !editing && <ReportSecret projectId={projectId} kind="message" id={m.id} label={`message ${m.no}`} onReported={onReported} />}
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
