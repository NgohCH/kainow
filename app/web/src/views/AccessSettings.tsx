import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { dayLabel } from '../dashboard.ts';
import { formatWhen, plural } from '../format.ts';
import { ACCESS_ROWS, type AccessBounds, type AccessValues, reasonProblem, settingsProblem } from '../leadership.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { SettingsPage } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface Change {
  id: string;
  at: string;
  reason: string;
  actor: string;
  previous: AccessValues;
  next: AccessValues;
}
interface Loaded {
  settings: AccessValues;
  defaults: AccessValues;
  bounds: AccessBounds;
  changes: Change[];
}
interface PreviewRow {
  projectId: string;
  name: string;
  closedOn: string;
  archivedNow: boolean;
  archivedAfter: boolean;
}

const onOff = (b: boolean) => (b ? 'On' : 'Off');

function changedText(c: Change): string {
  const parts: string[] = ACCESS_ROWS.filter((r) => c.previous[r.key] !== c.next[r.key]).map(
    (r) => `${r.key === 'invitationValidDays' ? 'Project invitations' : r.label}: ${c.previous[r.key]} to ${c.next[r.key]} ${r.unit}`,
  );
  if (c.previous.analyticsExportAllowed !== c.next.analyticsExportAllowed) {
    parts.push(`Analytics export allowed: ${onOff(c.previous.analyticsExportAllowed)} to ${onOff(c.next.analyticsExportAllowed)}`);
  }
  if (c.previous.projectExportsAllowed !== c.next.projectExportsAllowed) {
    parts.push(`Project exports allowed: ${onOff(!!c.previous.projectExportsAllowed)} to ${onOff(!!c.next.projectExportsAllowed)}`);
  }
  return parts.join('; ');
}

