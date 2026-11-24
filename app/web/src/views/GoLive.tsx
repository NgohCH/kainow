import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { Box } from '../ui/Box.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Meaning } from '../ui/meanings.ts';
import { CLOSING_RULE, closedText, installText, linkKind, stepLinkHidden, stepState, tickWaitText, type GoLive as GoLiveData, type GoLiveStep } from '../golive.ts';

const message = (e: unknown): string => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

type Action = 'tick' | 'untick' | 'skip';

/** What a step shows as its state: done is set up, skipped is not in use, anything else needs doing. */
function stepMeaning(s: GoLiveStep): { meaning: Meaning; word: string } {
  if (!s.done) return { meaning: 'attention', word: 'Not done' };
  return s.skipped ? { meaning: 'off', word: 'Skipped' } : { meaning: 'ok', word: 'Done' };
}

function Step({ s, closed, onAction, busy }: { s: GoLiveStep; closed: boolean; onAction: (key: string, action: Action, note: string) => void; busy: boolean }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [skipping, setSkipping] = useState(false);
  const item = useRef<HTMLLIElement>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    onAction(s.key, skipping ? 'skip' : 'tick', note.trim());
    setAsking(false);
    setNote('');
  }

  const showTick = s.canTick && s.mode === 'confirm' && !s.done;
  const showSkip = s.canTick && (s.key === 'logos' || s.key === 'storage') && !s.done;
  // The test-email and recovery steps' Mark done stays visible but disabled until what it waits for is done.
  const waiting = tickWaitText(s, closed);
  const waitId = `wait-${s.key}`;
  const state = stepMeaning(s);
  return (
    <li ref={item} tabIndex={-1} id={`step-${s.key}`} className="golive-step">
      <Box meaning={state.meaning}>
      <h2 className="box-title golive-step-text">
        <span className="visually-hidden">Step {s.position}: </span>
        <span aria-hidden="true">{s.position}. </span>
        {s.text}
      </h2>
      <p><StatusLabel meaning={state.meaning} word={state.word} /></p>
      <p>{s.explanation}</p>
      <p>
        {linkKind(s.link) === 'page' ? (
          <a href={s.link}>
            Open the page for this step<span className="visually-hidden">{stepLinkHidden(s.position)}</span>
          </a>
        ) : (
          <span className="meta">{installText(s.link)}</span>
        )}
      </p>
      <p className="golive-state">
        <strong>{stepState(s)}</strong>
        {s.mode === 'auto' && <span className="meta"> (Kainow ticks this step itself)</span>}
      </p>
      {s.note && <p className="meta">Note: {s.note}</p>}
      {waiting && !asking && (
        <div className="golive-actions">
          <button type="button" disabled aria-describedby={waitId}>Mark done</button>
          <span id={waitId} className="meta">{waiting}</span>
        </div>
      )}
      {(showTick || showSkip || s.canUntick) && !asking && (
        <div className="golive-actions">
          {showTick && (
            <button type="button" disabled={busy} onClick={() => { setSkipping(false); setAsking(true); }} aria-label={`Mark done: ${s.text}`}>
              Mark done
            </button>
          )}
          {showSkip && (
            <button type="button" disabled={busy} onClick={() => { setSkipping(true); setAsking(true); }} aria-label={`Skip: ${s.text}`}>
              Skip
            </button>
          )}
          {s.canUntick && (
            <button type="button" disabled={busy} onClick={() => onAction(s.key, 'untick', '')} aria-label={`Mark not done: ${s.text}`}>
              Mark not done
            </button>
          )}
        </div>
      )}
      {asking && (
        <form className="stack golive-form" onSubmit={submit} aria-label={`${skipping ? 'Skip' : 'Mark done'}: step ${s.position}`}>
          <label>
            Note (optional, up to 200 characters)
            <input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </label>
          <div className="golive-actions">
            <button className="primary" disabled={busy}>{skipping ? 'Skip this step' : 'Mark done'}</button>
            <button type="button" className="quiet" onClick={() => { setAsking(false); setNote(''); item.current?.focus(); }}>Cancel</button>
          </div>
        </form>
      )}
      </Box>
    </li>
  );
}

