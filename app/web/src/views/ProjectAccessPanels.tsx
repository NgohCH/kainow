import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, type Department, type Finding, type Grant, type Membership, type Project } from '../api.ts';
import { formatWhen } from '../format.ts';
import { type GrantKind, accessLabel, canArchive, canManageGrants, grantStateLabel, roleLabel } from '../projects.ts';

export type Act = (work: () => Promise<unknown>, done: string | ((result: unknown) => string)) => Promise<boolean>;

const todayUtc8 = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A reason box with one button, used for archive, suspend, restore and similar changes. */
function ReasonForm({ label, button, onSubmit, onCancel }: { label: string; button: string; onSubmit: (reason: string) => Promise<boolean>; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSubmit(reason)) setReason('');
      }}
    >
      <label>
        {label} <input required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="primary">{button}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

/** Archive and unarchive a Closed project (navigation only; it stays Closed and read-only). */
export function ArchivePanel({ project, act }: { project: Project; act: Act }) {
  const [open, setOpen] = useState(false);
  if (project.status !== 'closed') return null;
  const may = canArchive(project.status, project.myRoles);
  const verb = project.archived ? 'unarchive' : 'archive';
  return (
    <section aria-labelledby="archive-heading">
      <h2 id="archive-heading">Archive</h2>
      <p className="meta">
        {project.archived
          ? project.archivedAutomatically
            ? 'Archived automatically twelve months after closing. It stays Closed and read-only.'
            : 'Archived. It stays Closed and read-only.'
          : 'Closed projects are archived automatically twelve months after closing. Archiving changes only where the project is listed.'}
      </p>
      {may &&
        (open ? (
          <ReasonForm
            label="Reason"
            button={project.archived ? 'Unarchive' : 'Archive'}
            onCancel={() => setOpen(false)}
            onSubmit={async (reason) => {
              const ok = await act(() => api.post(`/projects/${project.id}/${verb}`, { reason }), project.archived ? 'Unarchived.' : 'Archived.');
              if (ok) setOpen(false);
              return ok;
            }}
          />
        ) : (
          <button onClick={() => setOpen(true)}>{project.archived ? 'Unarchive' : 'Archive'}</button>
        ))}
    </section>
  );
}

/** The Administrator moves the project to another owning department, with a reason. */
export function DepartmentMove({ project, act }: { project: Project; act: Act }) {
  const [open, setOpen] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) api.get<{ departments: Department[] }>('/departments').then((r) => setDepartments(r.departments), () => setDepartments([]));
  }, [open]);
  if (!project.isAdmin) return null;
  const contributing = new Set(project.contributingDepartments.map((d) => d.id));
  const choices = departments.filter((d) => d.id !== project.owningDepartment.id && !contributing.has(d.id));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await act(() => api.post(`/projects/${project.id}/department`, { departmentId: to, reason }), 'The project was moved to another department.')) {
      setOpen(false);
      setReason('');
    }
  }
  return (
    <section aria-labelledby="department-heading">
      <h2 id="department-heading">Owning department</h2>
      {open ? (
        <form className="panel stack" onSubmit={submit} aria-label="Move to another department">
          <label>
            New owning department
            <select required value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose a department</option>
              {choices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason
            <input required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className="meta">The project's files stay where they are until managed storage arrives.</p>
          <div className="decision">
            <button className="primary">Move</button>
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <button onClick={() => setOpen(true)}>Move to another department</button>
      )}
    </section>
  );
}

