import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Project, type ProjectSummary } from '../api.ts';
import { type Readiness, closureSummary } from '../changes.ts';
import { OUTCOME_LABEL, type ClosureOutcome } from '../projects.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

type Kind = 'task' | 'question' | 'risk';
interface Disposition {
  disposition: string;
  reason: string;
  affectsDelivery: boolean;
  handoverProjectId: string | null;
  chosenBy: string;
}
interface Item {
  id: string;
  disposition: Disposition | null;
  pendingRequest: { id: string; kind: string; batchId: string | null } | null;
  /** Why the item still stops Close, as the server words it (for example a declined hand-over and its reason). */
  why: string | null;
  title?: string;
  depth?: number;
  status: string;
  dueOn?: string;
  text?: string;
  description?: string;
  severity?: string;
  reviewOn?: string | null;
}
export interface ClosureView {
  items: { tasks: Item[]; questions: Item[]; risks: Item[] };
  readiness: Readiness & { deliveredAllowed: boolean };
  delegation: { pm: string; pmUserId: string; by: string; reason: string; at: string } | null;
  mayPrepare: boolean;
}

const CHOICES: Record<Kind, Array<[string, string]>> = {
  task: [['cancel', 'Cancel it'], ['keep', 'Keep it outstanding']],
  question: [['resolve', 'Resolve it at closure'], ['withdraw', 'Withdraw it'], ['unresolved', 'Leave it unresolved']],
  risk: [['handover', 'Hand it over to another project'], ['final_accept', 'Final acceptance: no further review required']],
};
const CHOICE_LABEL = (kind: Kind, d: string) => CHOICES[kind].find(([v]) => v === d)?.[1] ?? d;

/** The Closing screen: a disposition for every open item, who may close, and the Close form itself. */
export function Closing({ project, act }: { project: Project; act: (work: () => Promise<unknown>, done: string) => Promise<boolean> }) {
  const [view, setView] = useState<ClosureView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [targets, setTargets] = useState<Array<{ id: string; name: string }>>([]);
  const base = `#/projects/${project.id}`;

  const load = useCallback(() => {
    api.get<ClosureView>(`/projects/${project.id}/closure`).then(setView, (e) => setError(errText(e)));
  }, [project.id]);
  useEffect(load, [load]);
  useEffect(() => {
    api.get<{ projects: ProjectSummary[] }>('/projects').then(
      (r) => setTargets(r.projects.filter((p) => p.status === 'active' && p.id !== project.id).map((p) => ({ id: p.id, name: p.name }))),
      () => setTargets([]),
    );
  }, [project.id]);

  /** Runs one change here; the server's refusal is shown as it was written. */
  async function run(work: () => Promise<unknown>, done: string): Promise<boolean> {
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      load();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  }

  const isOwnerOrSponsor = project.myRoles.some((r) => r === 'owner' || r === 'sponsor');
  const isPm = project.myRoles.includes('pm');

  return (
    <>
      <p><a href={base}>Back to the project overview</a></p>
      <h2>Closing {project.name}</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {!view && !error && <p className="loading">Loading</p>}
      {view && (
        <>
          <p role="status" className={view.readiness.ready ? 'ok' : 'meta'}>{closureSummary(view.readiness)}</p>
          {!view.mayPrepare && (
            <p className="meta">
              You can read the closing list. Only an Owner or Sponsor, or the Project Manager when they have allowed it, can prepare the closure.
            </p>
          )}
          {view.delegation && (
            <p className="meta">
              {view.delegation.pm} may prepare and close this project. Allowed by {view.delegation.by}: {view.delegation.reason}
            </p>
          )}
          {isOwnerOrSponsor && <DelegationControl project={project} view={view} run={run} />}

          <ItemSection title="Tasks" kind="task" items={view.items.tasks} view={view} project={project} run={run} targets={targets} />
          <ItemSection title="Questions" kind="question" items={view.items.questions} view={view} project={project} run={run} targets={targets} />
          <ItemSection title="Risks" kind="risk" items={view.items.risks} view={view} project={project} run={run} targets={targets} />

          {view.readiness.missing.length > 0 && (
            <details>
              <summary>What is still missing ({view.readiness.missing.length})</summary>
              <ul className="plain">
                {view.readiness.missing.map((m) => (
                  <li key={`${m.kind}:${m.id}`}>{m.why}</li>
                ))}
              </ul>
            </details>
          )}

          {view.mayPrepare && (isOwnerOrSponsor || isPm) && <CloseForm project={project} view={view} act={act} />}
        </>
      )}
    </>
  );
}

