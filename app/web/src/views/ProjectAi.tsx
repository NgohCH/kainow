import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  type AddForm,
  type CheckResult,
  type ConnectionView,
  type ConnectionsList,
  type LimitsForm,
  type LimitsView,
  BOUNDS,
  KEY_INPUT,
  PROVIDER_NAMES,
  addBody,
  afterKeySubmit,
  boundsText,
  connectionBadge,
  connectionMeaning,
  connectionsPath,
  emptyAddForm,
  formatMyr,
  getConnections,
  limitsBody,
  limitsDraft,
  moveId,
  replaceBody,
  sourceText,
} from '../ai.ts';
import { formatWhen } from '../format.ts';
import { reasonProblem } from '../history.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { ProjectUsageView } from './AiUsage.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
/** The server's check messages sometimes end with a full stop. */
const sentence = (m: string) => `${m.replace(/[.\s]+$/, '')}.`;

export function KeyWarning({ loaded }: { loaded: boolean }) {
  if (loaded) return null;
  return (
    <p className="warn" role="status">
      Waiting for the protected key. AI keys cannot be saved, checked or used until the protected key is installed. See INSTALL.md.
    </p>
  );
}

/** The key box. It is cleared by the form as it is submitted, never kept. */
function KeyField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const hint = useId();
  return (
    <label>
      {label}
      <input {...KEY_INPUT} name="ai-key" required value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint} />
      <span id={hint} className="hint">The key is stored encrypted and is never shown again. 20 to 500 characters, no spaces.</span>
    </label>
  );
}

function AddConnection({ projectId, list, onDone }: { projectId: string; list: ConnectionsList; onDone: (message: string) => void }) {
  const [form, setForm] = useState<AddForm>(emptyAddForm());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = reasonProblem(form.reason);
    if (problem) return setError(problem);
    const body = addBody(form);
    // The key leaves the form now, whatever the answer is.
    setForm((f) => afterKeySubmit(f));
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ connection: ConnectionView; check: CheckResult }>(connectionsPath(projectId), body);
      setForm(emptyAddForm());
      onDone(`Connection added. ${sentence(r.check.message)}`);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof AddForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const none = list.models.length === 0;
  return (
    <form className="box stack change-form" onSubmit={submit} aria-label="Add connection">
      <h3 className="form-box-title">Add a connection</h3>
      <p className="meta">Kainow checks the key as soon as it is saved. The new connection goes last in the order.</p>
      {none && <p className="meta">The Administrator has not approved any AI model yet, so there is nothing to connect to.</p>}
      <label>
        Model
        <select required value={form.modelRef} onChange={set('modelRef')} disabled={none}>
          <option value="">Choose an approved model</option>
          {list.models.map((m) => (
            <option key={m.id} value={m.id}>{PROVIDER_NAMES[m.provider]} — {m.displayName} ({m.modelId})</option>
          ))}
        </select>
      </label>
      <label>
        Label
        <input required maxLength={100} value={form.label} onChange={set('label')} />
        <span className="hint">A name for this connection, up to 100 characters. Never put a key here.</span>
      </label>
      <KeyField label="API key" value={form.apiKey} onChange={(v) => setForm((f) => ({ ...f, apiKey: v }))} />
      <label>
        Reason
        <input required maxLength={1000} value={form.reason} onChange={set('reason')} />
        <span className="hint">Recorded in the project History with your name.</span>
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy || none}>Add connection</button>
    </form>
  );
}