/** For a held membership: findings (for those who may read them), recording one, and restoring. */
export function HoldActions({ m, project, act, canRestore }: { m: Membership; project: Project; act: Act; canRestore: boolean }) {
  const canRecord = canRestore || project.myRoles.includes('pm');
  const [mode, setMode] = useState<'none' | 'finding' | 'restore'>('none');
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [finding, setFinding] = useState('');
  const [recommendation, setRecommendation] = useState<'restore' | 'revoke'>('restore');
  if (!canRecord) return null;
  async function loadFindings() {
    try {
      setFindings((await api.get<{ findings: Finding[] }>(`/memberships/${m.id}/findings`)).findings);
    } catch (e) {
      setFindings([]);
      void e;
    }
  }
  return (
    <div className="hold-actions">
      {mode === 'none' && (
        <>
          <button className="link-button" onClick={() => setMode('finding')}>Record finding</button>{' '}
          <button className="link-button" onClick={() => void loadFindings()}>Show findings</button>{' '}
          {canRestore && <button className="link-button" onClick={() => setMode('restore')}>Restore</button>}
        </>
      )}
      {mode === 'finding' && (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(() => api.post(`/memberships/${m.id}/findings`, { finding, recommendation }), 'Finding recorded.')) {
              setMode('none');
              setFinding('');
              void loadFindings();
            }
          }}
        >
          <label>
            Finding <textarea required rows={3} maxLength={4000} value={finding} onChange={(e) => setFinding(e.target.value)} />
          </label>
          <label>
            Recommendation
            <select value={recommendation} onChange={(e) => setRecommendation(e.target.value as 'restore' | 'revoke')}>
              <option value="restore">Restore the membership</option>
              <option value="revoke">Remove the membership</option>
            </select>
          </label>
          <div className="decision">
            <button className="primary">Record</button>
            <button type="button" onClick={() => setMode('none')}>Cancel</button>
          </div>
        </form>
      )}
      {mode === 'restore' && (
        <ReasonForm
          label="Reason for restoring"
          button="Restore"
          onCancel={() => setMode('none')}
          onSubmit={async (reason) => {
            const ok = await act(() => api.post(`/memberships/${m.id}/restore`, { reason }), `${m.displayName}'s ${roleLabel(m.role)} role is restored.`);
            if (ok) setMode('none');
            return ok;
          }}
        />
      )}
      {findings && (
        <ul className="plain findings">
          {findings.length === 0 && <li className="meta">No findings yet, or you may not read them.</li>}
          {findings.map((f) => (
            <li key={f.id}>
              {formatWhen(f.at)}, {f.recordedBy}: {f.finding} <span className="meta">(recommends {f.recommendation === 'restore' ? 'restoring' : 'removing'})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The current Project Manager hands the project over to someone who must accept. */
export function HandoverForm({ project, act }: { project: Project; act: Act }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [outgoingRole, setOutgoingRole] = useState<'deputy_pm' | 'member' | 'leave'>('member');
  const isPm = project.memberships.some((m) => m.state === 'active' && m.role === 'pm' && project.myRoles.includes('pm'));
  if (!isPm || !['draft', 'planned', 'active'].includes(project.status)) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () => api.post(`/projects/${project.id}/handover`, { email, outgoingRole }),
      (r) => ((r as { delivered?: boolean }).delivered === false ? 'The email was not sent. Send again.' : `Handover sent to ${email}. You stay Project Manager until they accept.`),
    );
    if (ok) {
      setOpen(false);
      setEmail('');
    }
  }
  return (
    <section aria-labelledby="handover-heading">
      <h2 id="handover-heading">Hand over</h2>
      {open ? (
        <form className="panel stack" onSubmit={submit} aria-label="Hand over the project">
          <label>
            Work email of the new Project Manager
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Your role afterwards
            <select value={outgoingRole} onChange={(e) => setOutgoingRole(e.target.value as 'deputy_pm' | 'member' | 'leave')}>
              <option value="deputy_pm">Deputy Project Manager</option>
              <option value="member">Member</option>
              <option value="leave">Leave the project</option>
            </select>
          </label>
          <div className="decision">
            <button className="primary">Send handover</button>
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          <p className="meta">They accept through an emailed link that expires in seven days. Until then you remain Project Manager.</p>
        </form>
      ) : (
        <button onClick={() => setOpen(true)}>Hand over the project</button>
      )}
    </section>
  );
}

/** Audit and Oversight access: managers record, decide and manage it; a holder sees their own. */
export function GrantsSection({ project, act }: { project: Project; act: Act }) {
  const manager = canManageGrants(project.myRoles, project.isAdmin);
  const [recording, setRecording] = useState(false);
  if (!manager && project.grants.length === 0) return null;
  return (
    <section aria-labelledby="grants-heading">
      <div className="row">
        <h2 id="grants-heading">Audit and Oversight access</h2>
        {manager && (
          <button className="quiet" onClick={() => setRecording((r) => !r)} aria-expanded={recording}>
            {recording ? 'Close' : 'Record a request'}
          </button>
        )}
      </div>
      <p className="meta">Read-only access for a set period: 30 days by default, at most 90 at a time. Someone other than the person who recorded the request approves it.</p>
      {recording && <GrantRequestForm project={project} act={act} onDone={() => setRecording(false)} />}
      {project.grants.length === 0 ? (
        <p className="meta">No requests yet.</p>
      ) : (
        <ul className="list">
          {project.grants.map((g) => (
            <GrantRow key={g.id} g={g} manager={manager} act={act} />
          ))}
        </ul>
      )}
    </section>
  );
}

function GrantRequestForm({ project, act, onDone }: { project: Project; act: Act; onDone: () => void }) {
  const people = project.memberships.filter((m) => m.state !== 'revoked');
  const unique = [...new Map(people.map((m) => [m.userId, m])).values()];
  const [userId, setUserId] = useState('');
  const [kind, setKind] = useState<GrantKind>('audit');
  const [purpose, setPurpose] = useState('');
  const [scope, setScope] = useState('Read the project, its people, history, notes and proposals');
  const [startsOn, setStartsOn] = useState(todayUtc8());
  const [expiresOn, setExpiresOn] = useState(plusDays(todayUtc8(), 30));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await act(() => api.post(`/projects/${project.id}/grants`, { userId, kind, purpose, scope, startsOn, expiresOn }), 'Request recorded. Another manager now approves or declines it.')) onDone();
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Record an access request">
      <p className="meta">Access is for a person who already has an account; choose from the project's people.</p>
      <div className="grid-2">
        <label>
          Person
          <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a person</option>
            {unique.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName} ({m.email})
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as GrantKind)}>
            <option value="audit">Audit</option>
            <option value="oversight">Oversight</option>
          </select>
        </label>
        <label>
          Starts on
          <input type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label>
          Ends on
          <input type="date" required value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
      </div>
      <label>
        Purpose
        <input required maxLength={2000} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </label>
      <label>
        Requested scope
        <input required maxLength={2000} value={scope} onChange={(e) => setScope(e.target.value)} />
      </label>
      <div className="decision">
        <button className="primary">Record request</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function GrantRow({ g, manager, act }: { g: Grant; manager: boolean; act: Act }) {
  const [mode, setMode] = useState<'none' | 'decline' | 'extend' | 'suspend' | 'restore' | 'revoke'>('none');
  const [date, setDate] = useState(g.expiresOn);
  const post = (path: string, body: object, done: string) => act(() => api.post(`/grants/${g.id}/${path}`, body), done);
  const reasoned = (path: string, button: string, done: string) => (
    <ReasonForm
      label="Reason"
      button={button}
      onCancel={() => setMode('none')}
      onSubmit={async (reason) => {
        const ok = await post(path, { reason }, done);
        if (ok) setMode('none');
        return ok;
      }}
    />
  );
  return (
    <li>
      <div>
        <strong>{g.user.displayName}</strong> · {accessLabel(g.kind)} · <span className="badge badge-pending">{grantStateLabel(g.state)}</span>
        <span className="meta">
          {' '}
          {g.startsOn} to {g.expiresOn}. Purpose: {g.purpose}. Scope: {g.scope}. Recorded by {g.requestedBy}
          {g.decidedBy ? `; decided by ${g.decidedBy}` : ''}.
        </span>
      </div>
      {manager && mode === 'none' && (
        <div className="decision">
          {g.state === 'requested' && (
            <>
              <button onClick={() => void post('approve', {}, 'Approved.')}>Approve</button>
              <button onClick={() => setMode('decline')}>Decline</button>
            </>
          )}
          {['scheduled', 'active', 'expired', 'suspended'].includes(g.state) && <button onClick={() => setMode('extend')}>Extend</button>}
          {['scheduled', 'active'].includes(g.state) && <button onClick={() => setMode('suspend')}>Suspend</button>}
          {g.state === 'suspended' && <button onClick={() => setMode('restore')}>Restore</button>}
          {g.state !== 'revoked' && g.state !== 'declined' && <button className="reject" onClick={() => setMode('revoke')}>Revoke</button>}
        </div>
      )}
      {mode === 'decline' && reasoned('decline', 'Decline', 'Declined.')}
      {mode === 'suspend' && reasoned('suspend', 'Suspend', 'Suspended.')}
      {mode === 'restore' && reasoned('restore', 'Restore', 'Restored.')}
      {mode === 'revoke' && reasoned('revoke', 'Revoke', 'Revoked.')}
      {mode === 'extend' && (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post('extend', { expiresOn: date }, 'Extended.')) setMode('none');
          }}
        >
          <label>
            New end <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button className="primary">Save</button>
          <button type="button" onClick={() => setMode('none')}>Cancel</button>
        </form>
      )}
    </li>
  );
}

export const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
