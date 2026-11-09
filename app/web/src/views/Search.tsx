import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { go } from '../App.tsx';
import { accessLabel, roleLabel, STATUS_LABEL } from '../projects.ts';
import {
  highlight,
  KIND_LABELS,
  parseSearchHash,
  searchedLine,
  searchPath,
  SEARCH_KINDS,
  searchWords,
  type SearchProject,
  type SearchResponse,
  type SearchResult,
} from '../search.ts';

const PROJECT_ROUTE = /^#\/projects\/([0-9a-f-]{36})/i;

/** The search box in the header. On a project page it searches that project only. */
export function HeaderSearch({ hash }: { hash: string }) {
  const onSearch = hash.startsWith('#/search');
  const current = onSearch ? parseSearchHash(hash).q : '';
  const [value, setValue] = useState(current);
  useEffect(() => setValue(current), [current]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    const project = PROJECT_ROUTE.exec(hash)?.[1] ?? (onSearch ? parseSearchHash(hash).project : null);
    go('#' + searchPath({ q, project: project ?? undefined }));
  }

  return (
    <form role="search" className="header-search" onSubmit={submit}>
      <label className="visually-hidden" htmlFor="header-search-input">Search your projects</label>
      <input id="header-search-input" type="search" placeholder="Search your projects" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
    </form>
  );
}

