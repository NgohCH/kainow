import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Membership, type Project } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  type ClosureOutcome,
  type ProjectRole,
  OUTCOME_LABEL,
  STAGES,
  accessLabel,
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
import { HumanProposals } from './HumanProposals.tsx';
import { ProjectApprovals } from './ApprovalSettings.tsx';
import { Closing, DelegationControl, type ClosedSummary, type ClosureView } from './Closing.tsx';
import { DeadlineReview } from './DeadlineReview.tsx';
import { Notes } from './Notes.tsx';
import { Work } from './Work.tsx';
import { DeliveryHistory } from './Deliveries.tsx';
import { DigestSend, EscalationFlags } from './DigestSend.tsx';
import { ProjectSettings } from './NotificationSettings.tsx';
import { ProjectCalendarProvider } from './ProjectCalendar.tsx';
import { type Act, ArchivePanel, DepartmentMove, GrantsSection, HandoverForm, HoldActions } from './ProjectAccessPanels.tsx';

type Tab = 'overview' | 'people' | 'notes' | 'work' | 'settings' | 'closing' | 'deadline-review';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function ProjectPage({ projectId, tab, meId, itemId }: { projectId: string; tab: Tab; meId: string; itemId?: string }) {
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
  // A message about the last change belongs to the tab it was made on.
  useEffect(() => setNotice(null), [tab]);

  /** Runs one change; shows the server's reason if it is refused, otherwise reloads the project. */
  const act = useCallback(
    async (work: () => Promise<unknown>, done: string | ((result: unknown) => string)) => {
      setError(null);
      setNotice(null);
      try {
        const result = await work();
        setNotice(typeof done === 'function' ? done(result) : done);
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
        <a href="#/">My Projects</a>
      </main>
    );
  }

  const roles = project.myRoles;
  // Members read the notes; so does an Audit or Oversight grant holder, read-only.
  const contentAllowed = roles.length > 0 || project.access !== null;
  const tabs: Array<[Tab, string]> = [
    ['overview', 'Overview'],
    ['people', 'People'],
    ...(contentAllowed ? ([['notes', 'Notes'], ['work', 'Work']] as Array<[Tab, string]>) : []),
    ['settings', 'Settings'],
  ];
  // The project's current people, for choosing assignees, requesters and responsible people.
  const people = [
    ...new Map(
      project.memberships
        .filter((m) => m.state === 'active' || m.state === 'scheduled')
        .map((m) => [m.userId, { userId: m.userId, displayName: m.displayName, email: m.email }]),
    ).values(),
  ];
  const open = ['draft', 'planned', 'active'].includes(project.status);
  const base = `#/projects/${project.id}`;

  return (
    <ProjectCalendarProvider projectId={project.id}>
    <main className="page">
      <p><a href="#/">My Projects</a></p>
      <div className="row">
        <h1>{project.name}</h1>
        <span className={`badge status-${project.status}`}>{STATUS_LABEL[project.status]}</span>
      </div>
      <p className="meta">
        {project.owningDepartment.name}
        {project.stage ? ` · ${project.stage.stage}${project.stage.substage ? `: ${project.stage.substage}` : ''} (${stageDuration(project.stage.startedAt)})` : ''}
        {roles.length > 0
          ? ` · You: ${roles.map(roleLabel).join(', ')}`
          : project.access
            ? ` · ${accessLabel(project.access)} (read-only)`
            : project.isAdmin
              ? ' · You manage appointments as an administrator'
              : ''}
        {project.archived ? ' · Archived' : ''}
      </p>
      {project.onHold && (
        <p className="warn" role="status">
          A member is On Hold — investigation needed. <a href={`#/projects/${project.id}/people`}>Open People</a>
        </p>
      )}
      {project.missingAccountability && (
        <p className="warn" role="status">
          This project is missing {project.missingRoles.join(' and ')}. Existing work continues, but proposals cannot be approved until the role is filled.
        </p>
      )}
      <EscalationFlags projectId={project.id} />
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
      {tab === 'settings' && <ProjectSettings projectId={project.id} />}
      {tab === 'closing' && <Closing project={project} act={act} />}
      {tab === 'deadline-review' && <DeadlineReview project={project} />}
      {tab === 'people' && <People project={project} act={act} />}
      {tab === 'notes' && contentAllowed && (
        <>
          <Notes projectId={project.id} canAdd={roles.some((r) => r !== 'member') && open} />
          <HumanProposals
            projectId={project.id}
            canPropose={roles.length > 0 && open}
            canReview={roles.some((r) => r === 'owner' || r === 'sponsor') && ['planned', 'active'].includes(project.status)}
            people={people}
            meId={meId}
            focusId={itemId}
          />
        </>
      )}
      {tab === 'work' && contentAllowed && (
        <Work projectId={project.id} people={people} canPropose={roles.length > 0} canClear={roles.some((r) => r === 'pm' || r === 'deputy_pm')} focusId={itemId} />
      )}
    </main>
    </ProjectCalendarProvider>
  );
}

function Overview({ project, act }: { project: Project; act: Act }) {
  const options = transitionsFor(project.status, project.myRoles, project.isAdmin);
  const [chosen, setChosen] = useState<TransitionOption | null>(null);
  const canEdit = project.myRoles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor') && ['draft', 'planned', 'active'].includes(project.status);
  const canStage = project.myRoles.includes('pm') && project.status === 'active';
  const [editing, setEditing] = useState(false);
  const [staging, setStaging] = useState(false);
  const [closure, setClosure] = useState<ClosureView | null>(null);
  const [markedTasks, setMarkedTasks] = useState(0);
  const [atClosure, setAtClosure] = useState<ClosedSummary | null>(null);
  const [tick, setTick] = useState(0);
  // Shared by the action-item email and the Email delivery list: a sent digest shows up in the list at once.
  const [deliveriesKey, setDeliveriesKey] = useState(0);
  const closable = ['planned', 'active', 'deferred'].includes(project.status);
  const isOS = project.myRoles.some((r) => r === 'owner' || r === 'sponsor');
  const isPmOrDeputy = project.myRoles.some((r) => r === 'pm' || r === 'deputy_pm');
  const isEmailManager = project.myRoles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor');
  useEffect(() => {
    if (!closable || project.myRoles.length === 0) return setClosure(null);
    api.get<ClosureView>(`/projects/${project.id}/closure`).then(setClosure, () => setClosure(null));
  }, [project.id, project.status, project.myRoles.length, closable, tick]);
  useEffect(() => {
    if (project.status !== 'closed') return setAtClosure(null);
    api.get<ClosureView>(`/projects/${project.id}/closure`).then((v) => setAtClosure(v.closedSummary ?? null), () => setAtClosure(null));
  }, [project.id, project.status]);
  useEffect(() => {
    if (!isPmOrDeputy || !['active', 'deferred', 'closed'].includes(project.status)) return setMarkedTasks(0);
    api.get<{ tasks: unknown[] }>(`/projects/${project.id}/deadline-review`).then((r) => setMarkedTasks(r.tasks.length), () => setMarkedTasks(0));
  }, [project.id, project.status, isPmOrDeputy]);
  const flags = project.openReviewFlags ?? 0;

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

      {atClosure && (atClosure.kept.length > 0 || atClosure.unresolved.length > 0) && (
        <section aria-labelledby="at-closure-heading">
          <h2 id="at-closure-heading">At closure</h2>
          {atClosure.kept.length > 0 && (
            <>
              <h3>Tasks kept outstanding</h3>
              <ul className="plain">
                {atClosure.kept.map((k) => (
                  <li key={k.id}><strong>{k.title}</strong>: {k.reason}</li>
                ))}
              </ul>
            </>
          )}
          {atClosure.unresolved.length > 0 && (
            <>
              <h3>Questions left unresolved</h3>
              <ul className="plain">
                {atClosure.unresolved.map((q) => (
                  <li key={q.id}>
                    <strong>{q.text}</strong>: {q.reason}
                    {q.affectsDelivery ? ' (affects delivery acceptance)' : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {(options.length > 0 || canStage) && (
        <section aria-labelledby="change-heading">
          <h2 id="change-heading">Change the project</h2>
          <div className="decision">
            {options.map((o) =>
              o.to === 'closed' ? (
                <a key={`${o.to}-${o.label}`} className="button" href={`#/projects/${project.id}/closing`}>
                  {o.label}
                </a>
              ) : (
                <button key={`${o.to}-${o.label}`} onClick={() => setChosen(o)} aria-expanded={chosen === o}>
                  {o.label}
                </button>
              ),
            )}
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

      {(closure?.mayPrepare || markedTasks > 0 || flags > 0 || (isOS && closable)) && (
        <section aria-labelledby="records-heading">
          <h2 id="records-heading">Closing and reviews</h2>
          {flags > 0 && (
            <p className="review-flags">
              {flags} {flags === 1 ? 'item is' : 'items are'} flagged for review after a decision changed. <a href={`#/projects/${project.id}/work`}>Open Work</a>
            </p>
          )}
          {markedTasks > 0 && (
            <p>
              {markedTasks} {markedTasks === 1 ? 'task needs' : 'tasks need'} a new authorised due date. <a href={`#/projects/${project.id}/deadline-review`}>Deadline review</a>
            </p>
          )}
          {closure?.mayPrepare && <a className="button" href={`#/projects/${project.id}/closing`}>Prepare closure</a>}
          {isOS && closable && closure && (
            <DelegationControl
              project={project}
              view={closure}
              run={async (work, done) => {
                const ok = await act(work, done);
                setTick((n) => n + 1);
                return ok;
              }}
            />
          )}
          {closure?.delegation && <p className="meta">{closure.delegation.pm} may close this project. Allowed by {closure.delegation.by}: {closure.delegation.reason}</p>}
        </section>
      )}

      <ProjectApprovals projectId={project.id} />

      {isEmailManager && project.status === 'active' && <DigestSend projectId={project.id} onSent={() => setDeliveriesKey((n) => n + 1)} />}
      {isEmailManager && (
        <section aria-labelledby="deliveries-heading">
          <h2 id="deliveries-heading">Email delivery</h2>
          <DeliveryHistory path={`/projects/${project.id}/deliveries`} reloadKey={deliveriesKey} />
        </section>
      )}

      <ArchivePanel project={project} act={act} />
      <DepartmentMove project={project} act={act} />

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
          objectivesMet: false,
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
  const [name, setName] = useState(project.name);
  const [purpose, setPurpose] = useState(project.purpose);
  const [plannedEnd, setPlannedEnd] = useState(project.plannedEnd ?? '');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () => api.post(`/projects/${project.id}/edit`, { name, purpose, plannedEnd: plannedEnd || null }),
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
      <p className="meta">
        Owning department: {project.owningDepartment.name}. Only an Enterprise Administrator can move a project to another department.
      </p>
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

      <HandoverForm project={project} act={act} />
      <GrantsSection project={project} act={act} />

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
                // Withdrawing is cleanup, allowed in any status; the PM may withdraw their own handover.
                const withdraw = canManage(i.role, project.myRoles, project.isAdmin, project.status, 'appointment') || (i.kind === 'handover' && project.myRoles.includes('pm'));
                return (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{i.kind === 'handover' ? 'Project Manager (handover)' : roleLabel(i.role)}</td>
                    <td>
                      {i.status === 'invited' ? `Waiting · ${formatExpiry(i.expiresAt)}` : i.status[0].toUpperCase() + i.status.slice(1)}
                    </td>
                    <td>
                      {manage && (i.status === 'invited' || i.status === 'expired') && (
                        <button
                          className="link-button"
                          onClick={() =>
                            void act(
                              () => api.post(`/invitations/${i.id}/resend`),
                              (r) => ((r as { delivered?: boolean }).delivered === false ? 'The email was not sent. Send again.' : `A new invitation was sent to ${i.email}.`),
                            )
                          }
                        >
                          Send again
                        </button>
                      )}{' '}
                      {withdraw && i.status === 'invited' && (
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
      <td>
        {m.state === 'on_hold' ? <span className="badge badge-rejected">{membershipStateLabel(m.state)}</span> : membershipStateLabel(m.state)}
        {m.holdReason ? <span className="meta"> {m.holdReason}</span> : null}
      </td>
      <td>
        {m.state === 'on_hold' && <HoldActions m={m} project={project} act={act} canRestore={manage} />}
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
      (r) => ((r as { delivered?: boolean }).delivered === false ? 'The email was not sent. Send again.' : `Invitation sent to ${email}. It expires in seven days.`),
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
