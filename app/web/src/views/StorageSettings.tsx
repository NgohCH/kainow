import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { plural } from '../format.ts';
import {
  type DestinationForm, type DestinationPurpose, type MoveProgress, type SharingRepairRow,
  KIND_LABELS, PURPOSE_LABELS, STATUS_LABELS,
  checkLineLabel, destinationBody, destinationProblem, emptyDestinationForm, filesLabel, lastCheckedLabel, moveConfirmProblem,
  moveProgressText, offeredKinds, onOff, quotaLabel, reasonProblem, repairLine, siteGrantExample, stateTone, storageStateLabel,
} from '../storage.ts';
import { AdminsPanel, ConnectionPanel, FormatsPanel } from './StorageConnection.tsx';
import { type CheckResult, type Destination, Notice, ReasonAction, type SettingsView, type Summary, errText } from './storageUi.tsx';

function SummaryPanel({ s }: { s: Summary }) {
  return (
    <section className="panel stack" aria-labelledby="storage-summary">
      <h2 id="storage-summary">Storage at a glance</h2>
      {s.protectedKeyMissing && (
        <p className="warn" role="status">
          Waiting for the protected key. Until it is installed, storage credentials cannot be saved or used. {plural(s.queuedJobs, 'storage job')} {s.queuedJobs === 1 ? 'is' : 'are'} waiting. See INSTALL.md.
        </p>
      )}
      <dl className="facts">
        <dt>Connection</dt>
        <dd>
          <span className={`badge tone-${stateTone(s.connection)}`}>{storageStateLabel(s.connection)}</span> <span className="meta">{lastCheckedLabel(s.lastCheckedAt)}</span>
        </dd>
        <dt>Source area</dt>
        <dd>{filesLabel(s.sourceArea.files, s.sourceArea.bytes)}</dd>
        <dt>Space the provider reports</dt>
        <dd>{quotaLabel(s.sourceArea.quotaBytes)}</dd>
        <dt>Files waiting to be stored</dt>
        <dd>{s.waiting}</dd>
        <dt>Files that failed</dt>
        <dd>{s.failed}</dd>
        <dt>Files withheld</dt>
        <dd>{s.withheld}</dd>
        <dt>Sharing to repair</dt>
        <dd>{s.sharingToRepair.length === 0 ? 'None' : s.sharingToRepair.length}</dd>
        <dt>Storage Administrators</dt>
        <dd>{s.storageAdmins.length === 0 ? 'None designated' : s.storageAdmins.map((a) => a.name).join(', ')}</dd>
        <dt>Scheduled checks</dt>
        <dd>{onOff(s.scheduledChecks)}</dd>
      </dl>
      {s.sourceArea.warning && <p className="warn" role="status">{s.sourceArea.warning}</p>}
      {s.sourceAreaMove && <p role="status">{moveProgressText(s.sourceAreaMove)}</p>}
    </section>
  );
}

function RepairPanel({ rows }: { rows: SharingRepairRow[] }) {
  return (
    <section aria-labelledby="storage-repair">
      <h2 id="storage-repair">Sharing to repair</h2>
      {rows.length === 0 ? (
        <p className="meta">Nothing needs repair.</p>
      ) : (
        <ul className="plain">{rows.map((r, i) => <li key={i}>{repairLine(r)}</li>)}</ul>
      )}
    </section>
  );
}

