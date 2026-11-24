import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { waitingRequestsText } from '../changes.ts';
import { formatWhen } from '../format.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { SettingsPage } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface HistoryRow {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
  pendingChoice: string | null;
  actor: string;
  at: string;
}
interface OrgPolicy {
  required: number;
  projectsMayOverride: boolean;
  history: HistoryRow[];
}
interface ProjectPolicy {
  effective: number;
  own: number | null;
  mayEdit: boolean;
  history: HistoryRow[];
}

const FIELD: Record<string, string> = { required: 'Approvals needed', projects_may_override: 'Projects may set their own count', projectsMayOverride: 'Projects may set their own count' };
const fieldLabel = (f: string) => FIELD[f] ?? f;

/** Choose to keep or restart the requests already waiting. Keep is preselected. */
function PendingChoice({ pending, value, onChange }: { pending: number | null; value: 'keep' | 'restart'; onChange: (v: 'keep' | 'restart') => void }) {
  return (
    <fieldset>
      <legend>Requests already waiting</legend>
      <p className="meta" role="status">{waitingRequestsText(pending)}</p>
      <label className="choice">
        <input type="radio" name="pending" checked={value === 'keep'} onChange={() => onChange('keep')} />
        Keep them as they are, with the approvals they have
      </label>
      <label className="choice">
        <input type="radio" name="pending" checked={value === 'restart'} onChange={() => onChange('restart')} />
        Restart them, so they need the new count from the beginning
      </label>
    </fieldset>
  );
}

function historyText(h: HistoryRow): string {
  return `${fieldLabel(h.field)} from ${h.oldValue ?? 'not set'} to ${h.newValue ?? 'not set'}${h.pendingChoice ? ` (waiting requests: ${h.pendingChoice === 'keep' ? 'kept' : 'restarted'})` : ''}`;
}

const HISTORY_COLUMNS: Column<HistoryRow>[] = [
  { key: 'when', header: 'When', sortValue: (h) => h.at, cell: (h) => formatWhen(h.at) },
  { key: 'who', header: 'Who', sortValue: (h) => h.actor.toLowerCase(), cell: (h) => h.actor },
  { key: 'what', header: 'What changed', cell: (h) => historyText(h) },
  { key: 'reason', header: 'Reason', cell: (h) => h.reason },
];

/** The form for the organisation's count and the override switch; it starts from what is in force each time it opens. */
function ApprovalForm({ policy, impact, onSaved }: { policy: OrgPolicy; impact: number | null; onSaved: () => void }) {
  const [required, setRequired] = useState(policy.required);
  const [override, setOverride] = useState(policy.projectsMayOverride);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'keep' | 'restart'>('keep');
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/approval-policy', { required, projectsMayOverride: override, reason, pending });
      onSaved();
    } catch (err) {
      setError(errText(err));
    }
  }

  const unchanged = policy.required === required && policy.projectsMayOverride === override;
  return (
    <form className="stack" onSubmit={save} aria-label="Approval count">
      <label>
        Approvals needed
        <select value={required} onChange={(e) => setRequired(Number(e.target.value))}>
          {[1, 2, 3].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
        Let a project's Owners and Sponsors set their own count
      </label>
      <PendingChoice pending={impact} value={pending} onChange={setPending} />
      <label>
        Reason for the change
        <textarea required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={unchanged}>Save</button>
    </form>
  );
}

/** Settings › Approvals: the organisation's count and the override switch. */
export function ApprovalSettings() {
  const [policy, setPolicy] = useState<OrgPolicy | null>(null);
  const [impact, setImpact] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<OrgPolicy>('/approval-policy').then(setPolicy, (e) => setError(errText(e)));
    api.get<{ pending: number }>('/approval-policy/impact').then((r) => setImpact(r.pending), () => setImpact(null));
  }, []);
  useEffect(load, [load]);

  const header = {
    crumbs: [{ text: 'Settings', href: '#/settings' }],
    title: 'Approvals',
    intro: 'How many Owners or Sponsors must approve a change before it is made.',
  };
  if (!policy) {
    return (
      <main className="page">
        <PageHeader {...header} />
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
      </main>
    );
  }
  const glance = (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <p role="status" className="ok">{notice ?? ''}</p>
      <div className="stat-grid">
        <StatTile label="Approvals needed" value={String(policy.required)} note={policy.required === 1 ? 'One approval is enough' : `${policy.required} people must approve`} />
        <StatTile label="Projects set their own count" value={policy.projectsMayOverride ? 'Allowed' : 'Not allowed'} />
        <StatTile label="Requests waiting" value={impact === null ? 'Not known' : String(impact)} note="Waiting for an approval now" />
      </div>
      <DataTable caption="Change history" columns={HISTORY_COLUMNS} rows={policy.history} rowKey={(h) => h.id} empty="No changes yet." />
    </>
  );
  return (
    <main className="page">
      <SettingsPage
        header={header}
        glance={glance}
        settings={[
          {
            key: 'count',
            title: 'Approval count',
            current: (
              <p>
                {policy.required} {policy.required === 1 ? 'approval' : 'approvals'} needed. Projects {policy.projectsMayOverride ? 'may' : 'may not'} set their own count.
              </p>
            ),
            form: (close) => (
              <ApprovalForm
                policy={policy}
                impact={impact}
                onSaved={() => {
                  setNotice('Saved.');
                  setError(null);
                  load();
                  close();
                }}
              />
            ),
          },
        ]}
      />
    </main>
  );
}

/** Project Overview → Approvals: the project's own count, when the organisation allows it. */
export function ProjectApprovals({ projectId }: { projectId: string }) {
  const [policy, setPolicy] = useState<ProjectPolicy | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'keep' | 'restart'>('keep');

  const load = useCallback(() => {
    api.get<ProjectPolicy>(`/projects/${projectId}/approval-policy`).then(
      (p) => {
        setPolicy(p);
        setChoice(p.own === null ? '' : String(p.own));
      },
      (e) => setError(errText(e)),
    );
    api.get<{ requests: Array<{ status: string }> }>(`/projects/${projectId}/changes?status=pending`).then(
      (r) => setWaiting(r.requests.filter((x) => x.status === 'pending').length),
      () => setWaiting(null),
    );
  }, [projectId]);
  useEffect(load, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.post(`/projects/${projectId}/approval-policy`, { required: choice === '' ? null : Number(choice), reason, pending });
      setReason('');
      setPending('keep');
      setNotice('Saved.');
      load();
    } catch (err) {
      setError(errText(err));
    }
  }

  if (!policy) return error ? <p role="alert" className="error">{error}</p> : null;
  return (
    <section aria-labelledby="project-approvals">
      <h2 id="project-approvals">Approvals</h2>
      <p>
        Changes in this project need {policy.effective} {policy.effective === 1 ? 'approval' : 'approvals'}
        {policy.own === null ? ', as set for the organisation.' : ', as set for this project.'}
      </p>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="ok">{notice}</p>}
      {policy.mayEdit && (
        <form className="panel stack" onSubmit={save} aria-label="Approvals for this project">
          <label>
            Approvals needed in this project
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Use the organisation's count</option>
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <PendingChoice pending={waiting} value={pending} onChange={setPending} />
          <label>
            Reason for the change
            <textarea required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="primary">Save</button>
        </form>
      )}
      {policy.history.length > 0 && (
        <details>
          <summary>Change history ({policy.history.length})</summary>
          <ul className="plain">
            {policy.history.map((h) => (
              <li key={h.id}>
                {formatWhen(h.at)}: {h.actor} changed the count from {h.oldValue ?? 'the organisation count'} to {h.newValue ?? 'the organisation count'} — {h.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
