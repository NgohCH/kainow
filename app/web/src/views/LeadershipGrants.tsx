import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type AdminProjectRow, type Department } from '../api.ts';
import { formatWhen } from '../format.ts';
import { dayLabel } from '../dashboard.ts';
import { type Grant, type ScopeKind, grantStateLabel, reasonProblem, scopeLabel } from '../leadership.ts';
import { todayUtc8 } from '../changes.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SettingsPage } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface Person {
  id: string;
  displayName: string;
  email: string;
  status: string;
}

const EVENT_LABEL = { granted: 'Granted', end_changed: 'End date changed', revoked: 'Revoked' } as const;

function GrantForm({ meId, onDone }: { meId: string; onDone: () => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [projects, setProjects] = useState<AdminProjectRow[]>([]);
  const [userId, setUserId] = useState('');
  const [kind, setKind] = useState<ScopeKind>('organisation');
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [startsOn, setStartsOn] = useState(todayUtc8());
  const [expiresOn, setExpiresOn] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ users: Person[] }>('/users').then((r) => setPeople(r.users.filter((u) => u.status === 'active' && u.id !== meId)), () => setPeople([]));
    api.get<{ departments: Department[] }>('/departments').then((r) => setDepartments(r.departments), () => setDepartments([]));
    api.get<{ all?: AdminProjectRow[] }>('/projects').then((r) => setProjects(r.all ?? []), () => setProjects([]));
  }, [meId]);

  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) => set(on ? [...list, id] : list.filter((x) => x !== id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = reasonProblem(reason);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await api.post('/admin/leadership-grants', {
        userId,
        scope: { kind, ...(kind === 'departments' ? { departmentIds } : {}), ...(kind === 'projects' ? { projectIds } : {}) },
        startsOn,
        ...(expiresOn ? { expiresOn } : {}),
        reason: reason.trim(),
      });
      setUserId('');
      setReason('');
      setExpiresOn('');
      setDepartmentIds([]);
      setProjectIds([]);
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Give leadership access">
      <label>
        Person
        <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a person</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.email})</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Scope</legend>
        {([['organisation', 'The whole organisation'], ['departments', 'Departments'], ['projects', 'Named projects']] as const).map(([k, label]) => (
          <label key={k} className="choice">
            <input type="radio" name="grant-scope" checked={kind === k} onChange={() => setKind(k)} />
            {label}
          </label>
        ))}
      </fieldset>
      {kind === 'departments' && (
        <fieldset>
          <legend>Departments</legend>
          <p className="hint">Includes projects this department owns now and later.</p>
          {departments.map((d) => (
            <label key={d.id} className="check">
              <input type="checkbox" checked={departmentIds.includes(d.id)} onChange={(e) => toggle(departmentIds, setDepartmentIds, d.id, e.target.checked)} />
              {d.name}
            </label>
          ))}
        </fieldset>
      )}
      {kind === 'projects' && (
        <fieldset>
          <legend>Projects</legend>
          {projects.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={projectIds.includes(p.id)} onChange={(e) => toggle(projectIds, setProjectIds, p.id, e.target.checked)} />
              {p.name}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        First day (UTC+8)
        <input type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
      </label>
      <label>
        Last day, optional (UTC+8)
        <input type="date" value={expiresOn} min={startsOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </label>
      <p className="hint">Access works through the whole last day and ends at 00:00 UTC+8 the next day. Leave it empty for no end.</p>
      <label>
        Reason
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy || !userId}>Give access</button>
    </form>
  );
}

function GrantRow({ g, onDone }: { g: Grant; onDone: () => void }) {
  const [mode, setMode] = useState<'end' | 'revoke' | null>(null);
  const [expiresOn, setExpiresOn] = useState(g.expiresOn ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = g.state !== 'revoked';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = reasonProblem(reason);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      if (mode === 'end') await api.post(`/admin/leadership-grants/${g.id}/end`, { expiresOn: expiresOn || null, reason: reason.trim() });
      else await api.post(`/admin/leadership-grants/${g.id}/revoke`, { reason: reason.trim() });
      setMode(null);
      setReason('');
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="home-project">
      <h3>{g.userName} <span className="chip-quiet">{grantStateLabel(g.state)}</span></h3>
      <p className="meta">{g.email}</p>
      <dl className="facts">
        <dt>Scope</dt>
        <dd>{scopeLabel(g)}</dd>
        <dt>First day</dt>
        <dd>{dayLabel(g.startsOn)}</dd>
        <dt>Last day</dt>
        <dd>{g.expiresOn ? dayLabel(g.expiresOn) : 'No end date'}</dd>
        <dt>Reason</dt>
        <dd>{g.reason}</dd>
        {g.revokedAt && (
          <>
            <dt>Revoked</dt>
            <dd>{formatWhen(g.revokedAt)}{g.revokeReason ? `: ${g.revokeReason}` : ''}</dd>
          </>
        )}
      </dl>
      {live && mode === null && (
        <div className="inline-form">
          <button type="button" onClick={() => setMode('end')} aria-label={`Change the end date for ${g.userName}`}>Change end date</button>
          {g.state !== 'ended' && <button type="button" onClick={() => setMode('revoke')} aria-label={`Revoke access for ${g.userName}`}>Revoke</button>}
        </div>
      )}
      {mode !== null && (
        <form className="stack" onSubmit={submit} aria-label={mode === 'end' ? `Change end date for ${g.userName}` : `Revoke access for ${g.userName}`}>
          {mode === 'end' ? (
            <label>
              Last day, empty for no end (UTC+8)
              <input type="date" value={expiresOn} min={g.startsOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </label>
          ) : (
            <p className="warn">Revoking ends this access at once. To restore it, give access again.</p>
          )}
          <label>
            Reason
            <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy}>{mode === 'end' ? 'Save end date' : 'Revoke access'}</button>
            <button type="button" className="quiet" onClick={() => { setMode(null); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}
      {g.events.length > 0 && (
        <details>
          <summary>History ({g.events.length})</summary>
          <ul className="plain">
            {g.events.map((ev) => <li key={ev.id}>{formatWhen(ev.at)}: {EVENT_LABEL[ev.kind]} — {ev.reason}</li>)}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Settings, Leadership access (spec 6.1, D89): who sees the leadership summary, for which projects, and until when. */
export function LeadershipGrants({ meId }: { meId: string }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<{ grants: Grant[] }>('/admin/leadership-grants').then(
      (r) => {
        setGrants(r.grants);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  }, []);
  useEffect(load, [load]);

  const live = (grants ?? []).filter((g) => g.state === 'active' || g.state === 'scheduled');
  const notActive = live.filter((g) => g.accountStatus !== 'active');
  const columns: Column<Grant>[] = [
    { key: 'person', header: 'Person', sortValue: (g) => g.userName.toLowerCase(), cell: (g) => <>{g.userName} <span className="meta">{g.email}</span></> },
    { key: 'scope', header: 'Scope', cell: (g) => scopeLabel(g) },
    { key: 'account', header: 'Account', sortValue: (g) => g.accountStatus, cell: (g) => g.accountStatus.replace(/_/g, ' ') },
    { key: 'from', header: 'First day', sortValue: (g) => g.startsOn, cell: (g) => dayLabel(g.startsOn) },
  ];

  const glance = (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="stat-grid">
        <StatTile label="Active grants" value={String(live.filter((g) => g.state === 'active').length)} />
        <StatTile label="Scheduled grants" value={String(live.filter((g) => g.state === 'scheduled').length)} />
        <StatTile label="Holder not active" value={String(notActive.length)} meaning={grants ? (notActive.length > 0 ? 'attention' : 'ok') : undefined} word={notActive.length > 0 ? 'Needs attention' : 'None'} note="Access held by an account that is not Active" />
      </div>
      {notActive.length > 0 && <DataTable caption="Holder not active" columns={columns} rows={notActive} rowKey={(g) => g.id} empty="" />}
      <h3 id="grants-heading">Grants</h3>
      {!grants && !error && <p className="loading">Loading</p>}
      {grants && grants.length === 0 && <p className="empty">No leadership access has been given.</p>}
      <ul className="plain home-projects" aria-labelledby="grants-heading">
        {grants?.map((g) => <GrantRow key={g.id} g={g} onDone={load} />)}
      </ul>
    </>
  );

  return (
    <main className="page">
      <SettingsPage
        header={{ crumbs: [{ text: 'Settings', href: '#/settings' }], title: 'Leadership access', intro: "A leadership grant lets a person see summary figures for the projects in its scope. It gives no access to a project's content." }}
        glance={glance}
        settings={[
          {
            key: 'give',
            title: 'Give leadership access',
            current: <p className="meta">Choose a person, the scope, the days and a reason. Each grant and each change is recorded.</p>,
            form: (close) => <GrantForm meId={meId} onDone={() => { load(); close(); }} />,
          },
        ]}
      />
    </main>
  );
}
