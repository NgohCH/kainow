import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import {
  ANSWER_LABEL,
  ANSWER_POLL_MS,
  type AnswerView,
  askQuestion,
  isActive,
  listQuestions,
  MAX_QUESTION,
  questionCounter,
  questionProblem,
  reanswerQuestion,
  REANSWER_LABEL,
  shareQuestion,
  shareRefusal,
  statusText,
} from '../assist.ts';
import { type DiscussionItem, listDiscussion, threadPath } from '../discussion.ts';
import { formatWhen } from '../format.ts';
import { AnswerBody } from './AiAnswer.tsx';
import { FeedbackButton } from './Feedback.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** The Ask panel: a side panel on wide screens and a full page on narrow ones (see .ask-panel in styles.css). */
export function AskPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [items, setItems] = useState<AnswerView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [threads, setThreads] = useState<DiscussionItem[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const seen = useRef(new Map<string, AnswerView['status']>());

  const load = useCallback(async () => {
    try {
      const fresh = await listQuestions(projectId);
      for (const a of fresh) {
        const before = seen.current.get(a.id);
        if (before && (before === 'queued' || before === 'running') && !isActive(a)) {
          setAnnounce(a.status === 'answered' || a.status === 'not_found' ? 'An AI answer is ready' : 'An AI question could not be answered');
        }
        seen.current.set(a.id, a.status);
      }
      setItems(fresh);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    listDiscussion(projectId).then((all) => setThreads(all.filter((i) => (i.kind === 'discussion' || i.kind === 'meeting') && i.state !== 'ended')), () => undefined);
    heading.current?.focus();
  }, [load, projectId]);

  // Poll every 3 seconds while anything is queued or running.
  const active = items.some(isActive);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void load(), ANSWER_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [active, items, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const p = questionProblem(text);
    setProblem(p);
    if (p) return;
    setSending(true);
    setError(null);
    try {
      const a = await askQuestion(projectId, text.trim());
      seen.current.set(a.id, a.status);
      setItems((cur) => [a, ...cur.filter((x) => x.id !== a.id)]);
      setText('');
      setAnnounce('Question sent');
    } catch (err) {
      // The text stays in the box so nothing is lost.
      setError(errText(err));
    } finally {
      setSending(false);
    }
  }

  const add = (a: AnswerView) => {
    seen.current.set(a.id, a.status);
    setItems((cur) => [a, ...cur.filter((x) => x.id !== a.id)]);
  };
  const replace = (a: AnswerView) => setItems((cur) => cur.map((x) => (x.id === a.id ? a : x)));

  return (
    <aside className="ask-panel" aria-labelledby="ask-heading">
      <div className="row">
        <h2 id="ask-heading" tabIndex={-1} ref={heading}>Ask about this project</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <p className="meta">Answers use only what you can read in this project. Each one is AI output: check the sources.</p>
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
      <form className="stack" onSubmit={send} noValidate>
        <label>
          Your question
          <textarea value={text} onChange={(e) => { setText(e.target.value); setProblem(null); }} rows={3} aria-describedby="ask-count" aria-invalid={problem ? true : undefined} />
        </label>
        <span id="ask-count" className="hint">{questionCounter(text)} (1 to {MAX_QUESTION} characters). Do not paste passwords or keys.</span>
        {problem && <p role="alert" className="error">{problem}</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary" disabled={sending}>{sending ? 'Sending' : 'Ask'}</button>
      </form>
      <h3>Your questions</h3>
      {!loaded && <p className="loading">Loading</p>}
      {loaded && items.length === 0 && <p className="empty">You have not asked anything here yet.</p>}
      <ul className="ask-list">
        {items.map((a) => (
          <AskCard key={a.id} a={a} projectId={projectId} threads={threads} onNew={add} onChanged={replace} />
        ))}
      </ul>
    </aside>
  );
}

function AskCard({ a, projectId, threads, onNew, onChanged }: { a: AnswerView; projectId: string; threads: DiscussionItem[]; onNew: (a: AnswerView) => void; onChanged: (a: AnswerView) => void }) {
  const [threadId, setThreadId] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; canReanswer: boolean } | null>(null);
  const done = a.status === 'answered';
  const sharedTo = a.visibility === 'shared' && a.sharedThreadId ? a.sharedThreadId : null;

  async function share(e: FormEvent) {
    e.preventDefault();
    if (!threadId) return;
    setBusy(true);
    setRefusal(null);
    try {
      onChanged(await shareQuestion(a.id, threadId));
    } catch (err) {
      setRefusal(shareRefusal(err));
    } finally {
      setBusy(false);
    }
  }

  async function reanswer() {
    setBusy(true);
    try {
      onNew(await reanswerQuestion(a.id, threadId));
      setRefusal(null);
    } catch (err) {
      setRefusal({ message: errText(err), canReanswer: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="ask-card ai-proposed">
      <p className="meta">
        {done && <span className="ai-label">AI answer</span>}
        Asked {formatWhen(a.askedAt)}
      </p>
      {a.question !== null && <p className="answer-question"><strong>Question:</strong> {a.question}</p>}
      <p className={a.status === 'failed' || a.status === 'blocked' ? 'warn' : 'meta'} role={isActive(a) ? 'status' : undefined}>
        {done ? ANSWER_LABEL : statusText(a)}
      </p>
      {a.status === 'not_found' && a.searchedWords.length > 0 && <p className="meta">Searched for: {a.searchedWords.join(', ')}</p>}
      {a.notice && done && <p className="notice">{a.notice}</p>}
      {a.answerMarkdown !== null && <AnswerBody id={a.id} markdown={a.answerMarkdown} sources={a.sources} droppedCount={a.droppedCount} />}
      {(a.status === 'not_found' || a.status === 'failed') && a.sources.length > 0 && <AnswerBody id={a.id} markdown={null} sources={a.sources} droppedCount={a.droppedCount} />}
      {done && <FeedbackButton projectId={projectId} targetKind="answer" targetId={a.id} label="Give feedback on this AI answer" />}
      {done && sharedTo && (
        <p className="meta">
          Shared in <a href={threadPath(projectId, sharedTo)}>{threads.find((t) => t.id === sharedTo)?.title ?? 'a thread'}</a>
          {a.hidden ? ' (hidden by a moderator)' : ''}
        </p>
      )}
      {done && !sharedTo && (
        <form className="inline-form" onSubmit={share}>
          <label>
            Share into
            <select value={threadId} onChange={(e) => { setThreadId(e.target.value); setRefusal(null); }}>
              <option value="">Choose a thread or meeting</option>
              {threads.map((t) => (
                <option key={t.id} value={t.id}>{t.kind === 'meeting' ? 'Meeting' : 'Discussion'}: {t.title}</option>
              ))}
            </select>
          </label>
          <button disabled={busy || !threadId}>Share</button>
        </form>
      )}
      {refusal && (
        <div role="alert" className="error">
          <p>{refusal.message}</p>
          {refusal.canReanswer && <button type="button" disabled={busy} onClick={() => void reanswer()}>{REANSWER_LABEL}</button>}
        </div>
      )}
    </li>
  );
}
