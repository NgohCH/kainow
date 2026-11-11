import { useEffect, useState } from 'react';
import { api, type SourceSummary } from '../api.ts';
import { go } from '../App.tsx';
import { formatWhen, plural } from '../format.ts';
import { Intake } from './Intake.tsx';

/** The notes of one project, shown in its Notes tab. */
export function Notes({ projectId, canAdd }: { projectId: string; canAdd: boolean }) {
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.get<{ sources: SourceSummary[] }>(`/projects/${projectId}/notes`).then(
      (r) => setSources(r.sources),
      (e: Error) => setError(e.message),
    );
  }, [projectId]);

  return (
    <section aria-labelledby="notes-heading">
      <div className="row">
        <h2 id="notes-heading">Meeting notes</h2>
        {canAdd && (
          <button className="primary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            {adding ? 'Close' : 'Add notes'}
          </button>
        )}
      </div>
      {adding && (
        <section className="panel" aria-label="Add notes">
          <Intake
            withTitle
            pasteUrl={`/projects/${projectId}/notes`}
            uploadUrl={`/projects/${projectId}/notes/upload`}
            submitLabel="Add notes"
            onDone={(r) => go(`#/notes/${r.source.id}`)}
          />
        </section>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {sources === null && !error && <p className="loading">Loading</p>}
      {sources?.length === 0 && !adding && (
        <p className="empty">
          No notes yet.{' '}
          {canAdd
            ? 'Add the notes from a meeting and Kainow will propose the decisions, actions, open questions and risks, each linked to the passage it came from.'
            : 'The Project Manager, a Deputy, the Owner or a Sponsor adds them.'}
        </p>
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
    </section>
  );
}
