import { type FormEvent, useState } from 'react';
import { ApiError, type Membership } from '../api.ts';
import { accessChangedLabel, type AudienceView, changeAudience, type Person, previewAudience, readersOf, restrictedLabel } from '../discussion.ts';

const RESTRICTED_ROLE = new Set(['pm', 'deputy_pm', 'owner', 'sponsor']);

/** People who can be named on a Restricted audience: current participants whose role does not already give access, plus anyone already named. */
export function namablePeople(memberships: Membership[], named: Person[]): Person[] {
  const out = new Map<string, Person>();
  for (const m of memberships) if (m.state === 'active' && !RESTRICTED_ROLE.has(m.role)) out.set(m.userId, { id: m.userId, displayName: m.displayName });
  for (const p of named) out.set(p.id, p);
  return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
}

/** Choose Project-wide or Restricted and name people; shared by the meeting, the note and the start-meeting form. */
export function AudienceChoice({
  mode,
  named,
  candidates,
  onMode,
  onNamed,
  canRestrict,
  legend,
}: {
  mode: 'project' | 'restricted';
  named: string[];
  candidates: Person[];
  onMode: (m: 'project' | 'restricted') => void;
  onNamed: (ids: string[]) => void;
  canRestrict: boolean;
  legend: string;
}) {
  return (
    <fieldset className="stack">
      <legend>{legend}</legend>
      <label className="check">
        <input type="radio" name={`aud-${legend}`} checked={mode === 'project'} onChange={() => onMode('project')} /> Project-wide: everyone in the project
      </label>
      {canRestrict && (
        <label className="check">
          <input type="radio" name={`aud-${legend}`} checked={mode === 'restricted'} onChange={() => onMode('restricted')} /> Restricted: the Project Manager, Deputies, Owner and Sponsors, and the people you name
        </label>
      )}
      {mode === 'restricted' && (
        <fieldset>
          <legend>People who can also read</legend>
          {candidates.length === 0 && <p className="meta">No other participants to name.</p>}
          {candidates.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={named.includes(p.id)} onChange={(e) => onNamed(e.target.checked ? [...named, p.id] : named.filter((x) => x !== p.id))} /> {p.displayName}
            </label>
          ))}
        </fieldset>
      )}
    </fieldset>
  );
}

/** Who may read a meeting, its minutes or a note, and (for a Project Manager, Owner or Sponsor) how to change it. */
export function AudiencePanel({
  audience,
  memberships,
  canChange,
  onChanged,
}: {
  audience: AudienceView;
  memberships: Membership[];
  canChange: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(audience.mode);
  const [named, setNamed] = useState<string[]>(audience.namedUsers.map((p) => p.id));
  const [preview, setPreview] = useState<{ gain: Person[]; lose: Person[] } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = restrictedLabel(audience.mode);
  const changed = accessChangedLabel(audience.changedAt);
  const readers = readersOf(memberships, audience.mode, audience.namedUsers.map((p) => p.id), audience.namedUsers);

  const change = { mode, namedUserIds: mode === 'project' ? [] : named };
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

  async function showPreview(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewAudience(audience.id, change));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await changeAudience(audience.id, change, reason);
      setOpen(false);
      setPreview(null);
      setReason('');
      onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel audience-panel" aria-label="Audience">
      <h2>Who can read this</h2>
      <p>
        <strong>{audience.mode === 'project' ? 'Project-wide' : 'Restricted'}</strong>
        {label && <span className="badge badge-pending">{label}</span>}
        {changed && <span className="badge">{changed}</span>}
      </p>
      <p className="meta">{audience.mode === 'project' ? 'Everyone in the project.' : readers.map((p) => p.displayName).join(', ') || 'No one named.'}</p>
      {canChange && !open && (
        <button type="button" onClick={() => { setOpen(true); setMode(audience.mode); setNamed(audience.namedUsers.map((p) => p.id)); setPreview(null); }}>Change who can read</button>
      )}
      {canChange && open && (
        <form className="stack" onSubmit={preview ? confirm : showPreview}>
          <AudienceChoice
            legend="New audience"
            mode={mode}
            named={named}
            candidates={namablePeople(memberships, audience.namedUsers)}
            onMode={(m) => { setMode(m); setPreview(null); }}
            onNamed={(ids) => { setNamed(ids); setPreview(null); }}
            canRestrict
          />
          {preview && (
            <div role="status">
              <p>Gain access: {preview.gain.map((p) => p.displayName).join(', ') || 'no one'}.</p>
              <p>Lose access: {preview.lose.map((p) => p.displayName).join(', ') || 'no one'}.</p>
              <p className="hint">Changing the audience does not take back anything people have already read, downloaded or received.</p>
              <label>
                Reason (required)
                <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
              </label>
            </div>
          )}
          {error && <p role="alert" className="error">{error}</p>}
          <span className="actions">
            <button className="primary" disabled={busy || (preview !== null && reason.trim() === '')}>{preview ? 'Confirm change' : 'See who gains and loses access'}</button>
            <button type="button" onClick={() => { setOpen(false); setPreview(null); setError(null); }}>Cancel</button>
          </span>
        </form>
      )}
    </section>
  );
}
