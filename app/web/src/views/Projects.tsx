import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, type AdminProjectRow, type Department, type Project, type ProjectSummary } from '../api.ts';
import { go } from '../App.tsx';
import { STATUS_LABEL, roleLabel } from '../projects.ts';

/** The home page: the person's projects, a new-project form, and for administrators every project's role holders. */
export function Projects({ isAdmin }: { isAdmin: boolean }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [all, setAll] = useState<AdminProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.get<{ projects: ProjectSummary[]; all?: AdminProjectRow[] }>('/projects').then(
      (r) => {
        setProjects(r.projects);
        setAll(r.all ?? null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  return (
    <main className="page narrow">
      <div className="row">
        <h1>My Projects</h1>
        <button className="primary" onClick={() => setCreating((c) => !c)} aria-expanded={creating}>
          {creating ? 'Close' : 'New project'}
        </button>
      </div>
      {creating && <NewProject onCreated={(p) => go(`#/projects/${p.id}`)} />}
      {error && <p role="alert" className="error">{error}</p>}
      {projects === null && !error && <p className="loading">Loading</p>}
      {projects?.length === 0 && !creating && (
        <p className="empty">
          You are not in any project yet. Create one, or accept an invitation from its Project Manager, Owner or a Sponsor.
        </p>
      )}
      {projects && projects.length > 0 && (
        <ul className="list">
          {projects.map((p) => (
            <li key={p.id}>
              <a href={`#/projects/${p.id}`}>
                <strong>{p.name}</strong>
                <span className="meta">
                  {STATUS_LABEL[p.status]}
                  {p.stage ? `, ${p.stage.stage}` : ''} · {p.owningDepartment} · You: {p.myRoles.map(roleLabel).join(', ')}
                </span>
                {p.missingAccountability && <span className="warn inline">Missing a required role</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
      {isAdmin && all && (
        <section aria-labelledby="all-heading">
          <h2 id="all-heading">All projects</h2>
          <p className="meta">As an administrator you manage Owner, Sponsor and Project Manager appointments. You see a project's notes only if you hold a role in it.</p>
          {all.length === 0 ? (
            <p className="empty">No projects yet. Add a department and an eligible email domain, then create the first project.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Status</th>
                  <th scope="col">Department</th>
                  <th scope="col">Role holders</th>
                </tr>
              </thead>
              <tbody>
                {all.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a href={`#/projects/${p.id}/people`}>{p.name}</a>
                    </td>
                    <td>{STATUS_LABEL[p.status]}</td>
                    <td>{p.owningDepartment}</td>
                    <td>{p.roleHolders.length === 0 ? 'None yet' : p.roleHolders.map((h) => `${h.displayName} (${roleLabel(h.role)})`).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}

function NewProject({ onCreated }: { onCreated: (p: Project) => void }) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [owning, setOwning] = useState('');
  const [contributing, setContributing] = useState<string[]>([]);
  const [plannedEnd, setPlannedEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((r) => setDepartments(r.departments), () => setDepartments([]));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ project: Project }>('/projects', {
        name,
        purpose,
        owningDepartmentId: owning,
        contributingDepartmentIds: contributing,
        plannedEnd: plannedEnd || null,
      });
      onCreated(r.project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The project was not created. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="New project">
      <form className="stack" onSubmit={submit}>
        <label>
          Name
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Purpose
          <textarea required rows={3} maxLength={4000} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
        <label>
          Owning department
          <select required value={owning} onChange={(e) => setOwning(e.target.value)}>
            <option value="">Choose a department</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {departments.length > 1 && (
          <fieldset>
            <legend>Contributing departments (optional)</legend>
            {departments
              .filter((d) => d.id !== owning)
              .map((d) => (
                <label key={d.id} className="check">
                  <input
                    type="checkbox"
                    checked={contributing.includes(d.id)}
                    onChange={(e) => setContributing((c) => (e.target.checked ? [...c, d.id] : c.filter((x) => x !== d.id)))}
                  />{' '}
                  {d.name}
                </label>
              ))}
          </fieldset>
        )}
        <label>
          Planned end (optional)
          <input type="date" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} />
        </label>
        {departments.length === 0 && <p className="warn">No departments yet. An administrator adds them under Departments.</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary" disabled={busy}>Create project</button>
        <p className="meta">You become its Project Manager. It starts as a Draft; appoint an Owner or Sponsor and a Member before making it Planned.</p>
      </form>
    </section>
  );
}
