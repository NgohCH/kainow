import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Department } from '../api.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** Administrator screen: the department list projects choose their owning department from. */
export function Departments() {
  const [list, setList] = useState<Department[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(() => {
    api.get<{ departments: Department[] }>('/departments?all=1').then((r) => setList(r.departments), (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      load();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api.post('/departments', { name }))) setName('');
  }

  return (
    <main className="page narrow">
      <h1>Departments</h1>
      <p className="meta">Every project has one owning department and may have contributing ones. A retired department stays on existing projects but cannot be chosen for new ones.</p>
      <form className="row" onSubmit={add}>
        <label>
          New department <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="primary">Add</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {list && list.length === 0 && <p className="empty">No departments yet.</p>}
      {list && list.length > 0 && (
        <ul className="list">
          {list.map((d) => (
            <li key={d.id} className="row">
              {renaming?.id === d.id ? (
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => api.post(`/departments/${d.id}/rename`, { name: renaming.name }))) setRenaming(null);
                  }}
                >
                  <label>
                    Name <input required value={renaming.name} onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} />
                  </label>
                  <button className="primary">Save</button>
                  <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <span>
                    {d.name}
                    {d.status === 'retired' && <span className="meta"> (retired)</span>}
                  </span>
                  {d.status === 'active' && (
                    <span>
                      <button className="link-button" onClick={() => setRenaming({ id: d.id, name: d.name })}>Rename</button>{' '}
                      <button className="link-button" onClick={() => void run(() => api.post(`/departments/${d.id}/retire`))}>Retire</button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Administrator screen: the organisation email domains invitations may go to. */
export function Domains() {
  const [list, setList] = useState<Array<{ id: string; domain: string }> | null>(null);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<{ domains: Array<{ id: string; domain: string }> }>('/domains').then((r) => setList(r.domains), (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/domains', { domain });
      setDomain('');
      load();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <main className="page narrow">
      <h1>Eligible email domains</h1>
      <p className="meta">People can be invited only at these domains, for example help.edu.my. A domain alone admits nobody: each person still needs an invitation.</p>
      <form className="row" onSubmit={add}>
        <label>
          Domain <input required value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="help.edu.my" />
        </label>
        <button className="primary">Add</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {list && list.length === 0 && <p className="empty">No eligible domains yet, so nobody new can be invited.</p>}
      {list && list.length > 0 && (
        <ul className="list">
          {list.map((d) => (
            <li key={d.id} className="row">
              <span>{d.domain}</span>
              <button
                className="link-button"
                onClick={async () => {
                  setError(null);
                  try {
                    await api.post(`/domains/${d.id}/remove`);
                    load();
                  } catch (err) {
                    setError(errText(err));
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
