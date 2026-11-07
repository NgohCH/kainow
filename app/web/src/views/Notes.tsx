import { useEffect, useState } from 'react';
import { api, type SourceSummary } from '../api.ts';
import { go } from '../App.tsx';
import { formatWhen, plural } from '../format.ts';
import { Intake } from './Intake.tsx';

export function Notes() {
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.get<{ sources: SourceSummary[] }>('/notes').then(
      (r) => setSources(r.sources),
      (e: Error) => setError(e.message),
    );
  }, []);

  return (
    <main className="page narrow">
      <div className="row">
        <h1>Meeting notes</h1>
        <button className="primary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? 'Close' : 'Add notes'}</button>
      </div>
      {adding && (
        <section className="panel" aria-label="Add notes">
          <Intake withTitle pasteUrl="/notes" uploadUrl="/notes/upload" submitLabel="Add notes" onDone={(r) => go(`#/notes/${r.source.id}`)} />
        </section>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {sources === null && !error && <p className="loading">Loading</p>}
      {sources?.length === 0 && !adding && (
        <p className="empty">No notes yet. Add the notes from a meeting and Kainow will propose the decisions, actions, open questions and risks, each linked to the passage it came from.</p>
      )}
      {sources && sources.length > 0 && (
        <ul className="list">
          {sources.map((s) => (
            <li key={s.id}>
              <a href={`#/notes/${s.id}`}>
                <strong>{s.title}</strong>
                <span className="meta">{plural(s.versionCount, 'version')}, added {formatWhen(s.createdAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