function CheckLines({ check }: { check: CheckResult }) {
  return (
    <ul className="plain">
      {check.lines.map((l) => (
        <li key={l.key}>
          <strong>{checkLineLabel(l.key, l.ok)}</strong>
          {!l.ok && l.detail && <span className="meta"> · {l.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function GrantExample({ purpose, kind }: { purpose: DestinationPurpose; kind: Destination['kind'] }) {
  const ex = siteGrantExample(purpose, kind);
  return (
    <details>
      <summary>How the Microsoft administrator grants full control on this site</summary>
      <p>{ex.why}</p>
      <p className="meta">With PowerShell (replace the names in angle brackets):</p>
      <pre tabIndex={0}><code>{ex.powershell}</code></pre>
      <p className="meta">Or with a Microsoft Graph request:</p>
      <pre tabIndex={0}><code>{ex.graph}</code></pre>
    </details>
  );
}

function DestinationCard({ d, reload, setNotice }: { d: Destination; reload: () => void; setNotice: (s: string | null) => void }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const shown = result ?? d.lastCheck;
  const active = d.status === 'proposed' || d.status === 'approved' || d.status === 'retiring';

  async function check() {
    setChecking(true);
    setError(null);
    try {
      setResult(await api.post<CheckResult>(`/admin/storage/destinations/${d.id}/check`));
      reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setChecking(false);
    }
  }

  const where = d.kind === 'onedrive' ? d.accountEmail : d.siteUrl;
  return (
    <li className="panel stack">
      <h3>{d.label}</h3>
      <p>
        <span className="badge">{STATUS_LABELS[d.status]}</span> {PURPOSE_LABELS[d.purpose]} · {KIND_LABELS[d.kind]}
        {where ? ` · ${where}` : ''}{d.folderPath ? ` · folder ${d.folderPath}` : ''}
      </p>
      <p className="meta">
        {d.lastCheckedAt ? `${lastCheckedLabel(d.lastCheckedAt)}: ${shown?.ok ? 'passed' : 'did not pass'}` : 'Not checked yet'}
        {shown ? ` · Space the provider reports: ${quotaLabel(shown.quotaBytes)}` : ''}
      </p>
      {d.lastCheck?.sourceAreaWarning && <p className="warn" role="status">{d.lastCheck.sourceAreaWarning}</p>}
      {shown && <CheckLines check={shown} />}
      {error && <p role="alert" className="error">{error}</p>}
      {d.kind !== 'local' && active && <GrantExample purpose={d.purpose} kind={d.kind} />}
      {active && (
        <div className="stack">
          <div className="inline-form">
            <button type="button" onClick={check} disabled={checking} aria-label={`Check ${d.label}`}>{checking ? 'Checking' : 'Check this destination'}</button>
          </div>
          {d.status === 'proposed' && (
            <ReasonAction
              label={`Approve ${d.label}`}
              prompt="Reason for approving this destination"
              onSend={async (reason) => {
                await api.post(`/admin/storage/destinations/${d.id}/approve`, { reason });
                setNotice(`${d.label} is approved.`);
                reload();
              }}
            >
              <p className="hint">Approving runs the check again and needs it to pass.</p>
            </ReasonAction>
          )}
          {d.status !== 'retiring' && (
            <ReasonAction
              label={`Withdraw ${d.label}`}
              prompt="Reason for withdrawing this destination"
              onSend={async (reason) => {
                await api.post(`/admin/storage/destinations/${d.id}/withdraw`, { reason });
                setNotice(`${d.label} is withdrawn.`);
                reload();
              }}
            >
              <p className="hint">Nothing new is filed or stored there. Files already stored keep their references and checks. Projects using it are asked to choose a new output location.</p>
            </ReasonAction>
          )}
        </div>
      )}
    </li>
  );
}

function AddDestination({ lookup, reload, setNotice }: { lookup: boolean; reload: () => void; setNotice: (s: string | null) => void }) {
  const [f, setF] = useState<DestinationForm>(emptyDestinationForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<DestinationForm>) => setF((x) => ({ ...x, ...patch }));
  const kinds = offeredKinds(lookup);
  // If lookup goes off while OneDrive is chosen, fall back so the form never holds a kind it cannot send.
  const kind = kinds.some((k) => k.value === f.kind) ? f.kind : 'sharepoint_library';
  const form = { ...f, kind };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = destinationProblem(form, lookup);
    if (p) return setError(p);
    setBusy(true);
    setError(null);
    try {
      await api.post('/admin/storage/destinations', destinationBody(form));
      setNotice('Destination added and checked. Read each line of the result before approving it.');
      setF(emptyDestinationForm());
      reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={submit} aria-label="Add a destination">
      <h3>Add a destination</h3>
      <label>
        Kind
        <select value={kind} onChange={(e) => set({ kind: e.target.value as DestinationForm['kind'] })}>
          {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {!lookup && <span className="hint">OneDrive accounts can be added once directory lookup is on.</span>}
      </label>
      <label>
        Purpose
        <select value={f.purpose} onChange={(e) => set({ purpose: e.target.value as DestinationPurpose })}>
          <option value="outputs">Outputs (where projects file reports)</option>
          <option value="source_area">Source area (where source files are kept)</option>
        </select>
      </label>
      <label>
        Name
        <input required maxLength={100} value={f.label} onChange={(e) => set({ label: e.target.value })} />
      </label>
      {kind === 'sharepoint_library' ? (
        <>
          <label>
            Site address
            <input required type="url" inputMode="url" placeholder="https://<tenant>.sharepoint.com/sites/<site-name>" maxLength={500} value={f.siteUrl} onChange={(e) => set({ siteUrl: e.target.value })} />
          </label>
          <label>
            Library name
            <input required maxLength={200} placeholder="Documents" value={f.libraryName} onChange={(e) => set({ libraryName: e.target.value })} />
          </label>
        </>
      ) : (
        <label>
          Account email address
          <input required type="email" maxLength={254} value={f.accountEmail} onChange={(e) => set({ accountEmail: e.target.value })} />
        </label>
      )}
      <label>
        Folder (optional)
        <input maxLength={500} value={f.folderPath} onChange={(e) => set({ folderPath: e.target.value })} />
        <span className="hint">Kainow creates everything under this folder, or under the root of the library when left empty.</span>
      </label>
      <GrantExample purpose={f.purpose} kind={kind} />
      <label>
        Reason for adding it
        <textarea required rows={2} maxLength={1000} value={f.reason} onChange={(e) => set({ reason: e.target.value })} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy}>Add and check</button>
    </form>
  );
}

interface MoveInfo {
  current: { id: string; label: string; files: number; bytes: number } | null;
  move: MoveProgress | null;
}

function MovePanel({ destinations, reload, setNotice }: { destinations: Destination[]; reload: () => void; setNotice: (s: string | null) => void }) {
  const [info, setInfo] = useState<MoveInfo | null>(null);
  const [to, setTo] = useState('');
  const [files, setFiles] = useState('');
  const [bytes, setBytes] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.get<MoveInfo>('/admin/storage/source-area/move').then(setInfo, (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load, destinations]);

  if (!info) return error ? <p role="alert" className="error">{error}</p> : null;
  if (info.move) {
    return (
      <section aria-labelledby="storage-move">
        <h2 id="storage-move">Moving the source area</h2>
        <p role="status">{moveProgressText(info.move)}</p>
        <p className="meta">A file that cannot be moved stays at its old place, which stays in use for reading until the move completes.</p>
      </section>
    );
  }
  const cur = info.current;
  // The new source area is added and checked first; the move itself approves it and retires the old one.
  const options = destinations.filter((d) => d.purpose === 'source_area' && d.status === 'proposed');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cur) return;
    setError(null);
    if (!to) return setError('Choose the new source area.');
    const c = moveConfirmProblem(files, bytes, cur);
    if (c) return setError(c);
    const r = reasonProblem(reason);
    if (r) return setError(r);
    setBusy(true);
    try {
      await api.post('/admin/storage/source-area/move', { destinationId: to, reason: reason.trim(), confirm: { files: Number(files), bytes: Number(bytes) } });
      setFiles('');
      setBytes('');
      setReason('');
      setNotice('The move has started. Progress is shown here and at the top of the page.');
      load();
      reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="storage-move" className="stack">
      <h2 id="storage-move">Move the source area</h2>
      {!cur ? (
        <p className="meta">There is no approved source area to move yet.</p>
      ) : options.length === 0 ? (
        <p className="meta">To move the source area, add another source-area destination above first. It must pass its check. Moving approves it.</p>
      ) : (
        <form className="panel stack" onSubmit={submit} aria-label="Move the source area">
          <p>
            The source area is <strong>{cur.label}</strong> and holds <strong>{filesLabel(cur.files, cur.bytes)}</strong> ({cur.bytes.toLocaleString('en-US')} bytes). Every file is copied, checked at the new place and then removed from the old one.
          </p>
          <label>
            New source area
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose a destination</option>
              {options.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </label>
          <label>
            Type the number of files ({cur.files}) to confirm
            <input inputMode="numeric" value={files} onChange={(e) => setFiles(e.target.value)} />
          </label>
          <label>
            Type the size in bytes ({cur.bytes.toLocaleString('en-US')}) to confirm
            <input inputMode="numeric" value={bytes} onChange={(e) => setBytes(e.target.value)} />
          </label>
          <label>
            Reason for the move
            <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <button className="primary" disabled={busy}>Move the source area</button>
        </form>
      )}
    </section>
  );
}

/** System Settings, Storage (spec section 8, Enterprise Administrator only): the summary first, then the settings. */
export function StorageSettings() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.get<Summary>('/admin/storage/summary').then(setSummary, (e) => setError(errText(e)));
    api.get<SettingsView>('/admin/storage').then(setView, (e) => setError(errText(e)));
  }, []);
  useEffect(reload, [reload]);

  return (
    <main className="page">
      <h1>Storage</h1>
      <p className="meta">Where Kainow keeps source files and filed reports. Every change asks for a reason and is recorded.</p>
      <Notice error={error} notice={notice} />
      {!summary && !error && <p className="loading">Loading</p>}
      {summary && <SummaryPanel s={summary} />}
      {summary && <RepairPanel rows={summary.sharingToRepair} />}
      {view && summary && (
        <>
          <ConnectionPanel view={view} reload={reload} />
          <section aria-labelledby="storage-destinations" className="stack">
            <h2 id="storage-destinations">Destinations</h2>
            {summary.destinations.length === 0 ? (
              <p className="meta">No destinations yet. Add the source area and at least one outputs destination.</p>
            ) : (
              <ul className="plain">{summary.destinations.map((d) => <DestinationCard key={d.id} d={d} reload={reload} setNotice={setNotice} />)}</ul>
            )}
            <AddDestination lookup={view.settings.directoryLookup} reload={reload} setNotice={setNotice} />
          </section>
          <MovePanel destinations={summary.destinations} reload={reload} setNotice={setNotice} />
          <AdminsPanel reload={reload} setNotice={setNotice} />
          <FormatsPanel view={view} reload={reload} />
          <section aria-labelledby="storage-manifest">
            <h2 id="storage-manifest">Storage manifest</h2>
            <p className="meta">A CSV listing every stored file and where it is, for moving to another provider. Restricted items appear as "Restricted item". No content is included. Each download is recorded.</p>
            <a className="button" href={api.url('/admin/storage/manifest')} download>Download storage manifest</a>
          </section>
        </>
      )}
    </main>
  );
}
