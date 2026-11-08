import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Run, type VersionSummary } from '../api.ts';
import { go } from '../App.tsx';
import { formatWhen, plural } from '../format.ts';
import { Intake } from './Intake.tsx';

interface Detail {
  source: { id: string; title: string; createdAt: string; projectId: string };
  versions: VersionSummary[];
}

const STATUS_TEXT: Record<Run['status'], string> = {
  queued: 'Waiting to start',
  running: 'Reading the notes',
  succeeded: 'Ready to review',
  failed: 'Failed',
  blocked: 'Not sent',
};

export function NoteDetail({ sourceId, versionNo }: { sourceId: string; versionNo: number | null }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<Detail>(`/notes/${sourceId}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load these notes.');
    }
  }, [sourceId]);
  useEffect(() => void load(), [load]);

  const current = detail ? (versionNo ?? detail.versions[detail.versions.length - 1]?.versionNo ?? null) : null;
  const version = detail?.versions.find((v) => v.versionNo === current);

  useEffect(() => {
    if (current === null) return;
    setText(null);
    api.get<{ version: { text: string } }>(`/notes/${sourceId}/versions/${current}`).then((r) => setText(r.version.text), () => setText(null));
  }, [sourceId, current]);

  const loadRuns = useCallback(async () => {
    if (current === null) return;
    const r = await api.get<{ runs: Run[] }>(`/notes/${sourceId}/versions/${current}/extractions`).catch(() => null);
    if (r) setRuns(r.runs);
  }, [sourceId, current]);
  useEffect(() => void loadRuns(), [loadRuns]);

  const active = runs.some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(loadRuns, 2000);
    return () => clearInterval(t);
  }, [active, loadRuns]);

  async function extract() {
    setStarting(true);
    setError(null);
    try {
      await api.post(`/notes/${sourceId}/versions/${current}/extractions`);
      await loadRuns();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the extraction.');
    } finally {
      setStarting(false);
    }
  }

  if (error && !detail) return <main className="page narrow"><p role="alert" className="error">{error}</p><a href="#/">All projects</a></main>;
  if (!detail || !version) return <p className="loading">Loading</p>;

  return (
    <main className="page">
      <p><a href={`#/projects/${detail.source.projectId}/notes`}>Back to the project's notes</a></p>
      <h1>{detail.source.title}</h1>
      <nav aria-label="Versions" className="versions">
        {detail.versions.map((v) => (
          <a key={v.id} href={`#/notes/${sourceId}/v/${v.versionNo}`} aria-current={v.versionNo === current ? 'page' : undefined}>
            Version {v.versionNo}
          </a>
        ))}
        <button className="quiet" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>Add a new version</button>
      </nav>
      {adding && (
        <section className="panel" aria-label="Add a new version">
          <p className="hint">A new version keeps the old one. Proposals always point at the exact version they were made from.</p>
          <Intake
            withTitle={false}
            pasteUrl={`/notes/${sourceId}/versions`}
            uploadUrl={`/notes/${sourceId}/versions/upload`}
            submitLabel="Add version"
            onDone={(r) => {
              setAdding(false);
              void load().then(() => go(`#/notes/${sourceId}/v/${r.version.versionNo}`));
            }}
          />
        </section>
      )}
      <div className="split">
        <section aria-label="Notes text">
          <p className="meta">
            Version {version.versionNo}, {version.origin === 'upload' ? `uploaded as ${version.filename}` : 'pasted'}, {version.charCount.toLocaleString()} characters, added {formatWhen(version.createdAt)}.{' '}
            {version.origin === 'upload' && <a href={api.originalUrl(sourceId, version.versionNo)}>Download the original file</a>}
          </p>
          <div className="source" tabIndex={0}>{text ?? 'Loading'}</div>
        </section>
        <aside aria-label="Proposals">
          <h2>Proposals from this version</h2>
          <button className="primary" onClick={extract} disabled={starting || active}>
            {active ? 'Reading the notes' : runs.length ? 'Run again' : 'Find decisions and actions'}
          </button>
          {error && <p role="alert" className="error">{error}</p>}
          {runs.length === 0 && <p className="hint">Kainow sends this version to an AI model, then shows each proposal beside the passage it quoted. Nothing is saved as approved until you approve it.</p>}
          <ul className="list runs">
            {runs.map((r) => (
              <li key={r.id}>
                <span className={`status status-${r.status}`}>{STATUS_TEXT[r.status]}</span>
                <span className="meta">{formatWhen(r.createdAt)}</span>
                {r.status === 'succeeded' && (
                  <>
                    <span>{plural(r.itemCount ?? 0, 'proposal')}{r.unlocatedCount ? `, ${r.unlocatedCount} not found in the notes` : ''}</span>
                    <a className="button" href={`#/runs/${r.id}`}>Review</a>
                  </>
                )}
                {(r.status === 'failed' || r.status === 'blocked') && <span className="reason">{r.failureDetail}</span>}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}
