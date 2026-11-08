import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Department, type Membership, type Project } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  type ClosureOutcome,
  type ProjectRole,
  OUTCOME_LABEL,
  STAGES,
  STATUS_LABEL,
  SUBSTAGES,
  type TransitionOption,
  canManage,
  formatExpiry,
  manageableRoles,
  membershipStateLabel,
  roleLabel,
  stageDuration,
  transitionsFor,
} from '../projects.ts';
import { Notes } from './Notes.tsx';

type Tab = 'overview' | 'people' | 'notes';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function ProjectPage({ projectId, tab }: { projectId: string; tab: Tab }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<{ project: Project }>(`/projects/${projectId}`).then(
      (r) => setProject(r.project),
      (e: Error) => setError(e.message),
    );
  }, [projectId]);
  useEffect(load, [load]);

  /** Runs one change; shows the server's reason if it is refused, otherwise reloads the project. */
  const act = useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      setError(null);
      setNotice(null);
      try {
        await work();
        setNotice(done);
        load();
        return true;
      } catch (e) {
        setError(errText(e, 'That did not work. Try again.'));
        return false;
      }
    },
    [load],
  );

  if (!project) {
    return (
      <main className="page narrow">
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
        <a href="#/">All projects</a>
      </main>
    );
  }

  const roles = project.myRoles;
  const contentAllowed = roles.length > 0;
  const tabs: Array<[Tab, string]> = [['overview', 'Overview'], ['people', 'People'], ...(contentAllowed ? ([['notes', 'Notes']] as Array<[Tab, string]>) : [])];
  const base = `#/projects/${project.id}`;

  return (
    <main className="page">
      <p><a href="#/">All projects</a></p>
      <div className="row">
        <h1>{project.name}</h1>
        <span className={`badge status-${project.status}`}>{STATUS_LABEL[project.status]}</span>
      </div>
      <p className="meta">
        {project.owningDepartment.name}
        {project.stage ? ` · ${project.stage.stage}${project.stage.substage ? `: ${project.stage.substage}` : ''} (${stageDuration(project.stage.startedAt)})` : ''}
        {roles.length > 0 ? ` · You: ${roles.map(roleLabel).join(', ')}` : project.isAdmin ? ' · You manage appointments as an administrator' : ''}
      </p>
      {project.missingAccountability && (
        <p className="warn" role="status">
          This project is missing {project.missingRoles.join(' and ')}. Existing work continues, but proposals cannot be approved until the role is filled.
        </p>
      )}
      <nav aria-label="Project" className="tabs">
        {tabs.map(([t, label]) => (
          <a key={t} href={t === 'overview' ? base : `${base}/${t}`} aria-current={tab === t ? 'page' : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {tab === 'overview' && <Overview project={project} act={act} />}
      {tab === 'people' && <People project={project} act={act} />}
      {tab === 'notes' && contentAllowed && (
        <Notes projectId={project.id} canAdd={roles.some((r) => r !== 'member') && ['draft', 'planned', 'active'].includes(project.status)} />
      )}
    </main>
  );
}

type Act = (work: () => Promise<unknown>, done: string) => Promise<boolean>;

function Overview({ project, act }: { project: Project; act: Act }) {
  const options = transitionsFor(project.status, project.myRoles, project.isAdmin);
  const [chosen, setChosen] = useState<TransitionOption | null>(null);
  const canEdit = project.myRoles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor') && ['draft', 'planned', 'active'].includes(project.status);
  const canStage = project.myRoles.includes('pm') && project.status === 'active';
  const [editing, setEditing] = useState(false);
  const [staging, setStaging] = useState(false);

  return (
    <>
      <section aria-labelledby="about-heading">
        <div className="row">
          <h2 id="about-heading">About</h2>
          {canEdit && (
            <button className="quiet" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
              {editing ? 'Close' : 'Edit details'}
            </button>
          )}
        </div>
        {editing ? (
          <EditDetails project={project} act={act} onDone={() => setEditing(false)} />
        ) : (
          <dl className="facts">
            <dt>Purpose</dt>
            <dd>{project.purpose}</dd>
            <dt>Owning department</dt>
            <dd>{project.owningDepartment.name}</dd>
            {project.contributingDepartments.length > 0 && (
              <>
                <dt>Contributing departments</dt>
                <dd>{project.contributingDepartments.map((d) => d.name).join(', ')}</dd>
              </>
            )}
            <dt>Planned end</dt>
            <dd>{project.plannedEnd ?? 'Not set'}</dd>
            {project.closureOutcome && (
              <>
                <dt>Closure outcome</dt>
                <dd>{OUTCOME_LABEL[project.closureOutcome]}</dd>
              </>
            )}
          </dl>
        )}
      </section>

      {(options.length > 0 || canStage) && (
        <section aria-labelledby="change-heading">
          <h2 id="change-heading">Change the project</h2>
          <div className="decision">
            {options.map((o) => (
              <button key={`${o.to}-${o.label}`} onClick={() => setChosen(o)} aria-expanded={chosen === o}>
                {o.label}
              </button>
            ))}
            {canStage && (
              <button onClick={() => setStaging((s) => !s)} aria-expanded={staging}>
                Change stage
              </button>
            )}
          </div>
          {chosen && <TransitionForm project={project} option={chosen} act={act} onDone={() => setChosen(null)} />}
          {staging && <StageForm project={project} act={act} onDone={() => setStaging(false)} />}
        </section>
      )}

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        <h3>Stages</h3>
        <ul className="plain">
          {project.stagePeriods.map((s, i) => (
            <li key={i}>
              {s.stage}
              {s.substage ? `: ${s.substage}` : ''} — from {formatWhen(s.startedAt)}
              {s.endedAt ? ` to ${formatWhen(s.endedAt)}` : ' (current)'}
              {s.reason ? ` — ${s.reason}` : ''}
            </li>
          ))}
        </ul>
        <h3>Status changes</h3>
        {project.transitions.length === 0 ? (
          <p className="meta">None yet. The project was created as a Draft.</p>
        ) : (
          <ul className="plain">
            {project.transitions.map((t, i) => (
              <li key={i}>
                {formatWhen(t.at)}: {STATUS_LABEL[t.from]} → {STATUS_LABEL[t.to]}
                {t.fastTrack ? ' (fast track)' : ''}
                {t.outcome ? `, ${OUTCOME_LABEL[t.outcome]}` : ''} by {t.actor}
                {t.reason ? ` — ${t.reason}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function TransitionForm({ project, option, act, onDone }: { project: Project; option: TransitionOption; act: Act; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<ClosureOutcome | ''>(option.outcomes?.length === 1 ? option.outcomes[0] : '');
  const [stage, setStage] = useState(project.stage?.stage ?? 'Execution');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () =>
        api.post(`/projects/${project.id}/transition`, {
          to: option.to,
          reason: reason || null,
          outcome: option.needs.outcome ? outcome || null : null,
          stage: option.needs.stage ? stage : null,
        }),
      `${option.label}: done.`,
    );
    if (ok) onDone();
  }

  return (
    <form className="panel stack" onSubmit={submit} aria-label={option.label}>
      {option.needs.outcome && (
        <label>
          Closure outcome
          <select required value={outcome} onChange={(e) => setOutcome(e.target.value as ClosureOutcome)}>
            <option value="">Choose an outcome</option>
            {(option.outcomes ?? []).map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </label>
      )}
      {option.needs.stage && (
        <label>
          Stage to continue in
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            {STAGES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        Reason{option.needs.reason ? '' : ' (optional)'}
        <textarea rows={2} required={option.needs.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="decision">
        <button className="primary">{option.label}</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function StageForm({ project, act, onDone }: { project: Project; act: Act; onDone: () => void }) {
  const [stage, setStage] = useState(project.stage?.stage ?? 'Initiation');
  const [substage, setSubstage] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await act(() => api.post(`/projects/${project.id}/stage`, { stage, substage: substage || null }), 'Stage changed.')) onDone();
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Change stage">
      <label>
        Stage
        <select value={stage} onChange={(e) => { setStage(e.target.value); setSubstage(''); }}>
          {STAGES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Substage (optional)
        <select value={substage} onChange={(e) => setSubstage(e.target.value)}>
          <option value="">None</option>
          {SUBSTAGES[stage].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <div className="decision">
        <button className="primary">Change stage</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function EditDetails({ project, act, onDone }: { project: Project; act: Act; onDone: () => void }) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [name, setName] = useState(project.name);
  const [purpose, setPurpose] = useState(project.purpose);
  const [owning, setOwning] = useState(project.owningDepartment.id);
  const [plannedEnd, setPlannedEnd] = useState(project.plannedEnd ?? '');
  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((r) => setDepartments(r.departments), () => setDepartments([]));
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () => api.post(`/projects/${project.id}/edit`, { name, purpose, owningDepartmentId: owning, plannedEnd: plannedEnd || null }),
      'Details saved.',
    );
    if (ok) onDone();
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Edit details">
      <label>
        Name
        <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Purpose
        <textarea required rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </label>
      <label>
        Owning department
        <select value={owning} onChange={(e) => setOwning(e.target.value)}>
          {!departments.some((d) => d.id === owning) && <option value={owning}>{project.owningDepartment.name}</option>}
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Planned end (optional)
        <input type="date" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} />
      </label>
      <div className="decision">
        <button className="primary">Save</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function People({ project, act }: { project: Project; act: Act }) {
  const invitable = manageableRoles(project.myRoles, project.isAdmin, project.status);
  const current = project.memberships.filter((m) => m.state !== 'revoked');
  const past = project.memberships.filter((m) => m.state === 'revoked');
  return (
    <>
      <section aria-labelledby="members-heading">
        <h2 id="members-heading">People</h2>
        {current.length === 0 ? (
          <p className="empty">No one holds a role yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Dates</th>
                <th scope="col">State</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {current.map((m) => (
                <MemberRow key={m.id} m={m} project={project} act={act} />
              ))}
            </tbody>
          </table>
        )}
        {past.length > 0 && (
          <details>
            <summary>Earlier appointments ({past.length})</summary>
            <ul className="plain">
              {past.map((m) => (
                <li key={m.id}>
                  {m.displayName}, {roleLabel(m.role)}, from {m.startsOn} (revoked)
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section aria-labelledby="invitations-heading">
        <h2 id="invitations-heading">Invitations</h2>
        {invitable.length > 0 && <InviteForm project={project} roles={invitable} act={act} />}
        {project.invitations.length === 0 ? (
          <p className="meta">No invitations yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {project.invitations.map((i) => {
                const manage = canManage(i.role, project.myRoles, project.isAdmin, project.status, 'invitation');
                return (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{roleLabel(i.role)}</td>
                    <td>
                      {i.status === 'invited' ? `Waiting · ${formatExpiry(i.expiresAt)}` : i.status[0].toUpperCase() + i.status.slice(1)}
                    </td>
                    <td>
                      {manage && (i.status === 'invited' || i.status === 'expired') && (
                        <button className="link-button" onClick={() => void act(() => api.post(`/invitations/${i.id}/resend`), `A new invitation was sent to ${i.email}.`)}>
                          Send again
                        </button>
                      )}{' '}
                      {manage && i.status === 'invited' && (
                        <button className="link-button" onClick={() => void act(() => api.post(`/invitations/${i.id}/revoke`), 'Invitation withdrawn.')}>
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function MemberRow({ m, project, act }: { m: Membership; project: Project; act: Act }) {
  const manage = canManage(m.role, project.myRoles, project.isAdmin, project.status, 'appointment');
  const [mode, setMode] = useState<'none' | 'extend' | 'revoke'>('none');
  const [date, setDate] = useState(m.expiresOn ?? '');
  const [reason, setReason] = useState('');
  return (
    <tr>
      <td>
        {m.displayName}
        <span className="meta"> {m.email}</span>
      </td>
      <td>{roleLabel(m.role)}</td>
      <td>
        from {m.startsOn}
        {m.expiresOn ? ` to ${m.expiresOn}` : ''}
      </td>
      <td>{membershipStateLabel(m.state)}</td>
      <td>
        {manage && mode === 'none' && (
          <>
            <button className="link-button" onClick={() => setMode('extend')}>Change expiry</button>{' '}
            <button className="link-button" onClick={() => setMode('revoke')}>Remove</button>
          </>
        )}
        {mode === 'extend' && (
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act(() => api.post(`/memberships/${m.id}/extend`, { expiresOn: date }), 'Expiry changed.')) setMode('none');
            }}
          >
            <label>
              New expiry <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <button className="primary">Save</button>
            <button type="button" onClick={() => setMode('none')}>Cancel</button>
          </form>
        )}
        {mode === 'revoke' && (
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act(() => api.post(`/memberships/${m.id}/revoke`, { reason }), `${m.displayName} no longer holds the ${roleLabel(m.role)} role.`)) setMode('none');
            }}
          >
            <label>
              Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button className="reject">Remove</button>
            <button type="button" onClick={() => setMode('none')}>Cancel</button>
          </form>
        )}
      </td>
    </tr>
  );
}

function InviteForm({ project, roles, act }: { project: Project; roles: ProjectRole[]; act: Act }) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<ProjectRole>(roles.includes('member') ? 'member' : roles[0]);
  const [startsOn, setStartsOn] = useState(today);
  const [expiresOn, setExpiresOn] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () => api.post(`/projects/${project.id}/invitations`, { email, displayName: displayName || null, role, startsOn, expiresOn: expiresOn || null }),
      `Invitation sent to ${email}. It expires in seven days.`,
    );
    if (ok) {
      setEmail('');
      setDisplayName('');
    }
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Invite someone">
      <div className="grid-2">
        <label>
          Work email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Name (optional)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Starts on
          <input type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label>
          Expires on (optional)
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
      </div>
      <button className="primary">Send invitation</button>
      <p className="meta">The person signs in with a code sent to that address, then accepts. Only addresses in an eligible organisation domain can be invited.</p>
    </form>
  );
}