function ReplaceKey({ projectId, c, onDone, onCancel }: { projectId: string; c: ConnectionView; onDone: (message: string) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ apiKey: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = reasonProblem(form.reason);
    if (problem) return setError(problem);
    const body = replaceBody(form);
    setForm((f) => afterKeySubmit(f));
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ check: CheckResult }>(`${connectionsPath(projectId)}/${c.id}/key`, body);
      onDone(`Key replaced for ${c.label}. ${sentence(r.check.message)}`);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack replace-key" onSubmit={submit} aria-label={`Replace key for ${c.label}`}>
      <KeyField label={`New key for ${c.label}`} value={form.apiKey} onChange={(v) => setForm((f) => ({ ...f, apiKey: v }))} />
      <label>
        Reason
        <input required maxLength={1000} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy}>Replace key</button>
        <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ConnectionsSection({ projectId }: { projectId: string }) {
  const [list, setList] = useState<ConnectionsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [replacing, setReplacing] = useState<string | null>(null);
  const reasonBox = useRef<HTMLInputElement>(null);
  const reasonId = useId();

  const load = useCallback(async () => {
    try {
      setList(await getConnections(projectId));
    } catch (e) {
      setError(errText(e));
    }
  }, [projectId]);
  useEffect(() => void load(), [load]);

  /** One change from the row buttons. They share the reason box above the list. */
  async function change<T>(work: () => Promise<T>, done: (r: T) => string) {
    const problem = reasonProblem(reason);
    if (problem) {
      setError(`${problem} Write it in the box above the list.`);
      reasonBox.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await work();
      setNotice(done(r));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      await load();
    }
  }

  if (!list) return error ? <p role="alert" className="error">{error}</p> : <p className="loading" role="status">Loading</p>;
  const ids = list.connections.map((c) => c.id);
  const r = reason.trim();
  const move = (c: ConnectionView, dir: 'up' | 'down') => {
    const next = moveId(ids, c.id, dir);
    if (next) void change(() => api.put(`${connectionsPath(projectId)}/order`, { ids: next, reason: r }), () => `${c.label} moved ${dir}.`);
  };

  const columns: Column<ConnectionView>[] = [
    { key: 'order', header: 'Order', cell: (c) => String(c.position) },
    {
      key: 'connection',
      header: 'Connection',
      cell: (c) => (
        <span>
          {c.label}
          <span className="meta work-parent">{PROVIDER_NAMES[c.provider]} · {c.displayName} ({c.modelId})</span>
        </span>
      ),
    },
    { key: 'state', header: 'State', cell: (c) => <StatusLabel meaning={connectionMeaning(c.state)} word={connectionBadge(c.state)} /> },
    {
      key: 'used',
      header: 'Last used',
      cell: (c) => (
        <span>
          {c.lastUsedAt ? formatWhen(c.lastUsedAt) : 'Not used yet'}
          {c.rejectedAt && <span className="meta work-parent">Refused by the provider {formatWhen(c.rejectedAt)}{c.rejectedStatus ? ` (status ${c.rejectedStatus})` : ''}</span>}
        </span>
      ),
    },
  ];
  if (list.editable || list.mayDisable) {
    columns.push({
      key: 'actions',
      header: 'Actions',
      wide: true,
      cell: (c) => {
        const i = ids.indexOf(c.id);
        return (
          <div className="work-details">
            <div className="actions">
              {list.editable && (
                <>
                  <button type="button" disabled={busy || i === 0} onClick={() => move(c, 'up')} aria-label={`Move ${c.label} up`}>Move up</button>
                  <button type="button" disabled={busy || i === ids.length - 1} onClick={() => move(c, 'down')} aria-label={`Move ${c.label} down`}>Move down</button>
                  <button type="button" disabled={busy} aria-expanded={replacing === c.id} onClick={() => setReplacing(replacing === c.id ? null : c.id)} aria-label={`Replace key of ${c.label}`}>Replace key</button>
                  <button type="button" disabled={busy} onClick={() => void change(() => api.post<{ check: CheckResult }>(`${connectionsPath(projectId)}/${c.id}/check`, { reason: r }), (x) => `${c.label}: ${sentence(x.check.message)}`)} aria-label={`Check key of ${c.label}`}>Check key</button>
                </>
              )}
              {c.storedState === 'disabled' ? (
                list.editable && (<button type="button" disabled={busy} onClick={() => void change(() => api.post(`${connectionsPath(projectId)}/${c.id}/enable`, { reason: r }), () => `${c.label} enabled.`)} aria-label={`Enable ${c.label}`}>Enable</button>)
              ) : (
                list.mayDisable && (<button type="button" disabled={busy} onClick={() => void change(() => api.post(`${connectionsPath(projectId)}/${c.id}/disable`, { reason: r }), () => `${c.label} disabled.`)} aria-label={`Disable ${c.label}`}>Disable</button>)
              )}
            </div>
            {list.editable && replacing === c.id && (
              <ReplaceKey
                projectId={projectId}
                c={c}
                onCancel={() => setReplacing(null)}
                onDone={(m) => {
                  setReplacing(null);
                  setNotice(m);
                  void load();
                }}
              />
            )}
          </div>
        );
      },
    });
  }

  return (
    <section aria-labelledby="connections-heading" className="box">
      <h2 id="connections-heading" className="box-title">Connections</h2>
      <p className="meta">Each connection is one approved model with one of this project’s own keys. AI requests try them in this order and move on to the next when one is unavailable.</p>
      <KeyWarning loaded={list.protectedKeyLoaded} />
      {!list.editable && <p className="meta">You can see these connections but not change them. Only the Administrator, or the Project Manager, an Owner or a Sponsor when the Administrator allows it, can change them while the project is Draft, Planned or Active.</p>}
      {(list.editable || list.mayDisable) && list.connections.length > 0 && (
        <label>
          Reason for the next change to a connection below
          <input id={reasonId} ref={reasonBox} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <span className="hint">Used when you move, check, disable or enable a connection. Recorded in the project History.</span>
        </label>
      )}
      {list.connections.length === 0 ? (
        <p className="label-stack">
          <StatusLabel meaning="failing" word="Blocked" />
          <span>This project has no AI connection yet, so AI requests are blocked: AI is not set up for this project.</span>
        </p>
      ) : (
        <DataTable caption="Connections, in the order AI requests try them" columns={columns} rows={list.connections} rowKey={(c) => c.id} empty="No connections." />
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="ok">{notice}</p>}
      {list.editable && (
        <AddConnection
          projectId={projectId}
          list={list}
          onDone={(m) => {
            setNotice(m);
            setError(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function RuleFields({
  legend,
  mode,
  value,
  onMode,
  onValue,
  none,
  blank,
  name,
}: {
  legend: string;
  mode: 'not_applied' | 'limit';
  value: string;
  onMode: (m: 'not_applied' | 'limit') => void;
  onValue: (v: string) => void;
  none: string;
  blank: string;
  name: string;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <label className="choice"><input type="radio" name={name} checked={mode === 'not_applied'} onChange={() => onMode('not_applied')} />{none}</label>
      <label className="choice"><input type="radio" name={name} checked={mode === 'limit'} onChange={() => onMode('limit')} />Limit in MYR</label>
      {mode === 'limit' && (
        <label>
          Limit in MYR
          <input inputMode="decimal" value={value} onChange={(e) => onValue(e.target.value)} />
          <span className="hint">{blank}</span>
        </label>
      )}
    </fieldset>
  );
}

function LimitsSection({ projectId }: { projectId: string }) {
  const [view, setView] = useState<LimitsView | null>(null);
  const [form, setForm] = useState<LimitsForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api.get<LimitsView>(`/projects/${projectId}/ai/limits`);
      setView(v);
      setForm(limitsDraft(v));
    } catch (e) {
      setError(errText(e));
    }
  }, [projectId]);
  useEffect(() => void load(), [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const problem = reasonProblem(form.reason);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const v = await api.put<LimitsView>(`/projects/${projectId}/ai/limits`, limitsBody(form));
      setView(v);
      setForm(limitsDraft(v));
      setSaved(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!view || !form) return error ? <p role="alert" className="error">{error}</p> : <p className="loading" role="status">Loading</p>;
  const set = (patch: Partial<LimitsForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const org = view.organisation;
  const edit = view.editable;
  const ceiling = view.ceiling.mode === 'limit' ? `The Administrator’s ceiling for a project’s monthly limit is ${formatMyr(view.ceiling.limitMyr)}.` : 'The Administrator has set no ceiling on a project’s monthly limit.';
  return (
    <section aria-labelledby="limits-heading" className="box">
      <h2 id="limits-heading" className="box-title">Limits</h2>
      <p className="meta">What this project may spend on AI. The organisation’s own limits apply as well. Blank or zero means no allowance, never unlimited. Months and days follow UTC+8.</p>
      {!view.project.saved && (
        <p className="label-stack" role="status">
          <StatusLabel meaning="failing" word="Blocked" />
          <span>AI is not set up for this project. No limits are saved, so the project has no AI allowance.</span>
        </p>
      )}
      {!edit && (
        <p className="meta">
          {org.projectsMaySetLimits
            ? 'You can see these limits but not change them. They can be changed by the Project Manager, an Owner or a Sponsor while the project is Draft, Planned or Active.'
            : 'You can see these limits but not change them: the Administrator has not allowed projects to set their own, so only the Administrator can.'}
        </p>
      )}
      <form className="stack" onSubmit={save} aria-label="Project AI limits">
        <fieldset disabled={!edit} className="plain-fieldset">
          <label>
            Monthly limit in MYR
            <input inputMode="decimal" value={form.monthly} onChange={(e) => set({ monthly: e.target.value })} />
            <span className="hint">
              Source: {view.project.saved ? sourceText('project') : 'not set yet, so no allowance'}. {ceiling} A blank limit means no allowance.
            </span>
          </label>
          <RuleFields
            legend="Daily limit"
            name="project-daily"
            mode={form.dailyMode}
            value={form.daily}
            onMode={(m) => set({ dailyMode: m })}
            onValue={(v) => set({ daily: v })}
            none="No daily cap for this project, only the monthly limit applies"
            blank="Blank means no allowance on any day."
          />
          <RuleFields
            legend="Limit for each person in this project, per month"
            name="project-user"
            mode={form.userMode}
            value={form.user}
            onMode={(m) => set({ userMode: m })}
            onValue={(v) => set({ user: v })}
            none="No limit per person in this project"
            blank="Each person has this amount every month in this project. Blank means no personal allowance."
          />
          <label>
            Attempts for one request
            <input inputMode="numeric" value={form.attempts} onChange={(e) => set({ attempts: e.target.value })} />
            <span className="hint">
              Bounds {boundsText(BOUNDS.maxAttempts)}. The organisation allows {org.maxAttempts}; this project may only be lower. Blank uses the organisation’s value. In force now: {view.sources.maxAttempts === 'project' ? view.project.maxAttempts : org.maxAttempts}, from {sourceText(view.sources.maxAttempts)}.
            </span>
          </label>
          <label>
            Seconds to wait for an answer
            <input inputMode="numeric" value={form.timeout} onChange={(e) => set({ timeout: e.target.value })} />
            <span className="hint">
              Bounds {boundsText(BOUNDS.timeoutSeconds)}. The organisation allows {org.timeoutSeconds}; this project may only be lower. Blank uses the organisation’s value. In force now: {view.sources.timeoutSeconds === 'project' ? view.project.timeoutSeconds : org.timeoutSeconds}, from {sourceText(view.sources.timeoutSeconds)}.
            </span>
          </label>
          <p className="meta">AI requests at once ({org.concurrency}) is set for the whole organisation.</p>
          {edit && (
            <label>
              Reason
              <input required maxLength={1000} value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
              <span className="hint">Recorded with the old and new values.</span>
            </label>
          )}
        </fieldset>
        {error && <p role="alert" className="error">{error}</p>}
        {saved && <p role="status" className="ok">Saved. The change is in the audit trail and applies to requests made from now on.</p>}
        {edit && <button className="primary" disabled={busy}>Save limits</button>}
      </form>
    </section>
  );
}

/** Project → AI: connections, limits and, for those who manage the project’s AI use, usage. Answers #/projects/<id>/ai. */
export function ProjectAi({ projectId, mayViewUsage }: { projectId: string; mayViewUsage: boolean }) {
  return (
    <div className="project-ai">
      <ConnectionsSection projectId={projectId} />
      <LimitsSection projectId={projectId} />
      {mayViewUsage && (
        <section aria-labelledby="usage-heading" className="box">
          <h2 id="usage-heading" className="box-title">Usage</h2>
          <p className="meta">Counts and amounts only. No prompt, question, source title or answer is shown.</p>
          <ProjectUsageView projectId={projectId} />
        </section>
      )}
    </div>
  );
}
