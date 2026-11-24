import { Fragment, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { definitionParts } from '../analytics.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';

interface Definitions {
  version: string;
  measures: Array<{ key: string; label: string; definition: string }>;
  events: Array<{ name: string; table: string; version: string; area: string; meaning: string; actor: string; subject: string; measurements: string[] }>;
}

/** Definition text with its backtick-quoted spans as code. Split, never parsed as HTML. */
function Text({ text }: { text: string }) {
  return <>{definitionParts(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}</>;
}

type EventRow = Definitions['events'][number];

const EVENT_COLUMNS: Column<EventRow>[] = [
  { key: 'name', header: 'Event', sortValue: (e) => e.name, cell: (e) => <code>{e.name}</code> },
  { key: 'area', header: 'Area', sortValue: (e) => e.area.toLowerCase(), cell: (e) => e.area },
  { key: 'meaning', header: 'Meaning', wide: true, cell: (e) => <Text text={e.meaning} /> },
  { key: 'actor', header: 'Who acts', sortValue: (e) => e.actor.toLowerCase(), cell: (e) => e.actor },
  { key: 'subject', header: 'About', cell: (e) => e.subject },
  { key: 'table', header: 'Recorded in', sortValue: (e) => e.table, cell: (e) => <code>{e.table}</code> },
  { key: 'measures', header: 'Measures', cell: (e) => (e.measurements.length > 0 ? e.measurements.join(', ') : 'None') },
  { key: 'version', header: 'Version', sortValue: (e) => e.version, cell: (e) => e.version },
];

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
      <PageHeader crumbs={[{ text: 'Analytics', href: '#/admin/analytics' }]} title="Definitions" intro="Every measure with its definition and version, and the catalogue of recorded events." />
      {error && <p role="alert" className="error">{error}</p>}
      {!data && !error && <p className="loading">Loading</p>}
      {data && (
        <>
          <section aria-labelledby="measures-heading" className="box">
            <h2 id="measures-heading" className="box-title">Measures</h2>
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
          <section aria-labelledby="events-heading" className="box definitions-events">
            <h2 id="events-heading" className="box-title">Event catalogue</h2>
            <p className="meta">Every action Kainow records, where it is recorded, and the measures read from it.</p>
            <DataTable caption="Event catalogue" columns={EVENT_COLUMNS} rows={data.events} rowKey={(e) => `${e.table}:${e.name}`} empty="No events are catalogued." />
          </section>
        </>
      )}
    </main>
  );
}
