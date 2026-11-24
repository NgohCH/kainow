import { useEffect, useState } from 'react';
import { ApiError } from '../api.ts';
import { type EscalatedRow, escalatedLine, listEscalated } from '../feedback.ts';
import { formatWhen } from '../format.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatTile } from '../ui/StatTile.tsx';

const field = (r: EscalatedRow, name: string): string => escalatedLine(r, formatWhen).fields.find(([k]) => k === name)?.[1] ?? '';

const COLUMNS: Column<EscalatedRow>[] = [
  { key: 'project', header: 'Project', sortValue: (r) => field(r, 'Project').toLowerCase(), cell: (r) => <strong>{field(r, 'Project')}</strong> },
  { key: 'category', header: 'Category', sortValue: (r) => field(r, 'Category'), cell: (r) => field(r, 'Category') },
  { key: 'model', header: 'Model', cell: (r) => field(r, 'Model') },
  { key: 'run', header: 'Run', cell: (r) => field(r, 'Run') },
  { key: 'at', header: 'Escalated', sortValue: (r) => r.at, cell: (r) => field(r, 'Escalated') },
  { key: 'note', header: 'Note from the Project Manager', cell: (r) => field(r, 'Note from the Project Manager') },
];

/** Administrator → Escalated feedback. Only project, category, model, run, time and the Project Manager's note; no discussion text. */
export function EscalatedFeedback() {
  const [rows, setRows] = useState<EscalatedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listEscalated().then((r) => setRows(r.feedback), (e) => setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.'));
  }, []);
  return (
    <main className="page">
      <PageHeader
        crumbs={[{ text: 'Settings', href: '#/settings' }]}
        title="Escalated feedback"
        intro="Feedback that Project Managers sent on to you. It shows no discussion text, correction or AI output."
      />
      {error && <p role="alert" className="error">{error}</p>}
      {rows && (
        <div className="stat-grid">
          <StatTile label="Escalated items" value={String(rows.length)} />
        </div>
      )}
      {(rows || !error) && (
        <DataTable caption="Feedback sent on to administrators" columns={COLUMNS} rows={rows ?? []} rowKey={(r) => r.id} loading={!rows && !error} empty="Nothing has been escalated." initialSort={{ key: 'at', dir: 'desc' }} />
      )}
    </main>
  );
}
