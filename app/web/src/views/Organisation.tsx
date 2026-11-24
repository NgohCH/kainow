import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Department } from '../api.ts';
import { Box } from '../ui/Box.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';

/** A full page (header, breadcrumb) or, embedded in onboarding, a panel with a heading. */
function Page({ embedded, id, title, intro, children }: { embedded: boolean; id: string; title: string; intro: string; children: ReactNode }) {
  if (embedded) {
    return (
      <section className="box" aria-labelledby={id}>
        <h2 id={id} className="box-title">{title}</h2>
        <p className="meta">{intro}</p>
        {children}
      </section>
    );
  }
  return (
    <main className="page">
      <PageHeader crumbs={[{ text: 'Settings', href: '#/settings' }]} title={title} intro={intro} />
      {children}
    </main>
  );
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** Administrator screen: the department list projects choose their owning department from. */
export function Departments({ embedded = false }: { embedded?: boolean } = {}) {
  const [list, setList] = useState<Department[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** A name refused because a retired department has it: offered back instead of a second department. */
  const [retired, setRetired] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(() => {
    api.get<{ departments: Department[] }>('/departments?all=1').then((r) => setList(r.departments), (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    setRetired(null);
    try {
      await work();
      load();
      return true;
    } catch (e) {
      setError(errText(e));
      const found = e instanceof ApiError ? (e.data as { retiredDepartment?: { id: string; name: string } } | undefined)?.retiredDepartment : undefined;
      if (found) setRetired(found);
      return false;
    }
  };
  const restore = async (d: { id: string; name: string }) => {
    if (await run(() => api.post(`/departments/${d.id}/restore`))) {
      setName('');
      setRenaming(null);
    }
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api.post('/departments', { name }))) setName('');
  }

  const columns: Column<Department>[] = [
    {
      key: 'name',
      header: 'Department',
      sortValue: (d) => d.name.toLowerCase(),
      cell: (d) =>
        renaming?.id === d.id ? (
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
        ) : d.name,
    },
    { key: 'status', header: 'State', sortValue: (d) => d.status, cell: (d) => <StatusLabel meaning={d.status === 'active' ? 'active' : 'off'} word={d.status === 'active' ? 'In use' : 'Retired'} /> },
    {
      key: 'actions',
      header: 'Actions',
      cell: (d) =>
        renaming?.id === d.id ? null : d.status === 'retired' ? (
          <button className="link-button" onClick={() => void restore(d)} aria-label={`Bring back ${d.name}`}>Bring back</button>
        ) : (
          <>
            <button className="link-button" onClick={() => setRenaming({ id: d.id, name: d.name })} aria-label={`Rename ${d.name}`}>Rename</button>{' '}
            <button className="link-button" onClick={() => void run(() => api.post(`/departments/${d.id}/retire`))} aria-label={`Retire ${d.name}`}>Retire</button>
          </>
        ),
    },
  ];

  return (
    <Page embedded={embedded} id="departments-heading" title="Departments" intro="Every project has one owning department and may have contributing ones. A retired department stays on existing projects but cannot be chosen for new ones; bring it back to use it again. A name is used once only.">
      <Box title="Add a department" headingLevel={2}>
        <form className="row" onSubmit={add}>
          <label>
            New department <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="primary">Add</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
            {retired && <> <button type="button" className="link-button" onClick={() => void restore(retired)}>Bring back {retired.name}</button></>}
          </p>
        )}
      </Box>
      <DataTable caption="Departments" columns={columns} rows={list ?? []} rowKey={(d) => d.id} loading={!list && !error} empty="No departments yet." initialSort={{ key: 'name', dir: 'asc' }} />
    </Page>
  );
}

/** Administrator screen: the organisation email domains invitations may go to. */
export function Domains({ embedded = false }: { embedded?: boolean } = {}) {
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

  const remove = async (d: { id: string; domain: string }) => {
    setError(null);
    try {
      await api.post(`/domains/${d.id}/remove`);
      load();
    } catch (err) {
      setError(errText(err));
    }
  };
  const columns: Column<{ id: string; domain: string }>[] = [
    { key: 'domain', header: 'Domain', sortValue: (d) => d.domain.toLowerCase(), cell: (d) => d.domain },
    { key: 'actions', header: 'Actions', cell: (d) => <button className="link-button" onClick={() => void remove(d)} aria-label={`Remove ${d.domain}`}>Remove</button> },
  ];

  return (
    <Page embedded={embedded} id="domains-heading" title="Email domains" intro="People can be invited only at these domains, for example example.com. A domain alone admits nobody: each person still needs an invitation.">
      <Box title="Add a domain" headingLevel={2}>
        <form className="row" onSubmit={add}>
          <label>
            Domain <input required value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" />
          </label>
          <button className="primary">Add</button>
        </form>
        {error && <p role="alert" className="error">{error}</p>}
      </Box>
      <DataTable caption="Eligible email domains" columns={columns} rows={list ?? []} rowKey={(d) => d.id} loading={!list && !error} empty="No eligible domains yet, so nobody new can be invited." initialSort={{ key: 'domain', dir: 'asc' }} />
    </Page>
  );
}
