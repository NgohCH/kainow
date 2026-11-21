import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatDay, formatWhen } from '../format.ts';
import { OUTPUT_EVENT_TEXT } from '../history.ts';
import {
  type AffectedPerson, APPROVAL_NOTICE, FILE_ACTION_LABEL, type FileAction, type OpenRefusal, type OutputDetail, type OutputSummary, type OutputVersion, audiencePreviewText,
  checkLabel, fileAccess, filingLabel, formatLabel, mayAskApproval, mayFile, openRefusal, originLabel, outputStatusLabel, versionStatusLabel,
} from '../outputs.ts';
import type { ProjectRole, ProjectStatus } from '../projects.ts';
import { sizeLabel } from '../storage.ts';
import { ChangeRequestPanel, useRequests } from './ChangeRequest.tsx';
import { useReportTypes, useReturnFocus } from './ProjectOutputSettings.tsx';
import { ReportSecret } from './ReportSecret.tsx';

/** The project's current people and departments, for contributors and audiences. */
export interface ProjectPeople {
  people: Array<{ userId: string; displayName: string }>;
  departments: Array<{ id: string; name: string }>;
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const OPEN: readonly ProjectStatus[] = ['draft', 'planned', 'active'];
/** A short, readable approval reference: the end of the change request's id (the full id is its tooltip). */
const shortRef = (id: string) => id.replace(/-/g, '').slice(-8).toUpperCase();
const dayText = (day: string | null) => (day ? formatDay(`${day}T00:00:00+08:00`) : 'Not issued yet');

/** One output: summary first, then actions by role, versions, contributors, audience and history (spec 12). */
export function OutputPage({ projectId, outputId, roles, status, people }: {
  projectId: string; outputId: string; roles: ProjectRole[]; status: ProjectStatus; people: ProjectPeople;
}) {
  const [output, setOutput] = useState<OutputDetail | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<null | 'register' | 'edit' | 'decline' | 'withdraw' | 'delete' | 'version' | 'accept' | 'review-clear' | 'review-withdraw'>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const remember = useReturnFocus(mode !== null, heading);
  const openMode = (m: NonNullable<typeof mode>) => {
    remember();
    setMode(m);
  };
  const { requests, reload: reloadRequests } = useRequests(projectId);
  const pmOrDeputy = roles.some((r) => r === 'pm' || r === 'deputy_pm');
  const manages = pmOrDeputy && OPEN.includes(status);
  const mayRequestApproval = pmOrDeputy && (status === 'planned' || status === 'active');

  const load = useCallback(async () => {
    try {
      setOutput(await api.get<OutputDetail>(`/projects/${projectId}/outputs/${outputId}`));
      setGone(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone('This output was not found, or you cannot read it.');
      else setError(errText(e));
    }
    reloadRequests();
  }, [projectId, outputId, reloadRequests]);
  useEffect(() => void load(), [load]);
  const arrived = output !== null;
  useEffect(() => {
    if (arrived) heading.current?.focus();
  }, [arrived]);

  /** Runs one change, then reloads; a result the person can no longer read says so rather than failing. */
  const act = useCallback(
    async (work: () => Promise<unknown>, done: string): Promise<boolean> => {
      setError(null);
      setNotice(null);
      try {
        const r = (await work()) as { readable?: boolean; deleted?: boolean } | undefined;
        setMode(null);
        if (r && r.deleted) {
          setGone(`${done} It no longer appears in the register; the Project Manager or a Deputy can restore it from the Outputs tab.`);
          return true;
        }
        if (r && r.readable === false) {
          setGone(`${done} You are not in its audience, so you can no longer read it.`);
          return true;
        }
        setNotice(done);
        await load();
        return true;
      } catch (e) {
        setError(errText(e));
        return false;
      }
    },
    [load],
  );

  const back = <p><a href={`#/projects/${projectId}/outputs`}>All outputs</a></p>;
  if (gone) return <section aria-label="Output">{back}<p role="status">{gone}</p></section>;
  if (!output) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;

  const base = `/projects/${projectId}/outputs/${outputId}`;
  const approvals = requests.filter((r) => r.kind === 'approve_output' && r.status === 'pending' && r.output?.id === outputId);
  const live = output.status === 'submitted' || output.status === 'registered';

  return (
    <section aria-labelledby="output-heading">
      {back}
      <h2 id="output-heading" tabIndex={-1} ref={heading}>{output.title}</h2>
      <p>
        <strong>{outputStatusLabel(output.status)}</strong>
        {' · '}{output.reportType?.name ?? 'Report type not chosen yet'}
        {output.categories.length > 0 && ` (also ${output.categories.map((c) => c.name).join(', ')})`}
        {' · '}Issue date: {dayText(output.issueDate)}
        {' · '}Author: {output.author.displayName}
        {output.aiAssisted && ' · AI-assisted'}
        {' · '}{output.audience.mode === 'restricted' ? 'Restricted' : 'Project-wide'}
      </p>
      {output.reviewLabel && <p className="warn" role="note">{output.reviewLabel}</p>}
      {output.registeredBy && output.registeredAt && <p className="meta">Registered by {output.registeredBy.displayName}, {formatWhen(output.registeredAt)}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {error && <p role="alert" className="error">{error}</p>}

      <div className="actions">
        {output.may.register && <button type="button" className="primary" onClick={() => openMode('register')}>Register</button>}
        {output.may.decline && <button type="button" onClick={() => openMode('decline')}>Decline</button>}
        {output.may.register && <button type="button" onClick={() => openMode('accept')}>Add to an existing output</button>}
        {output.may.update && output.status === 'registered' && <button type="button" onClick={() => openMode('edit')}>Edit details</button>}
        {output.may.addVersion && <button type="button" onClick={() => openMode('version')}>Add a new version</button>}
        {output.may.review && <button type="button" onClick={() => openMode('review-clear')}>Clear the access review</button>}
        {output.may.review && <button type="button" onClick={() => openMode('review-withdraw')}>Withdraw for the access review</button>}
        {manages && live && !output.may.review && <button type="button" onClick={() => openMode('withdraw')}>Withdraw</button>}
        {manages && <button type="button" onClick={() => openMode('delete')}>Delete</button>}
        <ReportSecret projectId={projectId} kind="output" id={outputId} label={`output “${output.title}”`} onReported={() => void load()} />
      </div>

      {(mode === 'register' || mode === 'edit') && (
        <RegisterForm output={output} people={people} edit={mode === 'edit'} onCancel={() => setMode(null)}
          onSubmit={(body) => act(() => (mode === 'edit' ? api.put(base, body) : api.post(`${base}/register`, body)), mode === 'edit' ? 'The details were saved.' : 'Registered. It is not filed or approved yet.')} />
      )}
      {mode === 'decline' && <ReasonForm title="Decline this submission" button="Decline" hint="The submitter still sees it, marked Declined. Nothing is deleted." onCancel={() => setMode(null)} onSubmit={(reason) => act(() => api.post(`${base}/decline`, { reason }), 'Declined.')} />}
      {mode === 'withdraw' && <ReasonForm title="Withdraw this output" button="Withdraw" hint="Withdrawn is final. Its files move to the output's own folder, which nobody is given access to. They are not deleted." onCancel={() => setMode(null)} onSubmit={(reason) => act(() => api.post(`${base}/withdraw`, { reason }), 'Withdrawn.')} />}
      {mode === 'delete' && <ReasonForm title="Delete this register entry" button="Delete" hint="The entry leaves the register and search. Its files in storage are never deleted. It can be restored." onCancel={() => setMode(null)} onSubmit={(reason) => act(() => api.post(`${base}/delete`, { reason }), 'Deleted.')} />}
      {mode === 'review-clear' && <ReasonForm title="Clear the access review" button="Clear the review" hint="The output goes back to its audience and is shared with them again." onCancel={() => setMode(null)} onSubmit={(reason) => act(() => api.post(`${base}/review/clear`, { reason }), 'The access review was cleared.')} />}
      {mode === 'review-withdraw' && <ReasonForm title="Withdraw the output" button="Withdraw" hint="Withdrawn is final. Its files stay in storage, shared with nobody." onCancel={() => setMode(null)} onSubmit={(reason) => act(() => api.post(`${base}/review/withdraw`, { reason }), 'Withdrawn.')} />}
      {mode === 'version' && <AddVersionForm base={base} onCancel={() => setMode(null)} act={act} />}
      {mode === 'accept' && <AcceptIntoForm projectId={projectId} outputId={outputId} onCancel={() => setMode(null)} act={act} />}

      <h3>Versions</h3>
      {output.versions.length === 0 ? (
        <p className="meta">No versions.</p>
      ) : (
        <table className="table outputs-table">
          <caption className="visually-hidden">Versions of {output.title}</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Filing</th>
              <th scope="col">Check</th>
              <th scope="col">Approval</th>
              <th scope="col">File</th>
            </tr>
          </thead>
          <tbody>
            {output.versions.map((v) => (
              <VersionRow
                key={v.no}
                v={v}
                base={base}
                manages={manages && output.status === 'registered'}
                mayRequestApproval={mayRequestApproval && output.status === 'registered' && !approvals.some((r) => r.output?.versionNo === v.no)}
                approvalPending={approvals.some((r) => r.output?.versionNo === v.no)}
                act={act}
              />
            ))}
          </tbody>
        </table>
      )}

      {approvals.length > 0 && (
        <section aria-labelledby="output-approvals">
          <h3 id="output-approvals" tabIndex={-1}>Waiting for approval</h3>
          {approvals.map((r) => (
            <ChangeRequestPanel key={`${r.id}:${r.version}`} request={r} projectId={projectId} onChanged={(m) => { setNotice(m); void load(); }} />
          ))}
        </section>
      )}

      <h3>Contributors</h3>
      {output.contributors.people.length === 0 && output.contributors.departments.length === 0 ? (
        <p className="meta">Only the author ({output.author.displayName}).</p>
      ) : (
        <ul className="plain">
          {output.contributors.people.map((p) => <li key={p.id}>{p.displayName}{p.departmentName ? `, ${p.departmentName}` : ''}</li>)}
          {output.contributors.departments.map((d) => <li key={d.id}>{d.name} (department)</li>)}
        </ul>
      )}

      <AudienceSection output={output} base={base} people={people} act={act} />

      <h3>History</h3>
      <ol className="plain">
        {output.history.map((h, i) => (
          <li key={i}>
            {formatWhen(h.at)} — This output {OUTPUT_EVENT_TEXT[h.kind] ?? `had an event (${h.kind.replace(/_/g, ' ')})`}{h.versionNo ? ` (version ${h.versionNo})` : ''}
            {h.actor ? ` by ${h.actor.displayName}` : ''}
            {h.reason ? ` — "${h.reason}"` : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}

type Act = (work: () => Promise<unknown>, done: string) => Promise<boolean>;

/** One version: status, filing, check (with time), approval, Open and (for a filed file) Download, and what the PM or a Deputy can do. */
function VersionRow({ v, base, manages, mayRequestApproval, approvalPending, act }: {
  v: OutputVersion; base: string; manages: boolean; mayRequestApproval: boolean; approvalPending: boolean; act: Act;
}) {
  const [refusal, setRefusal] = useState<OpenRefusal | null>(null);
  const [opening, setOpening] = useState(false);
  const [mode, setMode] = useState<null | 'approval' | 'relink'>(null);
  const [url, setUrl] = useState('');
  const remember = useReturnFocus(mode !== null);
  const f = v.filing;
  const path = `${base}/versions/${v.no}`;
  const access = fileAccess(f.state);
  const hasFile = access.open;

  /** Open goes through Kainow: a quick check, then the file itself; a Changed, Missing or Access denied file is shown instead. */
  async function open() {
    setOpening(true);
    setRefusal(null);
    try {
      const res = await fetch(api.url(`${path}/open`), { credentials: 'same-origin', redirect: 'manual' });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        window.location.assign(api.url(`${path}/open`));
        return;
      }
      const body = await res.json().catch(() => null);
      setRefusal(openRefusal(body) ?? { state: 'error', label: (body as { message?: string } | null)?.message ?? 'The file could not be opened.', actions: [] });
    } catch {
      setRefusal({ state: 'error', label: 'Cannot reach the Kainow server. Try again.', actions: [] });
    } finally {
      setOpening(false);
    }
  }

  const actions: FileAction[] = [...new Set([...(f.actions ?? []), ...(refusal?.actions ?? [])])].filter(() => manages);
  return (
    <tr>
      <td data-label="Version">
        Version {v.no}
        <span className="meta"> · {originLabel(v.origin)} · {formatLabel(v.format)} · {sizeLabel(v.sizeBytes)} · {v.createdBy.displayName}, {formatWhen(v.createdAt)}</span>
      </td>
      <td data-label="Status">{versionStatusLabel(v.status)}</td>
      <td data-label="Filing">
        {f.label || filingLabel(f.state)}
        {f.location && <span className="hint">{f.location}</span>}
        {f.destination && <span className="hint">In {f.destination}</span>}
        {f.path && <span className="hint path">{f.path}</span>}
        {f.sharing && <span className="hint">{f.sharing}</span>}
        {manages && mayFile(v) && (
          <button type="button" className="link-button" onClick={() => void act(() => api.post(`${path}/file`), 'Filing was requested. The register shows when it is filed.')}>
            {f.state === 'failed' ? 'Try again' : 'File it'}<span className="visually-hidden"> (version {v.no})</span>
          </button>
        )}
      </td>
      <td data-label="Check">
        {hasFile ? checkLabel(f.checkStatus, f.lastCheckedAt, v.status) : '—'}
        {f.recovery && <span className="hint">{f.recovery}</span>}
        {f.registering && <span className="hint">{f.registering}</span>}
        {f.registerFailed && <span className="warn inline">{f.registerFailed}</span>}
      </td>
      <td data-label="Approval">
        {approvalPending ? (
          <button type="button" className="link-button" onClick={() => { const h = document.getElementById('output-approvals'); h?.scrollIntoView(); h?.focus(); }}>Approval requested — waiting</button>
        ) : v.approvalRequestId ? (
          <>
            {v.status === 'approved' ? 'Approved' : 'Was approved'} — request <span title={v.approvalRequestId}>{shortRef(v.approvalRequestId)}</span>
          </>
        ) : (
          '—'
        )}
        {mayRequestApproval && mayAskApproval(v) && mode !== 'approval' && (
          <button type="button" className="link-button" onClick={() => { remember(); setMode('approval'); }}>Ask for approval<span className="visually-hidden"> of version {v.no}</span></button>
        )}
        {mode === 'approval' && (
          <div className="panel stack" role="group" aria-label={`Ask for approval of version ${v.no}`}>
            <p>An Owner or Sponsor approves this exact version under the project's approval policy.</p>
            <p className="warn" role="note">{APPROVAL_NOTICE}</p>
            <div className="actions">
              <button type="button" className="primary" autoFocus onClick={() => void act(() => api.post(`${path}/approval`), 'Approval was requested.').then((ok) => ok && setMode(null))}>Ask for approval</button>
              <button type="button" onClick={() => setMode(null)}>Cancel</button>
            </div>
          </div>
        )}
      </td>
      <td data-label="File">
        <div className="actions">
          {hasFile && <button type="button" onClick={() => void open()} disabled={opening}>Open<span className="visually-hidden"> version {v.no}</span></button>}
          {access.download && <a href={api.url(`${path}/download`)} download>Download a copy<span className="visually-hidden"> of version {v.no}</span></a>}
        </div>
        {refusal && <p className="warn" role="alert">{refusal.label}</p>}
        {actions.includes('register_changed') && (
          <button type="button" className="link-button" onClick={() => void act(() => api.post(`${path}/register-changed`), 'Kainow is registering the changed file as a new version.')}>
            {FILE_ACTION_LABEL.register_changed}
          </button>
        )}
        {actions.includes('relink') && mode !== 'relink' && (
          <button type="button" className="link-button" onClick={() => { remember(); setMode('relink'); }}>{FILE_ACTION_LABEL.relink}</button>
        )}
        {actions.includes('add_version') && <span className="hint">Or add a new version from a fresh upload.</span>}
        {mode === 'relink' && (
          <form
            className="stack"
            aria-label={`Relink version ${v.no}`}
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => api.post(`${path}/relink`, url.trim() ? { url: url.trim() } : {}), 'The file was relinked.').then((ok) => ok && setMode(null));
            }}
          >
            <label>
              Link to where the file is now <span className="hint">Leave empty to relink the same file where Kainow finds it.</span>
              <input type="url" maxLength={2048} value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <div className="actions">
              <button className="primary">Relink</button>
              <button type="button" onClick={() => setMode(null)}>Cancel</button>
            </div>
          </form>
        )}
      </td>
    </tr>
  );
}

/** A form with one required reason, focus placed in it, Escape closes it. */
function ReasonForm({ title, button, hint, onSubmit, onCancel }: { title: string; button: string; hint: string; onSubmit: (reason: string) => Promise<boolean>; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const uid = useId();
  return (
    <form
      className="panel stack"
      aria-labelledby={`${uid}-t`}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(reason);
      }}
    >
      <h3 id={`${uid}-t`}>{title}</h3>
      <p className="hint">{hint}</p>
      <label>
        Reason <input required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="actions">
        <button className="primary">{button}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Registering (or later editing): title, report type, categories, issue date, contributors and, when registering, the audience (spec 4.2). */
function RegisterForm({ output, people, edit, onSubmit, onCancel }: {
  output: OutputDetail; people: ProjectPeople; edit: boolean; onSubmit: (body: Record<string, unknown>) => Promise<boolean>; onCancel: () => void;
}) {
  const types = useReportTypes();
  const uid = useId();
  const [allDepartments, setAllDepartments] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    api.get<{ departments: Array<{ id: string; name: string; status: string }> }>('/departments').then(
      (r) => setAllDepartments(r.departments.filter((d) => d.status === 'active')),
      () => setAllDepartments([]),
    );
  }, []);
  const [title, setTitle] = useState(output.title);
  const [typeId, setTypeId] = useState(output.reportType?.id ?? '');
  const [categories, setCategories] = useState<string[]>(output.categories.map((c) => c.id));
  const [issueDate, setIssueDate] = useState(output.issueDate ?? '');
  // Each contributing person with the department recorded for them (a saved contributor keeps theirs as the default).
  const [personDepts, setPersonDepts] = useState<Record<string, string>>(
    Object.fromEntries(output.contributors.people.map((p) => [p.id, p.departmentId ?? ''])),
  );
  const [departmentIds, setDepartmentIds] = useState<string[]>(output.contributors.departments.map((d) => d.id));
  const [audienceMode, setAudienceMode] = useState<'project' | 'restricted'>(output.audience.mode);
  const [audiencePeople, setAudiencePeople] = useState<string[]>(output.audience.people.map((p) => p.id));
  const [reason, setReason] = useState('');
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const knownPeople = [
    ...people.people,
    ...output.contributors.people.filter((p) => !people.people.some((x) => x.userId === p.id)).map((p) => ({ userId: p.id, displayName: p.displayName })),
  ].filter((p) => p.userId !== output.author.id);
  // Every active department, the project's own first (then any already recorded that is no longer active).
  const own = new Set(people.departments.map((d) => d.id));
  const departments = [
    ...people.departments,
    ...allDepartments.filter((d) => !own.has(d.id)).sort((a, b) => a.name.localeCompare(b.name)),
    ...[...output.contributors.departments, ...output.contributors.people.filter((p) => p.departmentId).map((p) => ({ id: p.departmentId as string, name: p.departmentName ?? 'A department' }))]
      .filter((d, i, all) => !own.has(d.id) && !allDepartments.some((x) => x.id === d.id) && all.findIndex((x) => x.id === d.id) === i),
  ];
  const chosenPeople = Object.keys(personDepts);
  return (
    <form
      className="panel stack"
      aria-labelledby={`${uid}-h`}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({
          title,
          reportTypeId: typeId,
          categoryIds: categories.filter((c) => c !== typeId),
          ...(issueDate ? { issueDate } : {}),
          contributors: { people: chosenPeople.map((userId) => ({ userId, departmentId: personDepts[userId] })), departmentIds },
          ...(!edit ? { audience: { mode: audienceMode, namedUserIds: audienceMode === 'restricted' ? audiencePeople : [] } } : {}),
          ...(edit && reason.trim() ? { reason } : {}),
        });
      }}
    >
      <h3 id={`${uid}-h`}>{edit ? 'Edit the details' : 'Register this output'}</h3>
      {!edit && <p className="hint">Registering does not file or approve it. File each version afterwards, then ask for approval.</p>}
      <label>
        Title <input required autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Report type
        <select required value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          <option value="">Choose a report type</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Also list under <span className="hint">Optional categories, for finding it later.</span></legend>
        {types.filter((t) => t.id !== typeId).map((t) => (
          <label key={t.id} className="check"><input type="checkbox" checked={categories.includes(t.id)} onChange={() => setCategories((c) => toggle(c, t.id))} /> {t.name}</label>
        ))}
      </fieldset>
      <label>
        Issue date <span className="hint">Today (UTC+8) when left empty. Its year is the filing year.</span>
        <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
      </label>
      <fieldset>
        <legend>Contributing people <span className="hint">{output.author.displayName} is the author. Give each contributor the department they contributed for.</span></legend>
        {knownPeople.length === 0 && <p className="meta">Nobody else in the project.</p>}
        {knownPeople.map((p) => {
          const on = p.userId in personDepts;
          return (
            <div key={p.userId} className="inline-form">
              <label className="check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setPersonDepts((m) => {
                      const next = { ...m };
                      if (on) delete next[p.userId];
                      else next[p.userId] = '';
                      return next;
                    })
                  }
                />{' '}
                {p.displayName}
              </label>
              {on && (
                <label>
                  <span className="visually-hidden">Department of {p.displayName}</span>
                  <select required value={personDepts[p.userId]} onChange={(e) => setPersonDepts((m) => ({ ...m, [p.userId]: e.target.value }))}>
                    <option value="">Choose their department</option>
                    {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </label>
              )}
            </div>
          );
        })}
      </fieldset>
      <fieldset>
        <legend>Contributing departments <span className="hint">The project's own departments are listed first.</span></legend>
        {departments.map((d) => (
          <label key={d.id} className="check"><input type="checkbox" checked={departmentIds.includes(d.id)} onChange={() => setDepartmentIds((c) => toggle(c, d.id))} /> {d.name}</label>
        ))}
      </fieldset>
      {!edit && (
        <fieldset>
          <legend>Who may read it</legend>
          <label className="check"><input type="radio" name={`${uid}-aud`} checked={audienceMode === 'project'} onChange={() => setAudienceMode('project')} /> Project-wide: everyone who may read the project</label>
          <label className="check"><input type="radio" name={`${uid}-aud`} checked={audienceMode === 'restricted'} onChange={() => setAudienceMode('restricted')} /> Restricted: only the people chosen below</label>
          {audienceMode === 'restricted' && people.people.map((p) => (
            <label key={p.userId} className="check"><input type="checkbox" checked={audiencePeople.includes(p.userId)} onChange={() => setAudiencePeople((c) => toggle(c, p.userId))} /> {p.displayName}</label>
          ))}
          <span className="hint">When a version was built from material some people cannot read, only people who can read all of it may be chosen; Kainow refuses anyone else.</span>
        </fieldset>
      )}
      {edit && (
        <label>
          Reason for the change <span className="hint">Optional.</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      <div className="actions">
        <button className="primary">{edit ? 'Save' : 'Register'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** A new version from a file or a link (the output keeps its title). */
function AddVersionForm({ base, act, onCancel }: { base: string; act: Act; onCancel: () => void }) {
  const uid = useId();
  const [how, setHow] = useState<'upload' | 'link'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  return (
    <form
      className="panel stack"
      aria-labelledby={`${uid}-h`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void act(async () => {
          if (how === 'link') return api.post(`${base}/versions`, { kind: 'link', url });
          if (!file) throw new ApiError('Choose the file to upload.', 400);
          const form = new FormData();
          form.append('file', file);
          return api.post(`${base}/versions`, form);
        }, 'A new Draft version was added. File it, then ask for approval.');
      }}
    >
      <h3 id={`${uid}-h`}>Add a new version</h3>
      <p className="hint">Earlier versions never change. To add a draft report, open it under Drafts and choose "Submit as output".</p>
      <fieldset>
        <legend>From</legend>
        <label className="check"><input type="radio" name={`${uid}-how`} checked={how === 'upload'} onChange={() => setHow('upload')} /> A file from this computer</label>
        <label className="check"><input type="radio" name={`${uid}-how`} checked={how === 'link'} onChange={() => setHow('link')} /> A link to a document in SharePoint or OneDrive</label>
      </fieldset>
      {how === 'upload' ? (
        <label>File <input type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      ) : (
        <label>Link <input type="url" required maxLength={2000} value={url} onChange={(e) => setUrl(e.target.value)} /></label>
      )}
      <div className="actions">
        <button className="primary">Add version</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** A submission accepted into a registered output: its versions become new versions there (spec 4.3). */
function AcceptIntoForm({ projectId, outputId, act, onCancel }: { projectId: string; outputId: string; act: Act; onCancel: () => void }) {
  const [targets, setTargets] = useState<OutputSummary[]>([]);
  const [target, setTarget] = useState('');
  useEffect(() => {
    api.get<{ outputs: OutputSummary[] }>(`/projects/${projectId}/outputs?status=registered`).then((r) => setTargets(r.outputs.filter((o) => o.id !== outputId)), () => setTargets([]));
  }, [projectId, outputId]);
  return (
    <form
      className="panel stack"
      aria-label="Add this submission to an existing output"
      onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          const r = await api.post<{ id: string }>(`/projects/${projectId}/outputs/${outputId}/accept-into`, { targetOutputId: target });
          window.location.hash = `#/projects/${projectId}/outputs/${r.id}`;
          return r;
        }, 'The submission was added as a new version.');
      }}
    >
      <label>
        Registered output
        <select required value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose an output</option>
          {targets.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
      </label>
      {targets.length === 0 && <p className="meta">There is no registered output to add it to.</p>}
      <div className="actions">
        <button className="primary" disabled={!target}>Add as a new version</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Who may read the output, people Kainow could not share with, and (for the PM, Owner or a Sponsor) changing it. */
function AudienceSection({ output, base, people, act }: { output: OutputDetail; base: string; people: ProjectPeople; act: Act }) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<'project' | 'restricted'>(output.audience.mode);
  const [chosen, setChosen] = useState<string[]>(output.audience.people.map((p) => p.id));
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const opener = useRef<HTMLButtonElement>(null);
  useReturnFocus(editing, opener);
  const body = () => ({ mode, ...(mode === 'restricted' ? { userIds: chosen } : {}), reason });
  async function previewChange(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setPreview(audiencePreviewText(await api.put<{ gaining: AffectedPerson[]; losing: AffectedPerson[] }>(`${base}/audience`, { ...body(), preview: true })));
    } catch (err) {
      setError(errText(err));
    }
  }
  let content: ReactNode = null;
  if (editing) {
    content = (
      <form className="panel stack" aria-labelledby={`${uid}-h`} onSubmit={previewChange} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
        <h4 id={`${uid}-h`}>Change who may read it</h4>
        <fieldset>
          <legend>Readers</legend>
          <label className="check"><input type="radio" name={`${uid}-m`} checked={mode === 'project'} onChange={() => { setMode('project'); setPreview(null); }} /> Project-wide: everyone who may read the project</label>
          <label className="check"><input type="radio" name={`${uid}-m`} checked={mode === 'restricted'} onChange={() => { setMode('restricted'); setPreview(null); }} /> Restricted: only the people chosen below</label>
        </fieldset>
        {mode === 'restricted' && (
          <fieldset>
            <legend>People who may read it</legend>
            {people.people.map((p) => (
              <label key={p.userId} className="check">
                <input type="checkbox" checked={chosen.includes(p.userId)} onChange={() => { setChosen((c) => (c.includes(p.userId) ? c.filter((x) => x !== p.userId) : [...c, p.userId])); setPreview(null); }} /> {p.displayName}
              </label>
            ))}
          </fieldset>
        )}
        <label>Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {preview && <p role="status" className="warn">{preview}</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          {!preview ? (
            <button className="primary">Check who gains or loses access</button>
          ) : (
            <button type="button" className="primary" onClick={() => void act(() => api.put(`${base}/audience`, body()), 'Who may read it was changed. Sharing in SharePoint follows.').then((ok) => ok && setEditing(false))}>
              Confirm the change
            </button>
          )}
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </form>
    );
  }
  return (
    <section aria-labelledby={`${uid}-a`}>
      <h3 id={`${uid}-a`}>Who may read it</h3>
      <p>
        {output.audience.mode === 'project'
          ? 'Project-wide: everyone who may read the project.'
          : `Restricted: ${output.audience.people.map((p) => p.displayName).join(', ') || 'nobody named'}.`}
      </p>
      {output.notShared && output.notShared.length > 0 && (
        <ul className="plain">
          {output.notShared.map((n) => <li key={n.person.id}><span className="warn inline">{n.message}</span> <span className="meta">({n.person.displayName}, who can still read it in Kainow)</span></li>)}
        </ul>
      )}
      {output.may.changeAudience && !editing && <button type="button" ref={opener} onClick={() => { setEditing(true); setPreview(null); setError(null); }}>Change who may read it</button>}
      {content}
    </section>
  );
}