/** The form; it starts from what is in force each time it opens. */
function AccessForm({ data, onSaved }: { data: Loaded; onSaved: () => void }) {
  const [form, setForm] = useState<AccessValues>(data.settings);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The archive delay the shown preview was made for; Save waits for it to match the delay in the form.
  const [preview, setPreview] = useState<{ months: number; rows: PreviewRow[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const archiveChanged = form.archiveAfterMonths !== data.settings.archiveAfterMonths;
  const problem = settingsProblem(form, data.bounds);
  const months = form.archiveAfterMonths;

  useEffect(() => {
    // Every change of the delay drops the old preview, so Save always waits for one made for the value being saved.
    setPreview(null);
    setPreviewError(null);
    if (!archiveChanged || settingsProblem({ ...data.settings, archiveAfterMonths: months }, data.bounds)) return;
    let stale = false;
    api.post<{ projects: PreviewRow[] }>('/admin/access-settings/preview', { archiveAfterMonths: months }).then(
      (r) => !stale && setPreview({ months, rows: r.projects }),
      (e) => !stale && setPreviewError(errText(e)),
    );
    return () => {
      stale = true;
    };
  }, [archiveChanged, months]);

  const previewReady = !archiveChanged || (preview !== null && preview.months === months);
  const unchanged = ACCESS_ROWS.every((r) => form[r.key] === data.settings[r.key]) && form.analyticsExportAllowed === data.settings.analyticsExportAllowed && form.projectExportsAllowed === data.settings.projectExportsAllowed;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const r = reasonProblem(reason);
    if (r) return setError(r);
    setBusy(true);
    try {
      await api.put('/admin/access-settings', { ...form, reason: reason.trim() });
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof AccessValues, value: number | boolean) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <form className="stack" onSubmit={save} aria-label="Access and records settings">
      {ACCESS_ROWS.map((r) => {
        const b = data.bounds[r.key];
        const id = `access-${r.key}`;
        return (
          <div key={r.key} className="stack">
            <label htmlFor={id}>{r.label}</label>
            <div className="inline-form">
              <input id={id} type="number" inputMode="numeric" step={1} min={b.min} max={b.max} required value={Number.isNaN(form[r.key]) ? '' : form[r.key]} aria-describedby={`${id}-info`} onChange={(e) => set(r.key, e.target.value === '' ? NaN : Number(e.target.value))} />
              <span>{r.unit}</span>
            </div>
            <p id={`${id}-info`} className="hint">
              In force: {plural(data.settings[r.key], r.unit.replace(/s$/, ''))} · Default: {data.defaults[r.key]} · Allowed: {b.min}–{b.max}. {r.hint}
            </p>
          </div>
        );
      })}
      <div className="stack">
        <label className="check">
          <input type="checkbox" checked={form.analyticsExportAllowed} onChange={(e) => set('analyticsExportAllowed', e.target.checked)} />
          Analytics export allowed
        </label>
        <p className="hint">In force: {onOff(data.settings.analyticsExportAllowed)} · Default: {onOff(data.defaults.analyticsExportAllowed)}</p>
      </div>

      <div className="stack">
        <label className="check">
          <input type="checkbox" checked={!!form.projectExportsAllowed} onChange={(e) => set('projectExportsAllowed', e.target.checked)} />
          Project exports allowed
        </label>
        <p className="hint">In force: {onOff(!!data.settings.projectExportsAllowed)} · Default: {onOff(!!data.defaults.projectExportsAllowed)}. When off, nobody can export a project's records or work lists as a file. Even when on, each person must be able to read the project and hold one of the roles the project allows to export.</p>
      </div>

      {archiveChanged && (
        <section aria-labelledby="archive-preview" aria-live="polite">
          <h4 id="archive-preview">Closed projects this would change</h4>
          {previewError && <p role="alert" className="error">{previewError}</p>}
          {!previewError && !previewReady && !problem && <p className="loading">Checking which projects change</p>}
          {previewReady && preview && preview.rows.length === 0 && <p className="meta">No Closed project changes its archive state.</p>}
          {previewReady && preview && preview.rows.length > 0 && (
            <ul className="plain">
              {preview.rows.map((p) => (
                <li key={p.projectId}>
                  <strong>{p.name}</strong>
                  <span className="meta"> · closed {dayLabel(p.closedOn)} · now {p.archivedNow ? 'archived' : 'not archived'}, after {p.archivedAfter ? 'archived' : 'not archived'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {problem && <p role="alert" className="error">{problem}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <label>
        Reason for the change
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="primary" disabled={busy || unchanged || problem !== null || !previewReady || previewError !== null}>Save</button>
    </form>
  );
}

const HISTORY_COLUMNS: Column<Change>[] = [
  { key: 'when', header: 'When', sortValue: (c) => c.at, cell: (c) => formatWhen(c.at) },
  { key: 'who', header: 'Who', sortValue: (c) => c.actor.toLowerCase(), cell: (c) => c.actor },
  { key: 'what', header: 'What changed', cell: (c) => changedText(c) || 'the settings' },
  { key: 'reason', header: 'Reason', cell: (c) => c.reason },
];

/** Settings › Access and records (spec section 9, D90). */
export function AccessSettings() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<Loaded>('/admin/access-settings').then(setData, (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  const header = {
    crumbs: [{ text: 'Settings', href: '#/settings' }],
    title: 'Access and records',
    intro: 'Changes apply from the moment they are saved. Existing grants keep their dates.',
  };
  if (!data) {
    return (
      <main className="page">
        <PageHeader {...header} />
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
      </main>
    );
  }
  const s = data.settings;
  const glance = (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <p role="status" className="ok">{notice ?? ''}</p>
      <div className="stat-grid">
        {ACCESS_ROWS.map((r) => (
          <StatTile key={r.key} label={r.label} value={plural(s[r.key], r.unit.replace(/s$/, ''))} note={`Default ${data.defaults[r.key]}`} />
        ))}
        <StatTile label="Analytics export" value={onOff(s.analyticsExportAllowed)} />
        <StatTile label="Project exports" value={onOff(!!s.projectExportsAllowed)} />
      </div>
      <DataTable caption="Change history" columns={HISTORY_COLUMNS} rows={data.changes} rowKey={(c) => c.id} empty="No changes yet." />
    </>
  );
  return (
    <main className="page">
      <SettingsPage
        header={header}
        glance={glance}
        settings={[
          {
            key: 'rules',
            title: 'Access, exports and record keeping',
            current: (
              <ul className="plain">
                {ACCESS_ROWS.map((r) => (
                  <li key={r.key}>{r.label}: {plural(s[r.key], r.unit.replace(/s$/, ''))}</li>
                ))}
                <li>Analytics export allowed: {onOff(s.analyticsExportAllowed)}</li>
                <li>Project exports allowed: {onOff(!!s.projectExportsAllowed)}</li>
              </ul>
            ),
            form: (close) => (
              <AccessForm
                data={data}
                onSaved={() => {
                  setNotice('Saved.');
                  setError(null);
                  load();
                  close();
                }}
              />
            ),
          },
        ]}
      />
    </main>
  );
}
