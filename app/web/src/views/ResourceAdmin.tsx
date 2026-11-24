import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { CURRENCIES, type Currency } from '../finance.ts';
import { formatWhen, plural } from '../format.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SettingsPage } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { orgSettingsProblem, settingsChangeText } from '../resourceScreens.ts';
import { ResourceCatalogue } from './ResourceCatalogue.tsx';
import { useReturnFocus } from './useReturnFocus.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface Maintainer {
  userId: string;
  name: string;
  email: string;
  addedAt: string;
  reason: string;
  addedBy: string;
}
interface Person {
  id: string;
  displayName: string;
  email: string;
  status: string;
  role?: string;
}

function Maintainers({ bare = false, onChanged }: { bare?: boolean; onChanged?: () => void }) {
  const [list, setList] = useState<Maintainer[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const focus = useReturnFocus(removing ? `remove-${removing}` : null);

  const load = useCallback(() => {
    api.get<{ maintainers: Maintainer[] }>('/admin/resources/maintainers').then((r) => setList(r.maintainers), (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api.get<{ users: Person[] }>('/users').then((r) => setPeople(r.users.filter((u) => u.status === 'active' && u.role !== 'enterprise_administrator')), () => setPeople([]));
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const r = await api.post<{ maintainers: Maintainer[] }>('/admin/resources/maintainers', { userId, reason });
      setList(r.maintainers);
      onChanged?.();
      setUserId('');
      setReason('');
      setNotice('Catalogue maintainer added.');
    } catch (err) {
      setError(errText(err));
    }
  }

  async function remove(m: Maintainer, e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const r = await api.delete<{ maintainers: Maintainer[] }>('/admin/resources/maintainers', { userId: m.userId, reason: removeReason });
      setList(r.maintainers);
      onChanged?.();
      focus.leaving('maintainers-heading');
      setRemoving(null);
      setRemoveReason('');
      setNotice(`${m.name} no longer maintains the catalogue.`);
    } catch (err) {
      setError(errText(err));
    }
  }

  const taken = new Set((list ?? []).map((m) => m.userId));
  return (
    <section className={bare ? undefined : 'panel'} aria-labelledby="maintainers-heading">
      {bare ? <h4 id="maintainers-heading" tabIndex={-1} className="visually-hidden">Catalogue maintainers</h4> : <h2 id="maintainers-heading" tabIndex={-1}>Catalogue maintainers</h2>}
      <p className="meta">Administrators can always maintain the catalogue. Name other people here; each addition and removal is recorded with a reason, and either can be undone at any time.</p>
      <form className="stack" onSubmit={add} aria-label="Add a catalogue maintainer">
        <div className="grid-2">
          <label>
            Person
            <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose a person</option>
              {people.filter((p) => !taken.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.email})</option>)}
            </select>
          </label>
          <label>
            Reason
            <input required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <button className="primary">Add maintainer</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <p role="status" aria-live="polite" className="ok">{notice ?? ''}</p>
      {list && list.length === 0 && <p className="empty">No one besides the Administrators maintains the catalogue.</p>}
      {list && list.length > 0 && (
        <ul className="list">
          {list.map((m) => (
            <li key={m.userId}>
              <div className="row">
                <span>
                  {m.name} <span className="meta">({m.email}) · added by {m.addedBy}, {formatWhen(m.addedAt)} · Reason: {m.reason}</span>
                </span>
                <button type="button" className="link-button" data-opener={`remove-${m.userId}`} aria-label={`Remove ${m.name}`} onClick={() => setRemoving(removing === m.userId ? null : m.userId)}>Remove</button>
              </div>
              {removing === m.userId && (
                <form className="inline-form" onSubmit={(e) => void remove(m, e)} aria-label={`Remove ${m.name}`}>
                  <label>
                    Reason for removing
                    <input required maxLength={1000} value={removeReason} onChange={(e) => setRemoveReason(e.target.value)} />
                  </label>
                  <button className="primary">Remove maintainer</button>
                  <button type="button" onClick={() => setRemoving(null)}>Cancel</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface OrgSettings {
  projectsMayManageFinance: boolean;
  defaultCurrency: Currency;
  enabledCurrencies: Currency[];
  warnFirstPct: number;
  warnSecondPct: number;
}
interface OrgView {
  settings: OrgSettings;
  changes: { id: string; at: string; reason: string; actor: string; previous: unknown; next: unknown }[];
}

function FinanceSettingsPanel({ bare = false, onChanged }: { bare?: boolean; onChanged?: () => void }) {
  const [data, setData] = useState<OrgView | null>(null);
  const [may, setMay] = useState(true);
  const [def, setDef] = useState('MYR');
  const [enabled, setEnabled] = useState<string[]>([]);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (v: OrgView) => {
    setData(v);
    setMay(v.settings.projectsMayManageFinance);
    setDef(v.settings.defaultCurrency);
    setEnabled(v.settings.enabledCurrencies);
    setFirst(String(v.settings.warnFirstPct));
    setSecond(String(v.settings.warnSecondPct));
    setReason('');
  };
  useEffect(() => {
    api.get<OrgView>('/admin/resources/settings').then(apply, (e) => setError(errText(e)));
  }, []);

  if (!data) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  const s = data.settings;
  const form = { projectsMayManageFinance: may, defaultCurrency: def, enabledCurrencies: enabled, first, second };
  const sameCurrencies = JSON.stringify([...enabled].sort()) === JSON.stringify([...s.enabledCurrencies].sort());
  const unchanged = may === s.projectsMayManageFinance && def === s.defaultCurrency && sameCurrencies && first === String(s.warnFirstPct) && second === String(s.warnSecondPct);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const problem = orgSettingsProblem(form);
    if (problem) return setError(problem);
    if (unchanged) return setError('Nothing to change.');
    setBusy(true);
    try {
      apply(
        await api.put<OrgView>('/admin/resources/settings', {
          projectsMayManageFinance: may,
          defaultCurrency: def,
          enabledCurrencies: CURRENCIES.filter((c) => enabled.includes(c)),
          warnFirstPct: Number(first),
          warnSecondPct: Number(second),
          reason: reason.trim(),
        }),
      );
      setNotice('Saved. The change is in the history below.');
      onChanged?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={bare ? undefined : 'panel'} aria-labelledby={bare ? undefined : 'finance-admin-heading'} aria-label={bare ? 'Finance' : undefined}>
      {!bare && <h2 id="finance-admin-heading">Finance</h2>}
      <p className="meta">These are the organisation's defaults. {may && 'A project can set its own warning thresholds. '}Spending warnings are advisory and never block anything.</p>
      <form className="stack" onSubmit={save} aria-label="Finance settings">
        <label className="check">
          <input type="checkbox" checked={may} onChange={(e) => setMay(e.target.checked)} />
          Projects may manage their own finance settings
        </label>
        <span className="hint">When off, only an Administrator can change a project's finance settings. Existing settings stay in force.</span>
        <fieldset>
          <legend>Enabled currencies</legend>
          {CURRENCIES.map((c) => (
            <label key={c} className="check">
              <input type="checkbox" checked={enabled.includes(c)} onChange={(e) => setEnabled((cur) => (e.target.checked ? [...cur, c] : cur.filter((x) => x !== c)))} />
              {c}
            </label>
          ))}
          <span className="hint">Turning one off stops new selection and keeps existing entries.</span>
        </fieldset>
        <label>
          Default currency
          <select value={def} onChange={(e) => setDef(e.target.value)}>
            {CURRENCIES.filter((c) => enabled.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
            {!enabled.includes(def) && <option value={def}>{def} (not enabled)</option>}
          </select>
        </label>
        <fieldset>
          <legend>Default warning thresholds</legend>
          <div className="inline-form">
            <label>
              First warning (%)
              <input required inputMode="numeric" value={first} onChange={(e) => setFirst(e.target.value)} />
            </label>
            <label>
              Second warning (%)
              <input required inputMode="numeric" value={second} onChange={(e) => setSecond(e.target.value)} />
            </label>
          </div>
          <span className="hint">Whole percentages from 1 to 200, the first below the second. The defaults are 80 and 100.</span>
        </fieldset>
        <label>
          Reason
          <input required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <span className="hint">Recorded with the old and new values.</span>
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        {notice && <p role="status" className="ok">{notice}</p>}
        <button className="primary" disabled={busy}>Save finance settings</button>
      </form>
      {bare ? <h4>History</h4> : <h3>History</h3>}
      {data.changes.length === 0 ? (
        <p className="meta">No changes have been recorded.</p>
      ) : (
        <ul className="plain">
          {data.changes.map((c) => (
            <li key={c.id}>
              {settingsChangeText(c.previous, c.next)}
              <span className="meta"> · {c.actor} · {formatWhen(c.at)} · Reason: {c.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface MaintainerRow { userId: string; name: string; email: string; addedAt: string }

const MAINTAINER_COLUMNS: Column<MaintainerRow>[] = [
  { key: 'name', header: 'Name', sortValue: (m) => m.name.toLowerCase(), cell: (m) => <strong>{m.name}</strong> },
  { key: 'email', header: 'Email', sortValue: (m) => m.email.toLowerCase(), cell: (m) => m.email },
  { key: 'added', header: 'Added', sortValue: (m) => m.addedAt, cell: (m) => formatWhen(m.addedAt) },
];

/** Settings › Resources and finance (spec 8.1). */
export function ResourceAdmin() {
  const [maintainers, setMaintainers] = useState<MaintainerRow[] | null>(null);
  const [finance, setFinance] = useState<OrgView | null>(null);
  const [catalogue, setCatalogue] = useState<{ active: number; retired: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<{ maintainers: MaintainerRow[] }>('/admin/resources/maintainers').then((r) => setMaintainers(r.maintainers), (e) => setError(errText(e)));
    api.get<OrgView>('/admin/resources/settings').then(setFinance, (e) => setError(errText(e)));
    api.get<{ items: Array<{ status: string }> }>('/resources/catalogue?all=1').then(
      (r) => setCatalogue({ active: r.items.filter((i) => i.status === 'active').length, retired: r.items.filter((i) => i.status !== 'active').length }),
      (e) => setError(errText(e)),
    );
  }, []);
  useEffect(load, [load]);

  const s = finance?.settings;
  const glance = (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="stat-grid">
        <StatTile label="Catalogue items in use" value={catalogue ? String(catalogue.active) : 'Loading'} note={catalogue ? `${catalogue.retired} retired` : undefined} />
        <StatTile label="Catalogue maintainers" value={maintainers ? String(maintainers.length) : 'Loading'} note="Besides the Administrators" />
        <StatTile label="Default currency" value={s ? s.defaultCurrency : 'Loading'} note={s ? `Enabled: ${s.enabledCurrencies.join(', ')}` : undefined} />
        <StatTile label="Spending warnings" value={s ? `${s.warnFirstPct}% and ${s.warnSecondPct}%` : 'Loading'} note={s ? (s.projectsMayManageFinance ? 'Projects may set their own' : 'Projects may not set their own') : undefined} />
      </div>
      <DataTable caption="Catalogue maintainers" columns={MAINTAINER_COLUMNS} rows={maintainers ?? []} rowKey={(m) => m.userId} loading={maintainers === null && !error} empty="No one besides the Administrators maintains the catalogue." />
    </>
  );
  return (
    <main className="page">
      <SettingsPage
        header={{ crumbs: [{ text: 'Settings', href: '#/settings' }], title: 'Resources and finance', intro: 'The shared resource catalogue, who maintains it, and the finance defaults projects start from.' }}
        glance={glance}
        settings={[
          {
            key: 'catalogue',
            title: 'Resource catalogue',
            current: <p>{catalogue ? `${plural(catalogue.active, 'item')} in use, ${catalogue.retired} retired.` : 'Loading'}</p>,
            form: () => <ResourceCatalogue embedded bare onChanged={load} />,
          },
          {
            key: 'maintainers',
            title: 'Catalogue maintainers',
            current: <p>{maintainers ? (maintainers.length === 0 ? 'Only the Administrators.' : `${plural(maintainers.length, 'person', 'people')} besides the Administrators.`) : 'Loading'}</p>,
            form: () => <Maintainers bare onChanged={load} />,
          },
          {
            key: 'finance',
            title: 'Finance defaults',
            current: <p>{s ? `Default currency ${s.defaultCurrency}; warnings at ${s.warnFirstPct}% and ${s.warnSecondPct}%.` : 'Loading'}</p>,
            form: () => <FinanceSettingsPanel bare onChanged={load} />,
          },
        ]}
      />
    </main>
  );
}
