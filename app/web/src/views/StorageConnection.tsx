import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  type ConnectionState, FORMAT_LABELS, SECRET_STATE_LABEL, sameItems, onOff, permissionInstructions, reasonProblem, secretProblem, storageStateLabel,
} from '../storage.ts';
import { ReasonAction, type SettingsView, errText } from './storageUi.tsx';

function PermissionsPanel({ lookup }: { lookup: boolean }) {
  return (
    <section aria-labelledby="storage-permissions">
      <h3 id="storage-permissions">Permissions the Microsoft administrator grants to the application</h3>
      <ul className="plain">
        {permissionInstructions(lookup).map((p) => (
          <li key={p.name}>
            <code>{p.name}</code> (application permission, with admin consent) <span className="hint">{p.why}</span>
          </li>
        ))}
      </ul>
      {!lookup && <p className="hint">User.ReadBasic.All is needed only if you turn directory lookup on.</p>}
    </section>
  );
}

/** Tenant, application, directory lookup and scheduled checks, with the permissions the Microsoft administrator grants. */
export function ConnectionForm({ view, reload, setNotice, close }: { view: SettingsView; reload: () => void; setNotice: (s: string | null) => void; close: () => void }) {
  const s = view.settings;
  const [tenantId, setTenantId] = useState(s.tenantId ?? '');
  const [clientId, setClientId] = useState(s.clientId ?? '');
  const [lookup, setLookup] = useState(s.directoryLookup);
  const [confirmed, setConfirmed] = useState(false);
  const [scheduled, setScheduled] = useState(s.scheduledChecks);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lookupTurnedOn = lookup && !s.directoryLookup;
  const unchanged = tenantId.trim() === (s.tenantId ?? '') && clientId.trim() === (s.clientId ?? '') && lookup === s.directoryLookup && scheduled === s.scheduledChecks;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const p = reasonProblem(reason);
    if (p) return setError(p);
    if (lookupTurnedOn && !confirmed) return setError('Confirm that User.ReadBasic.All has been granted before turning directory lookup on.');
    setBusy(true);
    try {
      await api.put('/admin/storage', { tenantId: tenantId.trim() || null, clientId: clientId.trim() || null, directoryLookup: lookup, scheduledChecks: scheduled, reason: reason.trim() });
      setNotice('Saved.');
      reload();
      close();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PermissionsPanel lookup={s.directoryLookup} />
      <form className="stack" onSubmit={save} aria-label="Connection settings">
        <label>
          Tenant ID
          <input value={tenantId} maxLength={100} autoComplete="off" onChange={(e) => setTenantId(e.target.value)} />
        </label>
        <label>
          Application (client) ID
          <input value={clientId} maxLength={100} autoComplete="off" onChange={(e) => setClientId(e.target.value)} />
        </label>
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={lookup} onChange={(e) => { setLookup(e.target.checked); setConfirmed(false); }} />
            Directory lookup
          </label>
          <p className="hint">Currently {onOff(s.directoryLookup)}. Lets Kainow find people by email address and is needed for OneDrive destinations. It cannot be turned off while a OneDrive destination is approved.</p>
          {lookupTurnedOn && (
            <label className="check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              The permission User.ReadBasic.All has been granted to the application. Kainow will look up your own address to check it.
            </label>
          )}
        </div>
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
            Scheduled checks
          </label>
          <p className="hint">Currently {onOff(s.scheduledChecks)}. Kainow checks the connection, the destinations and who can open the source area every day.</p>
        </div>
        <label>
          Reason for the change
          <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          <button className="primary" disabled={busy || unchanged}>Save connection</button>
          <button type="button" className="quiet" onClick={close}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

/** The client secret is write-only: it is cleared from the page whether or not it was saved. */
export function SecretForm({ view, reload, setNotice, close }: { view: SettingsView; reload: () => void; setNotice: (s: string | null) => void; close: () => void }) {
  const [secret, setSecret] = useState('');
  const [secretReason, setSecretReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveSecret(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const sp = secretProblem(secret);
    if (sp) return setError(sp);
    const rp = reasonProblem(secretReason);
    if (rp) return setError(rp);
    setBusy(true);
    let saved = false;
    try {
      await api.post('/admin/storage/secret', { clientSecret: secret.trim(), reason: secretReason.trim() });
      saved = true;
    } catch (err) {
      setError(errText(err));
    } finally {
      // The secret never stays in the page, saved or not.
      setSecret('');
      setBusy(false);
    }
    if (saved) {
      setNotice('The client secret is saved. It is never shown again.');
      reload();
      close();
    }
  }

  return (
    <form className="stack" onSubmit={saveSecret} aria-label="Client secret">
      {!view.protectedKeyLoaded && <p className="warn">Storage credentials cannot be saved until the protected key is installed. See INSTALL.md.</p>}
      <label>
        {view.secret === 'none' ? 'Client secret' : 'Replace the client secret'}
        <input type="password" autoComplete="new-password" spellCheck={false} maxLength={300} value={secret} onChange={(e) => setSecret(e.target.value)} aria-describedby="secret-hint" />
        <span id="secret-hint" className="hint">10 to 200 characters. It is stored sealed, never shown again, and cleared from this page when you save.</span>
      </label>
      <label>
        Reason for the change
        <textarea required rows={2} maxLength={1000} value={secretReason} onChange={(e) => setSecretReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy || secret === '' || !view.protectedKeyLoaded}>Save client secret</button>
        <button type="button" className="quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

/** Asks Microsoft for a token; no files are touched. */
export function CheckConnection({ reload, setNotice, setError }: { reload: () => void; setNotice: (s: string | null) => void; setError: (s: string | null) => void }) {
  const [checking, setChecking] = useState(false);
  async function check() {
    setError(null);
    setNotice(null);
    setChecking(true);
    try {
      const r = await api.post<{ state: ConnectionState }>('/admin/storage/check');
      setNotice(`Connection check: ${storageStateLabel(r.state)}.`);
      reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="inline-form">
      <button type="button" onClick={check} disabled={checking}>{checking ? 'Checking' : 'Check connection'}</button>
      <span className="hint">Asks Microsoft for a token. No files are touched.</span>
    </div>
  );
}

/** Approved formats and the switches that let projects choose for themselves. */
export function FormatsForm({ view, reload, setNotice, close }: { view: SettingsView; reload: () => void; setNotice: (s: string | null) => void; close: () => void }) {
  const s = view.settings;
  const [input, setInput] = useState<string[]>(s.approvedInputFormats);
  const [output, setOutput] = useState<string[]>(s.approvedOutputFormats);
  const [change, setChange] = useState(s.projectsMayChangeFormats);
  const [choose, setChoose] = useState(s.projectsMayChooseDestination);
  const [roles, setRoles] = useState(s.projectsMaySetExportRoles);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (list: string[], set: (v: string[]) => void, f: string) => set(list.includes(f) ? list.filter((x) => x !== f) : [...list, f]);
  const unchanged =
    sameItems(input, s.approvedInputFormats) && sameItems(output, s.approvedOutputFormats) && change === s.projectsMayChangeFormats &&
    choose === s.projectsMayChooseDestination && roles === s.projectsMaySetExportRoles;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (input.length === 0) return setError('Keep at least one approved input format.');
    const p = reasonProblem(reason);
    if (p) return setError(p);
    setBusy(true);
    try {
      await api.put('/admin/storage', {
        approvedInputFormats: input, approvedOutputFormats: output, projectsMayChangeFormats: change,
        projectsMayChooseDestination: choose, projectsMaySetExportRoles: roles, reason: reason.trim(),
      });
      setNotice('Saved.');
      reload();
      close();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const group = (legend: string, all: string[], list: string[], set: (v: string[]) => void) => (
    <fieldset>
      <legend>{legend}</legend>
      {all.map((f) => (
        <label key={f} className="check">
          <input type="checkbox" checked={list.includes(f)} onChange={() => toggle(list, set, f)} />
          {FORMAT_LABELS[f]}
        </label>
      ))}
    </fieldset>
  );

  return (
    <form className="stack" onSubmit={save} aria-label="Formats and project choices">
      {group('Approved input formats (files people add as sources)', ['txt', 'md', 'docx', 'pdf'], input, setInput)}
      {group('Approved output formats (files Kainow generates)', ['md', 'docx', 'pdf', 'csv'], output, setOutput)}
      <label className="check"><input type="checkbox" checked={change} onChange={(e) => setChange(e.target.checked)} />Projects may change formats</label>
      <label className="check"><input type="checkbox" checked={choose} onChange={(e) => setChoose(e.target.checked)} />Projects may choose their output destination</label>
      <label className="check"><input type="checkbox" checked={roles} onChange={(e) => setRoles(e.target.checked)} />Projects may set who can export</label>
      <p className="hint">When a switch is off, only an Administrator can change that setting for a project.</p>
      <label>
        Reason for the change
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy || unchanged}>Save formats</button>
        <button type="button" className="quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

/** What is saved about formats, for the box's current value. */
export function FormatsCurrent({ view }: { view: SettingsView }) {
  const s = view.settings;
  const names = (l: string[]) => (l.length === 0 ? 'None' : l.map((f) => FORMAT_LABELS[f] ?? f).join(', '));
  return (
    <dl className="facts">
      <div><dt>Input formats</dt><dd>{names(s.approvedInputFormats)}</dd></div>
      <div><dt>Output formats</dt><dd>{names(s.approvedOutputFormats)}</dd></div>
      <div><dt>Projects may change formats</dt><dd>{s.projectsMayChangeFormats ? 'Yes' : 'No'}</dd></div>
      <div><dt>Projects may choose their output destination</dt><dd>{s.projectsMayChooseDestination ? 'Yes' : 'No'}</dd></div>
      <div><dt>Projects may set who can export</dt><dd>{s.projectsMaySetExportRoles ? 'Yes' : 'No'}</dd></div>
    </dl>
  );
}

interface AdminRow {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  designatedAt: string;
  reason: string;
  access: string;
}
interface Person {
  id: string;
  displayName: string;
  email: string;
  status: string;
}

const ACCESS_WORDS: Record<string, string> = {
  none: 'Access not given yet',
  pending: 'Access is being given',
  granted: 'Has write access to the source area',
  not_found: 'Access could not be given: the account was not found',
  revoking: 'Access is being removed',
  failed: 'Access could not be given',
  external: 'Access was given outside Kainow',
};

/** Storage Administrators (spec 8.4): the list and the people who could be designated, shared by the box's value and its form. */
export function useStorageAdmins() {
  const [admins, setAdmins] = useState<AdminRow[] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<{ admins: AdminRow[]; warning: string | null }>('/admin/storage/admins').then(
      (r) => {
        setAdmins(r.admins);
        setWarning(r.warning);
      },
      (e) => setError(errText(e)),
    );
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api.get<{ users: Person[] }>('/users').then((r) => setPeople(r.users.filter((u) => u.status === 'active')), () => setPeople([]));
  }, []);
  return { admins, warning, people, error, load };
}
export type StorageAdmins = ReturnType<typeof useStorageAdmins>;

/** Each designation, with its own reason box to end it. */
export function AdminsCurrent({ a, reload, setNotice }: { a: StorageAdmins; reload: () => void; setNotice: (s: string | null) => void }) {
  return (
    <div className="stack">
      <p className="meta">A storage Administrator can open the source area directly in the provider (write access). Being an Enterprise Administrator gives no such access. You cannot designate yourself.</p>
      {a.error && <p role="alert" className="error">{a.error}</p>}
      {a.warning && <p className="warn" role="status">{a.warning}</p>}
      {a.admins === null && !a.error && <p className="loading">Loading</p>}
      {a.admins && a.admins.length === 0 && <p className="meta">No storage Administrators are designated.</p>}
      {a.admins && a.admins.length > 0 && (
        <ul className="plain">
          {a.admins.map((row) => (
            <li key={row.id} className="stack">
              <span>
                <strong>{row.displayName}</strong>
                <span className="meta"> · {row.email} · since {formatWhen(row.designatedAt)} · {ACCESS_WORDS[row.access] ?? 'Access state unknown'} · {row.reason}</span>
              </span>
              <ReasonAction
                label={`End designation for ${row.displayName}`}
                prompt="Reason for ending it"
                onSend={async (r) => {
                  await api.post(`/admin/storage/admins/${row.id}/end`, { reason: r });
                  setNotice(`${row.displayName} is no longer a storage Administrator.`);
                  a.load();
                  reload();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AdminsForm({ a, reload, setNotice, close }: { a: StorageAdmins; reload: () => void; setNotice: (s: string | null) => void; close: () => void }) {
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = new Set((a.admins ?? []).map((x) => x.userId));
  const candidates = a.people.filter((p) => !chosen.has(p.id));

  async function designate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!pick) return setError('Choose the person to make a storage Administrator.');
    const p = reasonProblem(reason);
    if (p) return setError(p);
    setBusy(true);
    try {
      await api.post('/admin/storage/admins', { userId: pick, reason: reason.trim() });
      setNotice('Storage Administrator designated.');
      a.load();
      reload();
      close();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={designate} aria-label="Designate a storage Administrator">
      <label>
        Person
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose a person</option>
          {candidates.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.email})</option>)}
        </select>
      </label>
      <label>
        Reason
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy}>Designate</button>
        <button type="button" className="quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}