export function DelegationControl({ project, view, run }: { project: Project; view: ClosureView; run: (w: () => Promise<unknown>, d: string) => Promise<boolean> }) {
  const [reason, setReason] = useState('');
  if (view.delegation) {
    return (
      <button onClick={() => void run(() => api.post(`/projects/${project.id}/closure/delegation/revoke`), 'The Project Manager can no longer close this project.')}>
        Take back the Project Manager's permission to close
      </button>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api.post(`/projects/${project.id}/closure/delegation`, { reason }), 'The Project Manager can now prepare and close this project.')) setReason('');
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Let the PM close this project">
      <label>
        Reason for letting the Project Manager close this project
        <input required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button>Let the PM close this project</button>
    </form>
  );
}

function ItemSection(props: {
  title: string;
  kind: Kind;
  items: Item[];
  view: ClosureView;
  project: Project;
  run: (w: () => Promise<unknown>, d: string) => Promise<boolean>;
  targets: Array<{ id: string; name: string }>;
}) {
  const { title, kind, items } = props;
  const heading = `closing-${kind}`;
  return (
    <section aria-labelledby={heading}>
      <h3 id={heading}>{title}</h3>
      {items.length === 0 ? (
        <p className="meta">Nothing open.</p>
      ) : (
        <ul className="plain">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} {...props} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemRow({ item, kind, view, project, run, targets }: { item: Item; kind: Kind; view: ClosureView; project: Project; run: (w: () => Promise<unknown>, d: string) => Promise<boolean>; targets: Array<{ id: string; name: string }> }) {
  const current = item.disposition;
  const [editing, setEditing] = useState(false);
  const label = kind === 'task' ? item.title : kind === 'question' ? item.text : item.description;
  const target = current?.handoverProjectId ? targets.find((t) => t.id === current.handoverProjectId)?.name : undefined;
  return (
    <li className="panel" style={kind === 'task' && item.depth ? { marginLeft: `${item.depth * 1.5}rem` } : undefined}>
      <p><strong>{label}</strong></p>
      <p className="meta">
        {kind === 'task' && `${item.status}${item.dueOn ? `, due ${item.dueOn}` : ''}`}
        {kind === 'question' && item.status}
        {kind === 'risk' && `${item.status}, ${item.severity}${item.reviewOn ? `, review ${item.reviewOn}` : ''}`}
      </p>
      {current ? (
        <p>
          <span className="ok">{CHOICE_LABEL(kind, current.disposition)}</span>
          {target ? ` (${target})` : ''}
          {current.affectsDelivery ? ' (affects delivery acceptance)' : ''}: {current.reason}
        </p>
      ) : (
        <p className="warn">Needs a disposition.</p>
      )}
      {item.pendingRequest && (
        <p className="meta" role="status">A request for this is waiting for authorisation. Choosing again withdraws it.</p>
      )}
      {current && !item.pendingRequest && item.why && (
        <p className="warn" role="status">{item.why}</p>
      )}
      {view.mayPrepare && !editing && <button onClick={() => setEditing(true)}>{current ? 'Change the disposition' : 'Choose a disposition'}</button>}
      {view.mayPrepare && editing && (
        <DispositionForm
          kind={kind}
          item={item}
          projectId={project.id}
          targets={targets}
          run={run}
          onDone={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function DispositionForm({ kind, item, projectId, targets, run, onDone }: { kind: Kind; item: Item; projectId: string; targets: Array<{ id: string; name: string }>; run: (w: () => Promise<unknown>, d: string) => Promise<boolean>; onDone: () => void }) {
  const [disposition, setDisposition] = useState(item.disposition?.disposition ?? '');
  const [reason, setReason] = useState(item.disposition?.reason ?? '');
  const [affects, setAffects] = useState(item.disposition?.affectsDelivery ?? false);
  const [handover, setHandover] = useState(item.disposition?.handoverProjectId ?? '');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api.post(`/projects/${projectId}/closure/dispositions`, {
          recordKind: kind,
          recordId: item.id,
          disposition,
          reason,
          ...(kind === 'question' && disposition === 'unresolved' ? { affectsDelivery: affects } : {}),
          ...(kind === 'risk' && disposition === 'handover' ? { handoverProjectId: handover } : {}),
        }),
      'Saved.',
    );
    if (ok) onDone();
  }
  const reasonLabel = disposition === 'resolve' ? 'Note' : 'Reason';
  return (
    <form className="change-form stack" onSubmit={submit} aria-label="Choose a disposition">
      <label>
        What should happen
        <select required value={disposition} onChange={(e) => setDisposition(e.target.value)}>
          <option value="">Choose</option>
          {CHOICES[kind].map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </label>
      {kind === 'risk' && disposition === 'handover' && (
        <label>
          Hand it over to
          <select required value={handover} onChange={(e) => setHandover(e.target.value)}>
            <option value="">Choose an Active project</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {targets.length === 0 && <span className="hint">There is no other Active project you can see.</span>}
        </label>
      )}
      {kind === 'question' && disposition === 'unresolved' && (
        <label className="check">
          <input type="checkbox" checked={affects} onChange={(e) => setAffects(e.target.checked)} />
          This affects delivery acceptance
        </label>
      )}
      {kind === 'task' && disposition === 'cancel' && (
        <p className="meta">Cancelling is a request, authorised under the approval count, and Close waits until it is.</p>
      )}
      <label>
        {reasonLabel}
        <textarea required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="decision">
        <button className="primary">Save</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/** The Close form: the outcome, with Delivered offered only when the server says it may be, and the objectives tick. */
function CloseForm({ project, view, act }: { project: Project; view: ClosureView; act: (w: () => Promise<unknown>, d: string) => Promise<boolean> }) {
  const [outcome, setOutcome] = useState<ClosureOutcome | ''>('');
  const [reason, setReason] = useState('');
  const [met, setMet] = useState(false);
  const allowed = view.readiness.deliveredAllowed;
  const outcomes: ClosureOutcome[] = project.status === 'planned' ? ['abandoned'] : ['delivered', 'partially_delivered', 'abandoned'];
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      () => api.post(`/projects/${project.id}/transition`, { to: 'closed', outcome, reason, objectivesMet: outcome === 'delivered' && met }),
      'The project is closed.',
    );
    if (ok) window.location.hash = `#/projects/${project.id}`;
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label="Close the project">
      <h3>Close the project</h3>
      <fieldset>
        <legend>Outcome</legend>
        {outcomes.map((o) => {
          const blocked = o === 'delivered' && !allowed;
          return (
            <label key={o} className="choice">
              <input type="radio" name="outcome" value={o} required disabled={blocked} checked={outcome === o} onChange={() => setOutcome(o)} aria-describedby={blocked ? 'delivered-why' : undefined} />
              {OUTCOME_LABEL[o]}
            </label>
          );
        })}
        {!allowed && outcomes.includes('delivered') && (
          <p id="delivered-why" className="meta">Delivered is not available while a task is kept outstanding or a question left unresolved affects delivery acceptance. It also needs the objectives confirmed as met.</p>
        )}
      </fieldset>
      {outcome === 'delivered' && (
        <label className="check">
          <input type="checkbox" required checked={met} onChange={(e) => setMet(e.target.checked)} />
          The agreed objectives were met
        </label>
      )}
      <label>
        Reason
        <textarea required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="decision">
        <button className="primary" disabled={!view.readiness.ready}>Close</button>
        {!view.readiness.ready && <span className="meta">{closureSummary(view.readiness)}</span>}
      </div>
    </form>
  );
}
