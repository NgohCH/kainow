import { Fragment, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { definitionParts } from '../analytics.ts';

interface Definitions {
  version: string;
  measures: Array<{ key: string; label: string; definition: string }>;
  events: Array<{ name: string; table: string; version: string; area: string; meaning: string; actor: string; subject: string; measurements: string[] }>;
}

/** Definition text with its backtick-quoted spans as code. Split, never parsed as HTML. */
function Text({ text }: { text: string }) {
  return <>{definitionParts(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}</>;
}

/** Administration → Analytics → Definitions (dashboards spec 7.5): every measure with its definition and version, and the event catalogue. */
export function Definitions() {
  const [data, setData] = useState<Definitions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    api.get<Definitions>('/admin/analytics/definitions').then(
      (r) => !stale && setData(r),
      (e) => !stale && setError(e instanceof ApiError ? e.message : 'That did not work. Try again.'),
    );
    return () => {
      stale = true;
    };
  }, []);

  return (
    <main className="page">
      <p><a href="#/admin/analytics">Back to Analytics</a></p>
      <h1>Definitions</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {!data && !error && <p className="loading">Loading</p>}
      {data && (
        <>
          <section aria-labelledby="measures-heading">
            <h2 id="measures-heading">Measures</h2>
            <p className="meta">Measure definitions version {data.version}.</p>
            <dl className="definitions">
              {data.measures.map((m) => (
                <Fragment key={m.key}>
                  <dt>{m.label}</dt>
                  <dd><Text text={m.definition} /></dd>
                </Fragment>
              ))}
            </dl>
          </section>
          <section aria-labelledby="events-heading">
            <h2 id="events-heading">Event catalogue</h2>
            <p className="meta">Every action Kainow records, where it is recorded, and the measures read from it.</p>
            <div className="table-scroll">
              <table className="table usage-table">
                <caption className="visually-hidden">Event catalogue</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Area</th>
                    <th scope="col">Meaning</th>
                    <th scope="col">Who acts</th>
                    <th scope="col">About</th>
                    <th scope="col">Recorded in</th>
                    <th scope="col">Measures</th>
                    <th scope="col">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={`${e.table}:${e.name}`}>
                      <th scope="row"><code>{e.name}</code></th>
                      <td data-label="Area">{e.area}</td>
                      <td data-label="Meaning"><Text text={e.meaning} /></td>
                      <td data-label="Who acts">{e.actor}</td>
                      <td data-label="About">{e.subject}</td>
                      <td data-label="Recorded in"><code>{e.table}</code></td>
                      <td data-label="Measures">{e.measurements.length > 0 ? e.measurements.join(', ') : 'None'}</td>
                      <td data-label="Version">{e.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
