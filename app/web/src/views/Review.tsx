import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type Item, type Run } from '../api.ts';
import { KIND_LABEL, plural } from '../format.ts';
import { buildSegments } from '../segments.ts';

interface RunView {
  run: Run;
  source: { sourceId: string; title: string; versionNo: number };
  items: Item[];
}

const STATUS_LABEL = { pending: 'Not reviewed', approved: 'Approved', rejected: 'Rejected' } as const;

export function Review({ runId }: { runId: string }) {
  const [view, setView] = useState<RunView | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sure, setSure] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const marks = useRef(new Map<string, HTMLElement>());
  const cards = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    api.get<RunView>(`/extractions/${runId}`).then(
      async (v) => {
        setView(v);
        setSelected((cur) => cur ?? v.items[0]?.id ?? null);
        const t = await api.get<{ version: { text: string } }>(`/notes/${v.source.sourceId}/versions/${v.source.versionNo}`);
        setText(t.version.text);
      },
      (e: Error) => setError(e.message),
    );
  }, [runId]);

  const items = view?.items ?? [];
  const segments = useMemo(() => (text === null ? [] : buildSegments(text, items)), [text, items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const current = selected ? byId.get(selected) : undefined;

  const select = useCallback((id: string, scrollSource: boolean) => {
    setSelected(id);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = reduce ? 'auto' : 'smooth';
    if (scrollSource) marks.current.get(id)?.scrollIntoView({ block: 'center', behavior });
    else cards.current.get(id)?.scrollIntoView({ block: 'nearest', behavior });
  }, []);

  const decide = useCallback(
    async (item: Item, decision: 'approved' | 'rejected') => {
      if (!view || saving.has(item.id)) return;
      setSaving((s) => new Set(s).add(item.id));
      setError(null);
      try {
        const r = await api.post<{ item: Item }>(`/extractions/${runId}/items/${item.id}/review`, {
          decision,
          sourceVersionId: view.run.sourceVersionId,
          acknowledgeRepeatedQuote: item.quoteMatches > 1 ? sure[item.id] === true : undefined,
        });
        setView((v) => (v ? { ...v, items: v.items.map((i) => (i.id === item.id ? r.item : i)) } : v));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'The decision was not saved. Try again.');
      } finally {
        setSaving((s) => {
          const next = new Set(s);
          next.delete(item.id);
          return next;
        });
      }
    },
    [view, saving, runId, sure],
  );

  // j and k move between proposals, a approves and r rejects the one in focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const idx = items.findIndex((i) => i.id === selected);
      if (e.key === 'j' && idx < items.length - 1) select(items[idx + 1].id, true);
      else if (e.key === 'k' && idx > 0) select(items[idx - 1].id, true);
      else if (current && e.key === 'a' && canApprove(current, sure)) void decide(current, 'approved');
      else if (current && e.key === 'r') void decide(current, 'rejected');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, selected, current, select, decide, sure]);

  if (error && !view) return <main className="page narrow"><p role="alert" className="error">{error}</p><a href="#/">Back to notes</a></main>;
  if (!view) return <p className="loading">Loading</p>;

  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const i of items) counts[i.reviewStatus]++;
  const status = (id: string) => byId.get(id)?.reviewStatus ?? 'pending';

  return (
    <main className="page review">
      <p><a href={`#/notes/${view.source.sourceId}/v/${view.source.versionNo}`}>Back to {view.source.title}</a></p>
      <div className="row">
        <h1>Review proposals</h1>
        <p className="tally" aria-live="polite">
          {counts.pending} to review, {counts.approved} approved, {counts.rejected} rejected
        </p>
      </div>
      <p className="meta">
        From {view.source.title}, version {view.source.versionNo}. Approving a proposal confirms the quoted passage in this version says it.
        Keys: j and k move, a approves, r rejects.
      </p>
      {error && <p role="alert" className="error">{error}</p>}
      {items.length === 0 && <p className="empty">The model found nothing to propose in this version.</p>}

      <div className="split review-split">
        <section aria-label="Source text">
          <div className="source" tabIndex={0}>
            {segments.map((s) =>
              s.ids.length === 0 ? (
                <span key={s.start}>{s.text}</span>
              ) : (
                <mark
                  key={s.start}
                  ref={(el) => {
                    for (const id of s.ids) {
                      if (!el) marks.current.delete(id);
                      else if (!marks.current.has(id)) marks.current.set(id, el);
                    }
                  }}
                  className={`passage passage-${status(s.ids.includes(selected ?? '') ? (selected as string) : s.ids[0])}${s.ids.includes(selected ?? '') ? ' is-selected' : ''}`}
                  onClick={() => select(s.ids.includes(selected ?? '') ? (selected as string) : s.ids[0], false)}
                >
                  {s.text}
                </mark>
              ),
            )}
          </div>
        </section>

        <section aria-label="Proposals" className="proposals">
          {items.map((item) => (
            <article
              key={item.id}
              ref={(el) => void (el ? cards.current.set(item.id, el) : cards.current.delete(item.id))}
              className={`proposal kind-${item.kind} status-${item.reviewStatus}${item.id === selected ? ' is-selected' : ''}`}
              aria-current={item.id === selected ? 'true' : undefined}
            >
              <button className="proposal-main" onClick={() => select(item.id, true)}>
                <span className="kind">{KIND_LABEL[item.kind]}</span>
                <span className="proposal-text">{item.text}</span>
                {(item.owner || item.due) && (
                  <span className="meta">{[item.owner && `Owner: ${item.owner}`, item.due && `Due: ${item.due}`].filter(Boolean).join(', ')}</span>
                )}
              </button>
              <blockquote>{item.quote}</blockquote>
              {item.quoteMatches === 0 && (
                <p className="warn">This quote is not in the notes. The model may have made it up, so it cannot be approved.</p>
              )}
              {item.quoteMatches > 1 && (
                <label className="warn">
                  <input type="checkbox" checked={sure[item.id] === true} onChange={(e) => setSure((s) => ({ ...s, [item.id]: e.target.checked }))} />
                  The quote appears {plural(item.quoteMatches, 'time')} in the notes. The first is highlighted. I checked this is the passage meant.
                </label>
              )}
              <div className="decision">
                <span className={`badge badge-${item.reviewStatus}`}>{STATUS_LABEL[item.reviewStatus]}</span>
                <button
                  className="approve"
                  disabled={saving.has(item.id) || item.reviewStatus === 'approved' || !canApprove(item, sure)}
                  onClick={() => void decide(item, 'approved')}
                >
                  Approve
                </button>
                <button className="reject" disabled={saving.has(item.id) || item.reviewStatus === 'rejected'} onClick={() => void decide(item, 'rejected')}>
                  Reject
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

function canApprove(item: Item, sure: Record<string, boolean>): boolean {
  return item.quoteMatches === 1 || (item.quoteMatches > 1 && sure[item.id] === true);
}
