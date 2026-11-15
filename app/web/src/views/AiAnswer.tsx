import { type FormEvent, Fragment, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import {
  ANSWER_LABEL,
  type AnswerSource,
  type Inline,
  hideAnswer,
  parseMarkdown,
  safeHref,
  sourcesSummary,
  type ThreadAnswerView,
  unhideAnswer,
} from '../assist.ts';
import { formatWhen } from '../format.ts';
import { FeedbackButton } from './Feedback.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** The answer text (read as Markdown into plain React nodes, never HTML), then the sources used. [Pn] markers open the matching source. */
export function AnswerBody({
  id,
  scope,
  markdown,
  sources,
  droppedCount,
}: {
  id: string;
  /** 'panel' or 'thread': the same answer can be on screen in both, so DOM ids carry the scope. */
  scope: string;
  markdown: string | null;
  sources: AnswerSource[];
  droppedCount: number;
}) {
  const [open, setOpen] = useState(false);
  const { shown, droppedText } = sourcesSummary(sources, droppedCount);
  const known = new Set(shown.map((s) => s.marker));
  const sourceId = (marker: string) => `${scope}-src-${id}-${marker}`;

  function jump(marker: string) {
    setOpen(true);
    requestAnimationFrame(() => document.getElementById(sourceId(marker))?.focus());
  }

  const inline = (parts: Inline[]) =>
    parts.map((p, i) => {
      if (p.t === 'bold') return <strong key={i}>{p.text}</strong>;
      if (p.t === 'code') return <code key={i}>{p.text}</code>;
      if (p.t === 'marker')
        return known.has(p.text) ? (
          <button key={i} type="button" className="quiet marker" aria-label={`Source ${p.text}`} onClick={() => jump(p.text)}>
            {p.text}
          </button>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        );
      return <Fragment key={i}>{p.text}</Fragment>;
    });

  return (
    <>
      {markdown !== null && (
        <div className="answer-text">
          {parseMarkdown(markdown).map((b, i) => {
            if (b.t === 'p') return <p key={i}>{inline(b.inlines)}</p>;
            if (b.t === 'h') return <p key={i}><strong>{inline(b.inlines)}</strong></p>;
            const Tag = b.t;
            return (
              <Tag key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </Tag>
            );
          })}
        </div>
      )}
      {(shown.length > 0 || droppedText) && (
        <details className="answer-sources" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>Sources used ({shown.length})</summary>
          <ul>
            {shown.map((s) => (
              <li key={s.marker} id={sourceId(s.marker)} tabIndex={-1}>
                <strong>{s.marker}</strong>{' '}
                {safeHref(s.href) ? <a href={safeHref(s.href)!}>{s.location ?? 'Open source'}</a> : (s.location ?? 'Source')}
                {s.cited ? ' (cited in the answer)' : ' (looked at, not cited)'}
              </li>
            ))}
            {droppedText && <li>{droppedText}</li>}
          </ul>
        </details>
      )}
    </>
  );
}

/** One shared answer in a thread: dashed outline, labelled as AI, with moderator hide/unhide and feedback. */
export function ThreadAnswerItem({
  answer,
  projectId,
  canModerate,
  onChanged,
}: {
  answer: ThreadAnswerView;
  projectId: string;
  canModerate: boolean;
  onChanged: () => void;
}) {
  const [reasonFor, setReasonFor] = useState<'hide' | 'unhide' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const closeForm = () => {
    setReasonFor(null);
    setError(null);
    requestAnimationFrame(() => hideButton.current?.focus());
  };

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!reasonFor) return;
    setBusy(true);
    setError(null);
    try {
      await (reasonFor === 'hide' ? hideAnswer : unhideAnswer)(answer.id, reason);
      setReason('');
      closeForm();
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li id={`answer-${answer.id}`} tabIndex={-1} className="message ai-proposed ai-answer">
      <p className="meta byline">
        <span className="ai-label">AI answer</span>
        Asked by {answer.askedBy.displayName} · shared {formatWhen(answer.sharedAt)}
      </p>
      {answer.question !== null && <p className="answer-question"><strong>Question:</strong> {answer.question}</p>}
      {answer.notice && <p className="notice">{answer.notice}</p>}
      {answer.answerMarkdown !== null && <p className="meta">{ANSWER_LABEL}</p>}
      {(answer.answerMarkdown !== null || answer.sources.length > 0) && <AnswerBody id={answer.id} scope="thread" markdown={answer.answerMarkdown} sources={answer.sources} droppedCount={answer.droppedCount} />}
      <div className="actions">
        {canModerate && (
          <button type="button" ref={hideButton} className="quiet" aria-label={`${answer.hidden ? 'Unhide' : 'Hide'} AI answer asked by ${answer.askedBy.displayName}`} onClick={() => { setReasonFor(answer.hidden ? 'unhide' : 'hide'); setError(null); }}>
            {answer.hidden ? 'Unhide' : 'Hide'}
          </button>
        )}
        {!answer.hidden && answer.answerMarkdown !== null && (
          <FeedbackButton projectId={projectId} targetKind="answer" targetId={answer.id} label="Give feedback on this AI answer" />
        )}
      </div>
      {reasonFor && (
        <form className="inline-form" onSubmit={run}>
          <label>
            Reason to {reasonFor} this AI answer
            <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
          </label>
          <button className="primary" disabled={busy || reason.trim() === ''}>{reasonFor === 'hide' ? 'Hide' : 'Unhide'}</button>
          <button type="button" onClick={closeForm}>Cancel</button>
        </form>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </li>
  );
}
