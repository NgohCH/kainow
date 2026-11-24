import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { plural } from '../format.ts';
import { nameProblem, reasonProblem } from '../storage.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SettingsPage } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { Notice, ReasonAction, errText, useReturnFocus } from './storageUi.tsx';

interface ReportType {
  id: string;
  name: string;
  status: 'active' | 'retired';
  position: number;
}

function RenameForm({ t, onDone }: { t: ReportType; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(t.name);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { trigger, field } = useReturnFocus<HTMLButtonElement, HTMLInputElement>(open);
  if (!open) return <button type="button" ref={trigger} onClick={() => setOpen(true)} aria-label={`Rename ${t.name}`}>Rename</button>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === t.name) return setError('That is already the name. Change it, or cancel.');
    const p = nameProblem(name) ?? reasonProblem(reason);
    if (p) return setError(p);
    setBusy(true);
    setError(null);
    try {
      await api.put(`/admin/report-types/${t.id}`, { name: name.trim(), reason: reason.trim() });
      setOpen(false);
      setReason('');
      onDone(`Renamed to ${name.trim()}.`);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} aria-label={`Rename ${t.name}`}>
      <label>
        New name
        <input ref={field} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <span className="hint">Files already filed stay where they are. Only new filings use the new name as their folder.</span>
      </label>
      <label>
        Reason for the change
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="inline-form">
        <button className="primary" disabled={busy}>Save name</button>
        <button type="button" className="quiet" onClick={() => { setOpen(false); setName(t.name); setError(null); }}>Cancel</button>
      </div>
    </form>
  );
}

/** Settings › Report types (spec 4.4, Enterprise Administrator only): add, rename and retire, each with a reason. */
export function ReportTypes() {
  const [types, setTypes] = useState<ReportType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<{ reportTypes: ReportType[] }>('/admin/report-types').then((r) => setTypes(r.reportTypes), (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  const done = (message: string) => {
    setNotice(message);
    setError(null);
    load();
  };
  const active = (types ?? []).filter((t) => t.status === 'active');
  const retired = (types ?? []).filter((t) => t.status === 'retired');

  const columns: Column<ReportType>[] = [
    { key: 'name', header: 'Name', sortValue: (t) => t.name.toLowerCase(), cell: (t) => <strong>{t.name}</strong> },
    {
      key: 'status',
      header: 'State',
      sortValue: (t) => t.status,
      cell: (t) => <StatusLabel meaning={t.status === 'active' ? 'active' : 'off'} word={t.status === 'active' ? 'In use' : 'Retired'} />,
    },
    {
      key: 'action',
      header: 'Action',
      cell: (t) =>
        t.status === 'active' ? (
          <div className="stack">
            <RenameForm t={t} onDone={done} />
            <ReasonAction
              label={`Retire ${t.name}`}
              prompt="Reason for retiring it"
              onSend={async (r) => {
                await api.put(`/admin/report-types/${t.id}`, { status: 'retired', reason: r });
                done(`${t.name} is retired.`);
              }}
            >
              <p className="hint">Outputs already filed under it keep it. It can no longer be chosen for new outputs.</p>
            </ReasonAction>
          </div>
        ) : (
          <span className="meta">None</span>
        ),
    },
  ];

  const glance = (
    <>
      <Notice error={error} notice={notice} />
      <div className="stat-grid">
        <StatTile label="In use" value={types ? plural(active.length, 'type') : 'Loading'} />
        <StatTile label="Retired" value={types ? plural(retired.length, 'type') : 'Loading'} />
      </div>
      {types && active.length === 0 && <p className="meta">No report types are in use. Add one so people can file outputs.</p>}
      <DataTable caption="Report types" columns={columns} rows={types ?? []} rowKey={(t) => t.id} loading={!types && !error} empty="No report types yet." initialSort={{ key: 'status', dir: 'asc' }} />
    </>
  );
  return (
    <main className="page">
      <SettingsPage
        header={{
          crumbs: [{ text: 'Settings', href: '#/settings' }],
          title: 'Report types',
          intro: 'The kinds of report people choose when they file an output. The type name is also the folder name at filing time. Retiring a type keeps its history and stops it being chosen for new outputs.',
        }}
        glance={glance}
        settings={[
          {
            key: 'add',
            title: 'Add a report type',
            current: <p className="meta">A new type can be chosen for new outputs straight away.</p>,
            form: (close) => <AddForm onAdded={(n) => { done(`${n} added.`); close(); }} />,
          },
        ]}
      />
    </main>
  );
}

function AddForm({ onAdded }: { onAdded: (name: string) => void }) {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const p = nameProblem(name) ?? reasonProblem(reason);
    if (p) return setError(p);
    setBusy(true);
    try {
      await api.post('/admin/report-types', { name: name.trim(), reason: reason.trim() });
      onAdded(name.trim());
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={add} aria-label="Add a report type">
      <label>
        Name
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Reason
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy}>Add</button>
    </form>
  );
}
