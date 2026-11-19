import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api.ts';
import { formatDay } from '../format.ts';
import { RestoreAction } from './DeleteRestore.tsx';
import { type HistoryLine, historyLineText, historyLineTitle, listDeletions } from '../history.ts';

/** "Deletions and restorations": kind, actor, day and reason of each, never the title unless the viewer holds Inspect Deleted Content. */
export function DeletionsList({ projectId }: { projectId: string }) {
  const [lines, setLines] = useState<HistoryLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    listDeletions(projectId).then(
      (l) => {
        setLines(l);
        setError(null);
      },
      (e) => setError(e instanceof ApiError && e.status === 404 ? null : e instanceof ApiError ? e.message : 'Could not load the deletions and restorations.'),
    );
  }, [projectId]);
  useEffect(load, [load]);
  // Someone who cannot see the project's history (a 404) sees no section at all.
  if (lines === null && error === null) return null;
  return (
    <>
      <h3 id="deletions-heading">Deletions and restorations</h3>
      {error && <p role="alert" className="error">{error}</p>}
      {lines && lines.length === 0 && <p className="meta">Nothing has been deleted or restored.</p>}
      {lines && lines.length > 0 && (
        <ul className="plain" aria-labelledby="deletions-heading">
          {lines.map((l, i) => {
            const t = historyLineTitle(l);
            return (
              <li key={i}>
                {historyLineText(l)}
                {t && (
                  <>
                    {' — '}
                    <a href={t.href}>{t.title}</a>
                  </>
                )}
                {l.restore && (
                  <>
                    {' '}
                    {/* A source goes to /sources/<id>/...; its kind here only picks the route and the wording. */}
                    <RestoreAction kind={l.restore.kind === 'source' ? (l.kind as 'note' | 'minutes' | 'summary') : l.restore.kind} id={l.restore.id} label={`the ${l.kind === 'minutes' ? 'minutes' : l.kind} deleted on ${formatDay(l.at)}`} onDone={() => load()} />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