function Marked({ text, words }: { text: string; words: string[] }) {
  return (
    <>
      {highlight(text, words).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

function accessText(p: SearchProject): string {
  if (p.myAccess.roles.length > 0) return `Your role: ${p.myAccess.roles.map(roleLabel).join(', ')}`;
  return p.myAccess.grant ? accessLabel(p.myAccess.grant) : '';
}

function ResultItem({ r, words }: { r: SearchResult; words: string[] }) {
  const ai = r.kind === 'ai_proposal';
  return (
    <li className={ai ? 'search-result ai-proposed' : 'search-result'}>
      <a href={r.href}>
        <span className="badge">{KIND_LABELS[r.kind]}</span>
        {ai && <span className="badge ai-label">AI proposed</span>}{' '}
        <strong><Marked text={r.title} words={words} /></strong>
        {r.status && <span className="meta inline"> · {r.status}</span>}
        {r.snippet && <span className="snippet"><Marked text={r.snippet} words={words} /></span>}
        {r.matchNote && <span className="meta snippet">{r.matchNote}</span>}
      </a>
    </li>
  );
}

const failure = (e: unknown): { status: number; message: string } =>
  e instanceof ApiError ? { status: e.status, message: e.message } : { status: 0, message: 'Something went wrong. Try again.' };

/** The search page. Its state is the address, so Back works. */
export function Search({ hash }: { hash: string }) {
  const state = parseSearchHash(hash);
  const [draft, setDraft] = useState(state.q);
  useEffect(() => setDraft(state.q), [state.q]);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [extra, setExtra] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const words = searchWords(state.q);

  useEffect(() => {
    setExtra([]);
    setError(null);
    if (state.q.trim() === '') {
      setData(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    api.get<SearchResponse>(searchPath({ q: state.q, kinds: state.kinds, archived: state.archived, project: state.project ?? undefined })).then(
      (r) => {
        if (!live) return;
        setData(r);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setData(null);
        setLoading(false);
        setError(failure(e));
      },
    );
    return () => {
      live = false;
    };
    // The address is the whole input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  const to = (p: { q?: string; kinds?: string[]; archived?: boolean; project?: string | null }) =>
    go(
      '#' +
        searchPath({
          q: p.q ?? state.q,
          kinds: p.kinds ?? state.kinds,
          archived: p.archived ?? state.archived,
          project: (p.project === undefined ? state.project : p.project) ?? undefined,
        }),
    );

  function submit(e: FormEvent) {
    e.preventDefault();
    to({ q: draft.trim() });
  }

  function toggleKind(k: string) {
    const next = state.kinds.includes(k) ? state.kinds.filter((x) => x !== k) : [...state.kinds, k];
    to({ kinds: SEARCH_KINDS.filter((x) => next.includes(x)) });
  }

  async function showMore(p: SearchProject) {
    setMore(true);
    try {
      const r = await api.get<SearchResponse>(
        searchPath({ q: state.q, kinds: state.kinds, archived: state.archived, project: p.id, offset: p.results.length + extra.length }),
      );
      setExtra((e) => [...e, ...(r.projects.find((x) => x.id === p.id)?.results ?? [])]);
    } catch (e) {
      setError(failure(e));
    } finally {
      setMore(false);
    }
  }

  const total = data ? data.projects.reduce((n, p) => n + p.total, 0) : 0;
  const only = state.project ? data?.projects.find((p) => p.id === state.project) : undefined;
  const onlyName = only?.name ?? 'this project';
  const unavailable = error?.status === 503;
  const badInput = error?.status === 400;

  return (
    <main className="search-page">
      <h1>Search</h1>
      <form role="search" aria-label="Search page" onSubmit={submit} className="stack search-form">
        <label>
          Words to find
          <input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={badInput || undefined}
            aria-describedby={badInput ? 'search-error' : undefined}
          />
        </label>
        {badInput && error && <p id="search-error" role="alert" className="error">{error.message}</p>}
        <button className="primary" disabled={draft.trim() === ''}>Search</button>
      </form>

      <details className="search-filters" open={state.kinds.length > 0 || state.archived}>
        <summary>Filters</summary>
        <fieldset>
          <legend>What to find</legend>
          {SEARCH_KINDS.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={state.kinds.includes(k)} onChange={() => toggleKind(k)} />
              {KIND_LABELS[k]}
            </label>
          ))}
          <p className="hint">With none ticked, everything is searched.</p>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={state.archived} onChange={(e) => to({ archived: e.target.checked })} />
          Include archived projects
        </label>
      </details>

      {state.project && (
        <p className="chips">
          <span className="chip">
            Only {onlyName}
            <button type="button" className="quiet" aria-label={`Remove the filter: only ${onlyName}`} onClick={() => to({ project: null })}>
              Remove
            </button>
          </span>
        </p>
      )}

      {loading && <p className="loading">Searching</p>}
      {unavailable && error && <p role="alert" className="error"><strong>Unavailable.</strong> {error.message}</p>}
      {error && !unavailable && !badInput && <p role="alert" className="error">{error.message}</p>}

      {data && !loading && (
        <>
          <p className="meta">{searchedLine(data.searched)}</p>
          <p aria-live="polite" className="count">
            {total === 0 ? 'No matches in the projects you can see.' : `${total} ${total === 1 ? 'match' : 'matches'}`}
          </p>
          {data.projects.map((p) => {
            const shown = [...p.results, ...(state.project === p.id ? extra : [])];
            const access = accessText(p);
            return (
              <section key={p.id} className="search-project" aria-labelledby={`sp-${p.id}`}>
                <h2 id={`sp-${p.id}`}>{p.name}</h2>
                <p className="meta">
                  {STATUS_LABEL[p.status]}
                  {p.archived && ' · Archived'}
                  {access && ` · ${access}`}
                  {` · ${p.total} ${p.total === 1 ? 'match' : 'matches'}`}
                </p>
                <ul className="plain search-results">
                  {shown.map((r) => (
                    <ResultItem key={`${r.kind}:${r.id}`} r={r} words={words} />
                  ))}
                </ul>
                {p.total > shown.length &&
                  (state.project === p.id ? (
                    <button type="button" disabled={more} onClick={() => void showMore(p)}>Show more</button>
                  ) : (
                    <a href={'#' + searchPath({ q: state.q, kinds: state.kinds, archived: state.archived, project: p.id })}>Show all {p.total} in this project</a>
                  ))}
              </section>
            );
          })}
        </>
      )}
      {!state.q.trim() && <p className="meta">Type words above to search the projects you can see.</p>}
    </main>
  );
}
