import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';

interface Person {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export function People({ meId }: { meId: string }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPeople((await api.get<{ users: Person[] }>('/users')).users);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load people.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/users', { email, displayName: name });
      setEmail('');
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this person.');
    } finally {
      setBusy(false);
    }
  }

  async function disable(p: Person) {
    if (!window.confirm(`Disable ${p.displayName}? They will be signed out and will not be able to sign in. A disabled person is never deleted, so the audit trail stays complete.`)) return;
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

  const active = people?.filter((p) => p.status === 'active').length ?? 0;

  return (
    <main className="page narrow">
      <h1>People</h1>
      <p className="meta">Every person here is an Enterprise Administrator, the only role in this version. Keep at least two active, so one person being locked out does not lock everyone out.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {people && active < 2 && (
        <p className="warn">Only {active} active administrator. Add a second one now, and agree who holds recovery.</p>
      )}
      {!people && !error && <p className="loading">Loading</p>}
      {people && (
        <ul className="list people">
          {people.map((p) => (
            <li key={p.id}>
              <div className="person">
                <strong>{p.displayName}{p.id === meId ? ' (you)' : ''}</strong>
                <span className="meta">{p.email}, added {formatWhen(p.createdAt)}</span>
              </div>
              {p.status === 'disabled' ? (
                <>
                  <span className="badge badge-rejected">Disabled</span>
                  <button onClick={() => void enable(p)}>Enable</button>
                </>
              ) : (
                <button className="reject" onClick={() => void disable(p)} disabled={active < 2}>Disable</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <section className="panel" aria-label="Add an administrator">
        <h2>Add an administrator</h2>
        <form className="stack" onSubmit={add}>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Work email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <button className="primary" disabled={busy}>Add administrator</button>
        </form>
        <p className="hint">They sign in with a code sent to this address. Nothing else is sent.</p>
      </section>
    </main>
  );
}
