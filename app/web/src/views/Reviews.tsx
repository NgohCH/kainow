import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { DEFAULT_PREFS } from '../prefs.ts';
import { type NeedsYouItem, type PersonalDashboard, homeQuery } from '../dashboard.ts';
import { formatWhen } from '../format.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { reviewItems } from '../ui/home.ts';

const columns: Column<NeedsYouItem>[] = [
  { key: 'project', header: 'Project', sortValue: (i) => i.projectName.toLowerCase(), cell: (i) => i.projectName },
  { key: 'what', header: 'What', sortValue: (i) => i.label.toLowerCase(), cell: (i) => `${i.label}${i.count && i.count > 1 ? ` (${i.count})` : ''}` },
  { key: 'since', header: 'Since', sortValue: (i) => i.since ?? '', cell: (i) => (i.since ? formatWhen(i.since) : '–') },
  { key: 'link', header: 'Open', cell: (i) => <a href={i.link} aria-label={`Open: ${i.label}, ${i.projectName}`}>Open</a> },
];

/** Everything waiting for the person's review or decision, across projects (spec 7.3). */
export function Reviews() {
  const [items, setItems] = useState<NeedsYouItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    api.get<PersonalDashboard>(`/dashboard/me?${homeQuery(DEFAULT_PREFS.home, false)}`).then(
      (r) => !stale && setItems(reviewItems(r.needsYou)),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, []);

  return (
    <main className="page">
      <PageHeader title="Reviews" intro="Proposals, minutes, questions and deadline reviews waiting for you." />
      {error && <p role="alert" className="error">{error}</p>}
      <DataTable caption="Waiting for your review or decision" columns={columns} rows={items ?? []} rowKey={(i) => `${i.kind}-${i.link}`} loading={!items && !error} empty="Nothing is waiting for your review." />
    </main>
  );
}
