import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { plural } from '../format.ts';
import {
  type DestinationForm, type DestinationPurpose, type MoveProgress, type SharingRepairRow,
  KIND_LABELS, PURPOSE_LABELS, SECRET_STATE_LABEL, STATUS_LABELS,
  checkLineLabel, destinationBody, destinationProblem, emptyDestinationForm, filesLabel, lastCheckedLabel, moveConfirmProblem,
  moveProgressText, offeredKinds, onOff, quotaLabel, reasonProblem, repairLine, siteGrantExample, stateTone, storageStateLabel,
} from '../storage.ts';
import { Box } from '../ui/Box.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SettingsPage, type SettingsPageItem } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Meaning } from '../ui/meanings.ts';
import { AdminsCurrent, AdminsForm, CheckConnection, ConnectionForm, FormatsCurrent, FormatsForm, SecretForm, useStorageAdmins } from './StorageConnection.tsx';
import { type CheckResult, type Destination, Notice, ReasonAction, type SettingsView, type Summary, errText } from './storageUi.tsx';

const CONNECTION_MEANING: Record<'ok' | 'quiet' | 'warn', Meaning> = { ok: 'ok', quiet: 'off', warn: 'attention' };
const DESTINATION_MEANING: Record<Destination['status'], Meaning> = { proposed: 'planned', approved: 'ok', retiring: 'attention', withdrawn: 'off' };

