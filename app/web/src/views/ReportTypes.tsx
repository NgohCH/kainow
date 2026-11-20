import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { plural } from '../format.ts';
import { REPORT_TYPE_STATUS, nameProblem, reasonProblem } from '../storage.ts';
import { Notice, ReasonAction, errText } from './storageUi.tsx';

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
  if (!open) return <button type="button" onClick={() => setOpen(true)} aria-label={`Rename ${t.name}`}>Rename</button>;

  async function submit(e: FormEvent) {
    e.preventDefault();
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
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
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

/** System Settings, Report types (spec 4.4, Enterprise Administrator only): add, rename and retire, each with a reason. */
export function ReportTypes() {
  const [types, setTypes] = useState<ReportType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<{ reportTypes: ReportType[] }>('/admin/report-types').then((r) => setTypes(r.reportTypes), (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const p = nameProblem(name) ?? reasonProblem(reason);
    if (p) return setError(p);
    setBusy(true);
    try {
      await api.post('/admin/report-types', { name: name.trim(), reason: reason.trim() });
      setNotice(`${name.trim()} added.`);
      setName('');
      setReason('');
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const done = (message: string) => {
    setNotice(message);
    setError(null);
    load();
  };
  const active = (types ?? []).filter((t) => t.status === 'active');
  const retired = (types ?? []).filter((t) => t.status === 'retired');

  return (
    <main className="page narrow">
      <h1>Report types</h1>
      <p className="meta">The kinds of report people choose when they file an output. The type name is also the folder name at filing time. Retiring a type keeps its history and stops it being chosen for new outputs.</p>
      <Notice error={error} notice={notice} />
      {!types && !error && <p className="loading">Loading</p>}
      {types && (
        <>
          <section aria-labelledby="rt-active">
            <h2 id="rt-active">In use ({plural(active.length, 'type')})</h2>
            {active.length === 0 ? (
              <p className="meta">No report types are in use. Add one so people can file outputs.</p>
            ) : (
              <ul className="plain">
                {active.map((t) => (
                  <li key={t.id} className="panel stack">
                    <strong>{t.name}</strong>
                    <span className="meta">{REPORT_TYPE_STATUS.active}</span>
                    <div className="inline-form">
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
                  </li>
                ))}
              </ul>
            )}
          </section>

          <form className="panel stack" onSubmit={add} aria-label="Add a report type">
            <h2>Add a report type</h2>
            <label>
              Name
              <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Reason
              <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button className="primary" disabled={busy}>Add</button>
          </form>

          <section aria-labelledby="rt-retired">
            <h2 id="rt-retired">Retired</h2>
            {retired.length === 0 ? (
              <p className="meta">No report types are retired.</p>
            ) : (
              <ul className="plain">
                {retired.map((t) => (
                  <li key={t.id}>
                    {t.name} <span className="meta">· {REPORT_TYPE_STATUS.retired}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
