import { useEffect, useState } from 'react';
import { ApiError } from '../api.ts';
import { type EscalatedRow, escalatedLine, listEscalated } from '../feedback.ts';
import { formatWhen } from '../format.ts';

/** Administrator → Escalated feedback. Only project, category, model, run, time and the Project Manager's note; no discussion text. */
export function EscalatedFeedback() {
  const [rows, setRows] = useState<EscalatedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listEscalated().then((r) => setRows(r.feedback), (e) => setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.'));
  }, []);
  return (
    <main className="page narrow">
      <h1>Escalated feedback</h1>
      <p className="meta">Feedback that Project Managers sent on to you. It shows no discussion text, correction or AI output.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {!rows && !error && <p className="loading">Loading</p>}
      {rows && rows.length === 0 && <p className="empty">Nothing has been escalated.</p>}
      {rows && rows.length > 0 && (
        <ul className="plain stack">
          {rows.map((r) => {
            const l = escalatedLine(r, formatWhen);
            return (
              <li key={l.id} className="panel">
                <dl className="facts">
                  {l.fields.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
