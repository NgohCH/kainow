import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';
import { departmentName, type PersonDepartment } from '../profile.ts';
import type { RecoveryCustodian } from '../custodian.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SettingsPage } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Meaning } from '../ui/meanings.ts';
import { DepartmentForm } from './DepartmentForm.tsx';

interface Person {
  id: string;
  email: string;
  displayName: string;
  role: 'enterprise_administrator' | 'member';
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
  department: PersonDepartment | null;
}

const ACCOUNT_STATE = { invited: 'Invited', active: 'Active', disabled: 'Disabled' } as const;
const ACCOUNT_MEANING: Record<Person['status'], Meaning> = { invited: 'planned', active: 'active', disabled: 'off' };

export function People({ meId }: { meId: string }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [personId, setPersonId] = useState('');
  const [custodian, setCustodian] = useState<RecoveryCustodian | null>(null);
  useEffect(() => {
    api.get<RecoveryCustodian>('/organisation/recovery-custodian').then(setCustodian, () => setCustodian(null));
  }, []);

  const load = useCallback(async () => {
    try {
      setPeople((await api.get<{ users: Person[] }>('/users')).users);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load people.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function add(e: FormEvent, close: () => void) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/users', { email, displayName: name });
      setEmail('');
      setName('');
      await load();
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this person.');
    } finally {
      setBusy(false);
    }
  }

  async function disable(p: Person) {
    if (
      !window.confirm(
        `Disable ${p.displayName}? They will be signed out and will not be able to sign in. Their current project memberships go On Hold and each Project Manager is asked to investigate. Enabling the account later does not lift those holds. A disabled person is never deleted, so the audit trail stays complete.`,
      )
    )
      return;
    setError(null);
    try {
      await api.post(`/users/${p.id}/disable`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable this person.');
    }
  }

  async function enable(p: Person) {
    setError(null);
    try {
      await api.post(`/users/${p.id}/enable`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not enable this person.');
    }
  }

  const person = people?.find((p) => p.id === personId);
  const active = people?.filter((p) => p.status === 'active' && p.role === 'enterprise_administrator').length ?? 0;
  const keptAdmin = (p: Person) => p.role === 'enterprise_administrator' && active < 2;
  const disabled = people?.filter((p) => p.status === 'disabled').length ?? 0;
  const recorded = custodian?.name && custodian.contact ? { name: custodian.name, contact: custodian.contact } : null;

  const columns: Column<Person>[] = [
    { key: 'name', header: 'Name', sortValue: (p) => p.displayName.toLowerCase(), cell: (p) => <strong>{p.displayName}{p.id === meId ? ' (you)' : ''}</strong> },
    { key: 'email', header: 'Email', sortValue: (p) => p.email.toLowerCase(), cell: (p) => p.email },
    { key: 'role', header: 'Role', sortValue: (p) => p.role, cell: (p) => (p.role === 'enterprise_administrator' ? 'Administrator' : 'Member') },
    { key: 'department', header: 'Department', sortValue: (p) => p.department?.name.toLowerCase() ?? '', cell: (p) => departmentName(p.department) },
    { key: 'added', header: 'Added', sortValue: (p) => p.createdAt, cell: (p) => formatWhen(p.createdAt) },
    { key: 'status', header: 'Account', sortValue: (p) => p.status, cell: (p) => <StatusLabel meaning={ACCOUNT_MEANING[p.status]} word={ACCOUNT_STATE[p.status]} /> },
    {
      key: 'action',
      header: 'Action',
      cell: (p) =>
        p.status === 'disabled' ? (
          <button onClick={() => void enable(p)} aria-label={`Enable ${p.displayName}`}>Enable</button>
        ) : (
          <>
            <button className="reject" onClick={() => void disable(p)} disabled={keptAdmin(p)} aria-label={`Disable ${p.displayName}`} aria-describedby={keptAdmin(p) ? `kept-${p.id}` : undefined}>
              Disable
            </button>
            {keptAdmin(p) && <span id={`kept-${p.id}`} className="hint">Administrators can be disabled only while two or more are active. Add another first.</span>}
          </>
        ),
    },
  ];

  const glance = (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      {people && active < 2 && (
        <p className="warn">Only {active} active administrator. Add a second one now, and agree who holds recovery.</p>
      )}
      <div className="stat-grid">
        <StatTile label="Active administrators" value={String(active)} meaning={people ? (active < 2 ? 'attention' : 'ok') : undefined} word={active < 2 ? 'Add another' : 'Enough'} note="Keep at least two" />
        <StatTile label="Disabled accounts" value={String(disabled)} />
        <StatTile label="Recovery custodian" value={recorded ? recorded.name : 'Not recorded'} meaning={custodian ? (recorded ? 'ok' : 'attention') : undefined} word={recorded ? 'Recorded' : 'Needs attention'} note={recorded?.contact} href="#/organisation" />
      </div>
      <DataTable caption="Everyone with an account" columns={columns} rows={people ?? []} rowKey={(p) => p.id} loading={!people && !error} empty="Nobody has an account yet." />
    </>
  );

  return (
    <main className="page">
      <SettingsPage
        header={{
          crumbs: [{ text: 'Settings', href: '#/settings' }],
          title: 'Administrators',
          intro: 'Everyone with an account. Administrators are added here; everyone else joins through a project invitation. Keep at least two active administrators, so one person being locked out does not lock everyone out.',
        }}
        glance={glance}
        settings={[
          {
            key: 'invite',
            title: 'Add an administrator',
            current: <p className="meta">They sign in with a code sent to their work email. Nothing else is sent.</p>,
            form: (close) => (
              <form className="stack" onSubmit={(e) => void add(e, close)} aria-label="Add an administrator">
                <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
                <label>Work email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
                <button className="primary" disabled={busy}>Add administrator</button>
              </form>
            ),
          },
          {
            key: 'department',
            title: 'Department of a person',
            current: <p className="meta">People choose their own on My profile. You can change anyone's here. It is for information only and gives no access.</p>,
            form: (close) => (
              <div className="stack">
                <label>
                  Person
                  <select value={person ? personId : ''} onChange={(e) => setPersonId(e.target.value)}>
                    <option value="">Choose a person</option>
                    {[...(people ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName)).map((p) => (
                      <option key={p.id} value={p.id}>{p.displayName} ({p.email}{p.status === 'disabled' ? ', disabled' : ''})</option>
                    ))}
                  </select>
                </label>
                {person && (
                  <DepartmentForm
                    key={person.id}
                    held={person.department}
                    label={`Department of ${person.displayName}`}
                    save={async (departmentId) => {
                      await api.put(`/users/${person.id}/department`, { departmentId });
                      await load();
                    }}
                    onDone={() => {
                      setPersonId('');
                      close();
                    }}
                  />
                )}
              </div>
            ),
          },
        ]}
      />
    </main>
  );
}