export function GoLive() {
  const [data, setData] = useState<GoLiveData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.get<GoLiveData>('/go-live').then(setData, (e: unknown) => setError(message(e)));
  }, []);
  useEffect(load, [load]);

  async function act(key: string, action: Action, note: string) {
    if (!data) return;
    const step = data.steps.find((s) => s.key === key);
    setBusy(true);
    setActionError(null);
    try {
      const path = `/go-live/steps/${key}/${action}`;
      const next = await api.post<GoLiveData>(path, action === 'untick' ? undefined : note ? { note } : {});
      setData(next);
      window.dispatchEvent(new Event('golive-changed'));
      const verb = action === 'untick' ? 'marked not done' : action === 'skip' ? 'skipped' : 'marked done';
      setAnnounce(`Step ${step?.position ?? ''} ${verb}.`);
      // The button that was pressed may be gone, so focus moves to the step itself.
      requestAnimationFrame(() => document.getElementById(`step-${key}`)?.focus());
    } catch (e) {
      setActionError(message(e));
      // The checklist may have closed meanwhile; show what is true now.
      load();
    } finally {
      setBusy(false);
    }
  }

  const stepOf = (key: string) => data?.steps.find((s) => s.key === key);

  const doneCount = data?.steps.filter((x) => x.done).length ?? 0;
  const total = data?.steps.length ?? 0;

  return (
    <main className="page golive-page">
      <PageHeader
        crumbs={[{ text: 'Settings', href: '#/settings' }]}
        title="Go-live checklist"
        intro={data && !data.closedAt ? CLOSING_RULE : 'What is left to do before people use Kainow.'}
      />
      <p className="visually-hidden" role="status" aria-live="polite">{announce}</p>
      {error && (
        <p role="alert" className="error">
          {error} <button type="button" onClick={load}>Retry</button>
        </p>
      )}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      {!data && !error && <p className="loading" role="status">Loading</p>}
      {data && (
        <>
          <div className="stat-grid">
            <StatTile label="Steps done" value={`${doneCount} of ${total}`} meter={{ value: doneCount, max: total, text: `${doneCount} of ${total} steps done or skipped` }} />
            <StatTile
              label="Checklist"
              value={data.closedAt ? 'Closed' : 'Open'}
              meaning={data.closedAt ? 'closed' : 'attention'}
              word={data.closedAt ? 'Closed' : 'In progress'}
              note={data.closedAt ? closedText(data.closedAt) : undefined}
            />
          </div>
          {data.closedAt && (
            <>
              <Box title="Closed" meaning="closed">
                <p>{closedText(data.closedAt)}</p>
                <p className="meta">This page is now a record. Steps can no longer be changed.</p>
              </Box>
              <Box title="Not done at close">
                {data.notDoneAtClose.length === 0 ? (
                  <p className="meta">Every step was done.</p>
                ) : (
                  <ul>
                    {data.notDoneAtClose.map((k) => (
                      <li key={k}>Step {stepOf(k)?.position}: {stepOf(k)?.text ?? k}</li>
                    ))}
                  </ul>
                )}
              </Box>
            </>
          )}
          {/* role="list" keeps the list announced as one where list-style is removed (Safari). */}
          <ol className="golive-list" role="list">
            {data.steps.map((s) => (
              <Step key={s.key} s={s} closed={!!data.closedAt} onAction={(k, a, n) => void act(k, a, n)} busy={busy} />
            ))}
          </ol>
          {data.waitingFor && data.waitingFor.length > 0 && (
            <Box title="Also needed before the checklist closes" meaning="attention">
              <p className="meta">Kainow checks these itself. They are not steps and cannot be ticked.</p>
              <ul className="plain">
                {data.waitingFor.map((i) => (
                  <li key={i.key}>
                    <p><strong>{i.text}</strong></p>
                    <p>{i.explanation}</p>
                    <p>See {i.link}.</p>
                  </li>
                ))}
              </ul>
            </Box>
          )}
          {data.information && data.information.length > 0 && (
            <Box title="For information">
              <p className="meta">These are not steps. They do not hold up go-live.</p>
              <ul className="plain">
                {data.information.map((i) => (
                  <li key={i.key}>
                    <p><strong>{i.text}</strong></p>
                    <p>{i.explanation}</p>
                    <p><a href={i.link}>Open the page for this item</a></p>
                  </li>
                ))}
              </ul>
            </Box>
          )}
        </>
      )}
    </main>
  );
}