function Glance({ s, reload, setNotice, setError }: { s: Summary; reload: () => void; setNotice: (s: string | null) => void; setError: (s: string | null) => void }) {
  const columns: Column<Destination>[] = [
    { key: 'name', header: 'Destination', sortValue: (d) => d.label.toLowerCase(), cell: (d) => <><strong>{d.label}</strong><span className="row-note"> {KIND_LABELS[d.kind]}{(d.kind === 'onedrive' ? d.accountEmail : d.siteUrl) ? ` · ${d.kind === 'onedrive' ? d.accountEmail : d.siteUrl}` : ''}{d.folderPath ? ` · folder ${d.folderPath}` : ''}</span></> },
    { key: 'purpose', header: 'Purpose', sortValue: (d) => d.purpose, cell: (d) => PURPOSE_LABELS[d.purpose] },
    { key: 'status', header: 'Status', sortValue: (d) => d.status, cell: (d) => <StatusLabel meaning={DESTINATION_MEANING[d.status]} word={STATUS_LABELS[d.status]} /> },
    {
      key: 'check',
      header: 'Last check',
      sortValue: (d) => d.lastCheckedAt ?? '',
      cell: (d) =>
        d.lastCheckedAt && d.lastCheck ? (
          <>
            <StatusLabel meaning={d.lastCheck.ok ? 'ok' : 'failing'} word={d.lastCheck.ok ? 'Passed' : 'Did not pass'} />
            <span className="row-note"> {lastCheckedLabel(d.lastCheckedAt)}</span>
          </>
        ) : (
          <StatusLabel meaning="off" word="Not checked yet" />
        ),
    },
    { key: 'space', header: 'Space the provider reports', cell: (d) => (d.lastCheck ? quotaLabel(d.lastCheck.quotaBytes) : '—') },
  ];
  const tone = CONNECTION_MEANING[stateTone(s.connection)];
  return (
    <>
      {s.protectedKeyMissing && (
        <p className="warn" role="status">
          Waiting for the protected key. Until it is installed, storage credentials cannot be saved or used. {plural(s.queuedJobs, 'storage job')} {s.queuedJobs === 1 ? 'is' : 'are'} waiting. See INSTALL.md.
        </p>
      )}
      <div className="stat-grid">
        <StatTile label="Connection" value={storageStateLabel(s.connection)} meaning={tone} word={tone === 'ok' ? 'Working' : tone === 'off' ? 'Not in use' : 'Needs attention'} note={lastCheckedLabel(s.lastCheckedAt)} />
        <StatTile label="Source area" value={filesLabel(s.sourceArea.files, s.sourceArea.bytes)} note={`Space the provider reports: ${quotaLabel(s.sourceArea.quotaBytes)}`} />
        <StatTile label="Files waiting to be stored" value={String(s.waiting)} />
        <StatTile label="Files that failed" value={String(s.failed)} meaning={s.failed > 0 ? 'failing' : 'ok'} word={s.failed > 0 ? 'Failing' : 'None failed'} />
        <StatTile label="Files withheld" value={String(s.withheld)} meaning={s.withheld > 0 ? 'attention' : undefined} />
        <StatTile label="Sharing to repair" value={String(s.sharingToRepair.length)} meaning={s.sharingToRepair.length > 0 ? 'attention' : 'ok'} word={s.sharingToRepair.length > 0 ? 'Needs attention' : 'Nothing to repair'} />
      </div>
      {s.sourceArea.warning && <p className="warn" role="status">{s.sourceArea.warning}</p>}
      {s.sourceAreaMove && <p role="status">{moveProgressText(s.sourceAreaMove)}</p>}
      <CheckConnection reload={reload} setNotice={setNotice} setError={setError} />
      <DataTable caption="Destinations and their checks" columns={columns} rows={s.destinations} rowKey={(d) => d.id} empty="No destinations yet. Add the source area and at least one outputs destination." />
      {s.sharingToRepair.length > 0 && (
        <Box title="Sharing to repair" headingLevel={3} meaning="attention">
          <ul className="plain">{s.sharingToRepair.map((r: SharingRepairRow, i) => <li key={i}>{repairLine(r)}</li>)}</ul>
        </Box>
      )}
      <Box title="Storage manifest" headingLevel={3}>
        <p className="meta">A CSV listing every stored file and where it is, for moving to another provider. Restricted items appear as "Restricted item". No content is included. Each download is recorded.</p>
        <a className="button" href={api.url('/admin/storage/manifest')} download>Download storage manifest</a>
      </Box>
    </>
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
      <h4>{d.label}</h4>
      <p>
        <StatusLabel meaning={DESTINATION_MEANING[d.status]} word={STATUS_LABELS[d.status]} /> {PURPOSE_LABELS[d.purpose]} · {KIND_LABELS[d.kind]}
        {where ? ` · ${where}` : ''}{d.folderPath ? ` · folder ${d.folderPath}` : ''}
      </p>
      <p className="meta">
        {d.lastCheckedAt ? `${lastCheckedLabel(d.lastCheckedAt)}: ${shown?.ok ? 'passed' : 'did not pass'}` : 'Not checked yet'}
        {shown ? ` · Space the provider reports: ${quotaLabel(shown.quotaBytes)}` : ''}
      </p>
      {d.lastCheck?.sourceAreaWarning && <p className="warn" role="status">{d.lastCheck.sourceAreaWarning}</p>}
      {d.lastCheck?.libraryWarning && d.purpose === 'outputs' && d.status !== 'withdrawn' && <p className="warn" role="status">{d.lastCheck.libraryWarning}</p>}
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

function AddDestination({ lookup, reload, setNotice, close }: { lookup: boolean; reload: () => void; setNotice: (s: string | null) => void; close: () => void }) {
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
      reload();
      close();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Add a destination">
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
      <div className="actions">
        <button className="primary" disabled={busy}>Add and check</button>
        <button type="button" className="quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

interface MoveInfo {
  current: { id: string; label: string; files: number; bytes: number } | null;
  move: MoveProgress | null;
}

/** The form that moves the source area; while a move runs it shows the progress instead. */
function MoveForm({ destinations, reload, setNotice, close }: { destinations: Destination[]; reload: () => void; setNotice: (s: string | null) => void; close: () => void }) {
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

  if (!info) return error ? <p role="alert" className="error">{error}</p> : <p className="loading" role="status">Loading</p>;
  if (info.move) {
    return (
      <div className="stack">
        <p role="status">{moveProgressText(info.move)}</p>
        <p className="meta">A file that cannot be moved stays at its old place, which stays in use for reading until the move completes.</p>
      </div>
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
      setNotice('The move has started. Progress is shown at the top of the page and in this box.');
      load();
      reload();
      close();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!cur) return <p className="meta">There is no approved source area to move yet.</p>;
  if (options.length === 0) return <p className="meta">To move the source area, add another source-area destination first (in the Destinations box). It must pass its check. Moving approves it.</p>;
  return (
    <form className="stack" onSubmit={submit} aria-label="Move the source area">
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
      <div className="actions">
        <button className="primary" disabled={busy}>Move the source area</button>
        <button type="button" className="quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

/** Settings → Storage (spec section 8, Enterprise Administrator only): the state of storage first, then each setting in its own box. */
export function StorageSettings() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const admins = useStorageAdmins();

  const reload = useCallback(() => {
    api.get<Summary>('/admin/storage/summary').then(setSummary, (e) => setError(errText(e)));
    api.get<SettingsView>('/admin/storage').then(setView, (e) => setError(errText(e)));
  }, []);
  useEffect(reload, [reload]);

  const items: SettingsPageItem[] =
    summary && view
      ? [
          {
            key: 'connection',
            title: 'Connection to Microsoft',
            current: (
              <dl className="facts">
                <div><dt>Tenant ID</dt><dd>{view.settings.tenantId ?? 'Not set'}</dd></div>
                <div><dt>Application (client) ID</dt><dd>{view.settings.clientId ?? 'Not set'}</dd></div>
                <div><dt>Directory lookup</dt><dd>{onOff(view.settings.directoryLookup)}</dd></div>
                <div><dt>Scheduled checks</dt><dd>{onOff(view.settings.scheduledChecks)}</dd></div>
              </dl>
            ),
            form: (close) => <ConnectionForm view={view} reload={reload} setNotice={setNotice} close={close} />,
          },
          {
            key: 'secret',
            title: 'Client secret',
            current: (
              <>
                <p role="status">{SECRET_STATE_LABEL[view.secret]}</p>
                {!view.protectedKeyLoaded && <p className="warn">Storage credentials cannot be saved until the protected key is installed. See INSTALL.md.</p>}
              </>
            ),
            form: (close) => <SecretForm view={view} reload={reload} setNotice={setNotice} close={close} />,
          },
          {
            key: 'destinations',
            title: 'Destinations',
            current:
              summary.destinations.length === 0 ? (
                <p className="meta">No destinations yet. Add the source area and at least one outputs destination.</p>
              ) : (
                <ul className="plain">{summary.destinations.map((d) => <DestinationCard key={d.id} d={d} reload={reload} setNotice={setNotice} />)}</ul>
              ),
            form: (close) => <AddDestination lookup={view.settings.directoryLookup} reload={reload} setNotice={setNotice} close={close} />,
          },
          {
            key: 'move',
            title: 'Source area move',
            current: summary.sourceAreaMove ? (
              <p role="status">{moveProgressText(summary.sourceAreaMove)}</p>
            ) : (
              <p className="meta">Moves every source file to another source-area destination. Source area now: {filesLabel(summary.sourceArea.files, summary.sourceArea.bytes)}.</p>
            ),
            form: (close) => <MoveForm destinations={summary.destinations} reload={reload} setNotice={setNotice} close={close} />,
          },
          {
            key: 'admins',
            title: 'Storage Administrators',
            current: <AdminsCurrent a={admins} reload={reload} setNotice={setNotice} />,
            form: (close) => <AdminsForm a={admins} reload={reload} setNotice={setNotice} close={close} />,
          },
          {
            key: 'formats',
            title: 'Formats and what projects may choose',
            current: <FormatsCurrent view={view} />,
            form: (close) => <FormatsForm view={view} reload={reload} setNotice={setNotice} close={close} />,
          },
        ]
      : [];

  return (
    <main className="page">
      <SettingsPage
        header={{
          crumbs: [{ text: 'Settings', href: '#/settings' }],
          title: 'Storage',
          intro: 'Where Kainow keeps source files and filed reports. Every change asks for a reason and is recorded.',
        }}
        glance={
          <>
            <Notice error={error} notice={notice} />
            {!summary && !error && <p className="loading">Loading</p>}
            {summary && <Glance s={summary} reload={reload} setNotice={setNotice} setError={setError} />}
          </>
        }
        settings={items}
      />
    </main>
  );
}
