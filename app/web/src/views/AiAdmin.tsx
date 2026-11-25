import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  type LimitsPart,
  type LimitsView,
  type ModelForm,
  type ModelView,
  type OrgForm,
  type OrgSettings,
  type ModelRow,
  type Near,
  type OrganisationUsage,
  BOUNDS,
  PROVIDER_NAMES,
  PURPOSES,
  PURPOSE_LABELS,
  boundsText,
  formatMyr,
  listModels,
  limitsFirst,
  modelRows,
  nearLimitState,
  nearestLimit,
  modelBody,
  modelDraft,
  orgBody,
  orgDraft,
  trimDecimal,
} from '../ai.ts';
import { reasonProblem } from '../history.ts';
import type { ProtectedKeyStatus } from '../quarantine.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SettingsPage, type SettingsPageItem } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { OrganisationUsageView } from './AiUsage.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

const money = '^[0-9]+(\\.[0-9]{1,6})?$';

function ModelEditor({ initial, mode, onDone, onCancel, bare }: { initial: ModelView | null; mode: 'approve' | 'change' | 'reapprove'; onDone: () => void; onCancel: () => void; bare?: boolean }) {
  const [f, setF] = useState<ModelForm>(() => modelDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ModelForm>) => setF((s) => ({ ...s, ...patch }));
  const text = (k: keyof ModelForm) => (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<ModelForm>);
  const fixed = mode !== 'approve';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = reasonProblem(f.reason);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      if (mode === 'change' && initial) await api.put(`/ai/models/${initial.id}`, modelBody(f));
      else await api.post('/ai/models', modelBody(f));
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'approve' ? 'Approve a model' : mode === 'change' ? `Change ${initial?.displayName}` : `Approve ${initial?.displayName} again`;
  return (
    <form className={bare ? 'stack' : 'panel stack'} onSubmit={submit} aria-label={title}>
      {!bare && <h3>{title}</h3>}
      <label>
        Provider
        <select value={f.provider} disabled={fixed} onChange={(e) => set({ provider: e.target.value as ModelForm['provider'] })}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label>
        Model identifier
        <input required maxLength={200} readOnly={fixed} value={f.modelId} onChange={text('modelId')} />
        <span className="hint">Sent to the provider exactly as typed. Up to 200 characters.</span>
      </label>
      <label>
        Display name
        <input required maxLength={200} value={f.displayName} onChange={text('displayName')} />
      </label>
      <fieldset>
        <legend>Prices in USD per 1 million tokens</legend>
        <div className="quad">
          <label>Input<input required inputMode="decimal" pattern={money} value={f.input} onChange={text('input')} /></label>
          <label>Cached input<input required inputMode="decimal" pattern={money} value={f.cached} onChange={text('cached')} /></label>
          <label>
            Cache write
            <input inputMode="decimal" pattern={money} value={f.cacheWrite} onChange={text('cacheWrite')} />
          </label>
          <label>Output<input required inputMode="decimal" pattern={money} value={f.output} onChange={text('output')} /></label>
        </div>
        <span className="hint">Cache write is 0 for OpenAI. Kainow does not ask for cache writes; the price only bounds an estimate if a provider reports one. A price change applies to attempts reserved after it.</span>
      </fieldset>
      <label>
        Data terms
        <textarea required rows={4} maxLength={4000} value={f.dataTerms} onChange={text('dataTerms')} />
        <span className="hint">What the provider keeps, for how long, and whether it trains on it</span>
      </label>
      <fieldset>
        <legend>Kinds of work this model may do</legend>
        {PURPOSES.map((p) => (
          <label key={p} className="check">
            <input type="checkbox" checked={f.purposes.includes(p)} onChange={(e) => set({ purposes: e.target.checked ? [...f.purposes, p] : f.purposes.filter((x) => x !== p) })} />
            {PURPOSE_LABELS[p]}
          </label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={f.restrictedOk} onChange={(e) => set({ restrictedOk: e.target.checked })} />
        May receive restricted sources
      </label>
      <label>
        Reason
        <input required maxLength={1000} value={f.reason} onChange={text('reason')} />
        <span className="hint">Recorded with the old and new values. Narrowing the kinds of work or removing restricted approval applies at the next attempt of any waiting request.</span>
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy}>{mode === 'approve' ? 'Approve model' : mode === 'change' ? 'Save change' : 'Approve again'}</button>
        <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Withdraw({ m, onDone, onCancel }: { m: ModelView; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = reasonProblem(reason);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.post(`/ai/models/${m.id}/withdraw`, { reason: reason.trim() });
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack" onSubmit={submit} aria-label={`Withdraw ${m.displayName}`}>
      <p className="meta">Withdrawing stops new attempts through every connection that uses this model. Waiting requests move on to other connections. The entry is kept and can be approved again.</p>
      <label>
        Reason
        <input required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy}>Withdraw model</button>
        <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}


interface SpendView {
  configured: boolean;
  settings: OrgSettings | null;
}

function Rule({ legend, name, mode, value, onMode, onValue, none, hint }: { legend: string; name: string; mode: 'not_applied' | 'limit'; value: string; onMode: (m: 'not_applied' | 'limit') => void; onValue: (v: string) => void; none: string; hint: string }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <label className="choice"><input type="radio" name={name} checked={mode === 'not_applied'} onChange={() => onMode('not_applied')} />{none}</label>
      <label className="choice"><input type="radio" name={name} checked={mode === 'limit'} onChange={() => onMode('limit')} />Limit in MYR</label>
      {mode === 'limit' && (
        <label>
          Limit in MYR
          <input inputMode="decimal" value={value} onChange={(e) => onValue(e.target.value)} />
          <span className="hint">{hint}</span>
        </label>
      )}
    </fieldset>
  );
}


// ---------------------------------------------------------------------------------------------------------------
// Approved models: the list and each model's own Change, Withdraw and Approve again
// ---------------------------------------------------------------------------------------------------------------

function ModelsCurrent({ models, reload }: { models: ModelView[]; reload: () => void }) {
  const [editing, setEditing] = useState<{ id: string; mode: 'change' | 'reapprove' | 'withdraw' } | null>(null);
  const done = () => {
    setEditing(null);
    reload();
  };
  return (
    <>
      <p className="meta">A project can connect only to an approved model. An entry is never deleted: a model can be withdrawn and approved again.</p>
      {models.length === 0 && <p className="empty">No model is approved yet, so no project can use AI.</p>}
      <ul className="model-list" role="list">
        {models.map((m) => (
          <li key={m.id} className="model">
            <div className="row">
              <p><strong>{m.displayName}</strong> <span className="meta">{PROVIDER_NAMES[m.provider]} · {m.modelId}</span></p>
              <StatusLabel meaning={m.state === 'approved' ? 'ok' : 'off'} word={m.state === 'approved' ? 'Approved' : 'Withdrawn'} />
            </div>
            <p className="meta">
              USD per 1 million tokens: input {m.prices.inputUsdPerMillion}, cached input {m.prices.cachedInputUsdPerMillion}, cache write {m.prices.cacheWriteUsdPerMillion}, output {m.prices.outputUsdPerMillion}
            </p>
            <ul className="chips-list" aria-label={`Kinds of work for ${m.displayName}`}>
              {m.purposes.length === 0 && <li className="chip-quiet">No kind of work</li>}
              {m.purposes.map((p) => <li key={p} className="chip-quiet">{PURPOSE_LABELS[p]}</li>)}
              <li className={m.restrictedOk ? 'chip-quiet chip-restricted' : 'chip-quiet'}>{m.restrictedOk ? 'Restricted sources allowed' : 'No restricted sources'}</li>
            </ul>
            <details>
              <summary>Data terms</summary>
              <p className="terms-text">{m.dataTerms}</p>
            </details>
            {editing?.id !== m.id && (
              <div className="actions">
                {m.state === 'approved' ? (
                  <>
                    <button type="button" aria-label={`Change ${m.displayName}`} onClick={() => setEditing({ id: m.id, mode: 'change' })}>Change</button>
                    <button type="button" aria-label={`Withdraw ${m.displayName}`} onClick={() => setEditing({ id: m.id, mode: 'withdraw' })}>Withdraw</button>
                  </>
                ) : (
                  <button type="button" aria-label={`Approve ${m.displayName} again`} onClick={() => setEditing({ id: m.id, mode: 'reapprove' })}>Approve again</button>
                )}
              </div>
            )}
            {editing?.id === m.id && editing.mode === 'withdraw' && <Withdraw m={m} onDone={done} onCancel={() => setEditing(null)} />}
            {editing?.id === m.id && editing.mode !== 'withdraw' && <ModelEditor initial={m} mode={editing.mode} onDone={done} onCancel={() => setEditing(null)} />}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Organisation limits and policy: one saved record, shown and changed in three boxes
// ---------------------------------------------------------------------------------------------------------------


const EMPTY_ORG_FORM: OrgForm = { rate: '', monthly: '', dailyMode: 'not_applied', daily: '', userMode: 'not_applied', user: '', ceilingMode: 'not_applied', ceiling: '', maySetLimits: false, mayManageConnections: false, attempts: '3', timeout: '120', concurrency: '2', reason: '' };

/** The values a box shows. Before anything is saved it says so. */
function LimitsCurrent({ part, settings }: { part: LimitsPart; settings: OrgSettings | null }) {
  if (!settings) return <p className="meta">Nothing is saved yet. Until it is, every AI request is refused.</p>;
  if (part === 'spending') {
    const user = settings.userMonthly;
    return (
      <dl className="facts">
        <div><dt>Exchange rate</dt><dd>MYR {trimDecimal(settings.myrPerUsd)} for 1 USD</dd></div>
        <div><dt>Monthly limit</dt><dd>{settings.monthlyLimitMyr === null ? 'No allowance: every request is refused' : formatMyr(settings.monthlyLimitMyr)}</dd></div>
        <div><dt>Daily limit</dt><dd>{settings.daily.mode === 'not_applied' ? 'No daily cap' : settings.daily.limitMyr === null ? 'No allowance on any day' : formatMyr(settings.daily.limitMyr)}</dd></div>
        <div><dt>Each person, per month</dt><dd>{user.mode === 'not_applied' ? 'No limit per person' : user.limitMyr === null ? 'No personal allowance' : formatMyr(user.limitMyr)}</dd></div>
        <div><dt>Ceiling on a project’s monthly limit</dt><dd>{settings.projectCeiling.mode === 'not_applied' ? 'No ceiling' : formatMyr(settings.projectCeiling.limitMyr)}</dd></div>
      </dl>
    );
  }
  if (part === 'places') {
    return (
      <dl className="facts">
        <div><dt>AI requests at once</dt><dd>{settings.concurrency}</dd></div>
        <div><dt>Attempts for one request</dt><dd>{settings.maxAttempts}</dd></div>
        <div><dt>Seconds to wait for an answer</dt><dd>{settings.timeoutSeconds}</dd></div>
      </dl>
    );
  }
  return (
    <>
      <dl className="facts">
        <div><dt>Projects may set AI limits</dt><dd>{settings.projectsMaySetLimits ? 'Yes' : 'No'}</dd></div>
        <div><dt>Projects may manage AI connections</dt><dd>{settings.projectsMayManageConnections ? 'Yes' : 'No'}</dd></div>
      </dl>
      <p className="meta">Each model’s data terms (what the provider keeps and whether it trains on it) are shown with the model under Approved models.</p>
    </>
  );
}

function LimitsFirst() {
  return <p className="warn" role="status">No limits are saved yet, so every AI request is refused. Save the spending limits first; this can be changed after that.</p>;
}

/** The saved record has one reason, so each box shows its own fields and sends the whole record. */
function LimitsForm({ part, settings, onSaved, onCancel }: { part: LimitsPart; settings: OrgSettings | null; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<OrgForm>(() => (settings ? orgDraft(settings) : EMPTY_ORG_FORM));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<OrgForm>) => setForm((f) => ({ ...f, ...patch }));
  const text = (k: keyof OrgForm) => (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<OrgForm>);

  async function save(e: FormEvent) {
    e.preventDefault();
    const problem = reasonProblem(form.reason);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.put('/ai/spend-settings', orgBody(form));
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const label = part === 'spending' ? 'Spending limits' : part === 'places' ? 'AI requests at once' : 'Project policy and data handling';
  return (
    <form className="stack" onSubmit={save} aria-label={label}>
      {!settings && <p className="warn">No limits are saved yet, so every AI request is refused. Save the exchange rate and the spending limits here first.</p>}
      {part === 'spending' && (
        <>
          <label>
            MYR for 1 USD
            <input required inputMode="decimal" value={form.rate} onChange={text('rate')} />
            <span className="hint">One exchange rate for every model. Entries already reserved keep the rate they were reserved at.</span>
          </label>
          <label>
            Monthly limit in MYR
            <input inputMode="decimal" value={form.monthly} onChange={text('monthly')} />
            <span className="hint">Resets at the start of each calendar month, UTC+8. Blank means no AI allowance at all: every request is refused. It never means unlimited.</span>
          </label>
          <Rule legend="Daily limit" name="org-daily" mode={form.dailyMode} value={form.daily} onMode={(m) => set({ dailyMode: m })} onValue={(v) => set({ daily: v })} none="No daily cap, only the monthly limit applies" hint="Blank means no allowance on any day." />
          <Rule legend="Limit for each person, per month" name="org-user" mode={form.userMode} value={form.user} onMode={(m) => set({ userMode: m })} onValue={(v) => set({ user: v })} none="No limit per person, only the organisation limits apply" hint="Each person has this amount every month, counted separately. Blank means no personal allowance." />
          <Rule legend="Ceiling on a project’s monthly limit" name="org-ceiling" mode={form.ceilingMode} value={form.ceiling} onMode={(m) => set({ ceilingMode: m })} onValue={(v) => set({ ceiling: v })} none="No ceiling" hint="A project that sets its own limit cannot set a monthly limit above this." />
        </>
      )}
      {part === 'places' && (
        <fieldset>
          <legend>Attempts, waiting and requests at once</legend>
          <label>
            Attempts for one request
            <input required inputMode="numeric" value={form.attempts} onChange={text('attempts')} />
            <span className="hint">Bounds {boundsText(BOUNDS.maxAttempts)}. A project may only choose a lower number.</span>
          </label>
          <label>
            Seconds to wait for an answer
            <input required inputMode="numeric" value={form.timeout} onChange={text('timeout')} />
            <span className="hint">Bounds {boundsText(BOUNDS.timeoutSeconds)}. A project may only choose a lower number.</span>
          </label>
          <label>
            AI requests at once
            <input required inputMode="numeric" value={form.concurrency} onChange={text('concurrency')} />
            <span className="hint">Bounds {boundsText(BOUNDS.concurrency)}. Applies to the whole organisation.</span>
          </label>
        </fieldset>
      )}
      {part === 'policy' && (
        <fieldset>
          <legend>What projects may do themselves</legend>
          <label className="check"><input type="checkbox" checked={form.maySetLimits} onChange={(e) => set({ maySetLimits: e.target.checked })} />Projects may set AI limits</label>
          <label className="check"><input type="checkbox" checked={form.mayManageConnections} onChange={(e) => set({ mayManageConnections: e.target.checked })} />Projects may manage AI connections</label>
          <span className="hint">Turning one off keeps what projects already set. They stay in force, but only an Administrator can change them.</span>
        </fieldset>
      )}
      <label>
        Reason
        <input required maxLength={1000} value={form.reason} onChange={text('reason')} />
        <span className="hint">Recorded with the old and new values.</span>
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy}>{part === 'spending' ? 'Save spending limits' : part === 'places' ? 'Save requests at once' : 'Save project policy'}</button>
        <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// At a glance
// ---------------------------------------------------------------------------------------------------------------

const num = (v: string) => Number(v);

const money2 = (n: number) => formatMyr(n.toFixed(6));

/** The ten projects that used the most this month, with their own monthly limits (the Administrator may read any project's limits). */
function useNearest(usage: OrganisationUsage | null): { rows: Near[]; loading: boolean } {
  const [limits, setLimits] = useState<Record<string, { limit: number | null; unread?: boolean }> | null>(null);
  const top = useMemo(() => [...(usage?.byProject ?? [])].sort((a, b) => num(b.usedMyr) - num(a.usedMyr)).slice(0, 10), [usage]);
  useEffect(() => {
    if (!usage) return;
    let stale = false;
    setLimits(null);
    Promise.all(
      top.map((p) =>
        api.get<LimitsView>(`/projects/${p.projectId}/ai/limits`).then(
          (v) => [p.projectId, { limit: v.project.monthlyLimitMyr === null ? null : num(v.project.monthlyLimitMyr) }] as const,
          () => [p.projectId, { limit: null, unread: true }] as const,
        ),
      ),
    ).then((pairs) => !stale && setLimits(Object.fromEntries(pairs)));
    return () => {
      stale = true;
    };
  }, [usage, top]);
  const rows = useMemo(() => (limits ? nearestLimit(top.map((p) => ({ projectId: p.projectId, name: p.name, used: num(p.usedMyr), ...(limits[p.projectId] ?? { limit: null }) }))).slice(0, 5) : []), [limits, top]);
  return { rows, loading: !!usage && top.length > 0 && !limits };
}

function Glance({ spend, models, usage, usageError, keyLoaded }: { spend: SpendView | null; models: ModelView[] | null; usage: OrganisationUsage | null; usageError: string | null; keyLoaded: boolean }) {
  const near = useNearest(usage);
  const rows = useMemo(() => (models ? modelRows(models, usage) : []), [models, usage]);
  const approved = models?.filter((m) => m.state === 'approved').length ?? 0;
  const failed = usage?.byConnection.reduce((n, c) => n + c.failures, 0) ?? 0;
  const closeToLimit = near.rows.filter((r) => r.limit !== null && (r.limit <= 0 || r.used / r.limit >= 0.8)).length;

  const issues: string[] = [];
  if (!keyLoaded) issues.push('The protected key is not installed, so no project can save or use an AI key and every AI request ends blocked. See INSTALL.md.');
  if (spend && !spend.configured) issues.push('No limits are saved yet, so every AI request is refused. Save the spending limits below.');
  if (models && approved === 0) issues.push('No model is approved, so no project can use AI. Approve a model below.');
  if (closeToLimit > 0) issues.push(`${closeToLimit === 1 ? '1 project is' : `${closeToLimit} projects are`} at 80% or more of its monthly limit.`);
  if (failed > 0) issues.push(`${failed} AI ${failed === 1 ? 'attempt' : 'attempts'} failed this month.`);

  const ready = !!spend && spend.configured && approved > 0 && keyLoaded;
  const month = usage?.month;
  const limit = month?.limitMyr ? num(month.limitMyr) : null;
  const used = month ? num(month.usedMyr) : 0;
  const pct = limit && limit > 0 ? Math.round((used / limit) * 100) : 0;

  const modelColumns: Column<ModelRow>[] = [
    { key: 'model', header: 'Model', sortValue: (r) => r.name.toLowerCase(), cell: (r) => <><strong>{r.name}</strong><span className="row-note"> {r.modelId}</span></> },
    { key: 'provider', header: 'Provider', sortValue: (r) => r.provider, cell: (r) => r.provider },
    { key: 'role', header: 'Role', cell: (r) => r.roles },
    { key: 'projects', header: 'Projects using it', sortValue: (r) => r.projects.length, cell: (r) => (r.projects.length === 0 ? 'None this month' : `${r.projects.length}: ${r.projects.join(', ')}`) },
    { key: 'month', header: 'This month', sortValue: (r) => r.month, cell: (r) => money2(r.month) },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => r.state,
      cell: (r) => <StatusLabel meaning={r.state === 'approved' ? 'ok' : r.state === 'withdrawn' ? 'off' : 'attention'} word={r.state === 'approved' ? 'Approved' : r.state === 'withdrawn' ? 'Withdrawn' : 'Not on the approved list'} />,
    },
  ];
  const nearColumns: Column<Near>[] = [
    { key: 'project', header: 'Project', sortValue: (r) => r.name.toLowerCase(), cell: (r) => <a href={`#/projects/${r.projectId}/ai`}>{r.name}</a> },
    { key: 'used', header: 'Used this month', sortValue: (r) => r.used, cell: (r) => money2(r.used) },
    { key: 'limit', header: 'Monthly limit', sortValue: (r) => r.limit ?? -1, cell: (r) => (r.unread ? 'Could not be read' : r.limit === null ? 'None saved' : money2(r.limit)) },
    { key: 'share', header: 'Share used', sortValue: (r) => (r.limit && r.limit > 0 ? r.used / r.limit : -1), cell: (r) => (r.limit && r.limit > 0 ? `${Math.round((r.used / r.limit) * 100)}%` : '—') },
    { key: 'status', header: 'Status', cell: (r) => { const s = nearLimitState(r); return <StatusLabel meaning={s.meaning} word={s.word} />; } },
  ];

  return (
    <>
      {usageError && <p role="alert" className="error">{usageError}</p>}
      <div className="stat-grid">
        <StatTile label="Status" value={ready ? 'Ready' : spend ? 'Not ready' : 'Loading'} meaning={spend ? (ready ? 'ok' : 'attention') : undefined} word={ready ? 'Ready' : 'Needs attention'} note={models ? `${approved} approved ${approved === 1 ? 'model' : 'models'}` : undefined} />
        <StatTile
          label="Spent this month"
          value={month ? formatMyr(month.usedMyr) : '—'}
          meaning={month && limit !== null ? (pct >= 100 ? 'failing' : pct >= 80 ? 'attention' : 'ok') : undefined}
          word={pct >= 100 ? 'Limit reached' : pct >= 80 ? 'Near the limit' : 'Within the limit'}
          meter={month && limit !== null ? { value: used, max: limit, text: `${pct}% of the ${formatMyr(month.limitMyr as string)} monthly limit` } : undefined}
          note={month && limit === null ? (usage?.configured ? 'No monthly allowance is set' : 'No limits saved yet') : undefined}
        />
        <StatTile label="Requests today" value={usage ? String(usage.day.requests) : '—'} note={usage ? `${usage.day.attempts} ${usage.day.attempts === 1 ? 'attempt' : 'attempts'}, ${formatMyr(usage.day.usedMyr)} today` : undefined} />
        <StatTile label="Needs attention" value={String(issues.length)} meaning={spend && models ? (issues.length === 0 ? 'ok' : 'attention') : undefined} word={issues.length === 0 ? 'All clear' : 'Needs attention'} note={issues.length === 0 ? 'Nothing needs attention' : undefined} />
      </div>
      {issues.length > 0 && (
        <ul className="plain" aria-label="What needs attention">
          {issues.map((t) => <li key={t} className="warn">{t}</li>)}
        </ul>
      )}
      <DataTable caption="Models in use" columns={modelColumns} rows={rows} rowKey={(r) => r.key} loading={!models} empty="No model is approved yet, so no project can use AI." initialSort={{ key: 'month', dir: 'desc' }} />
      <DataTable caption="Projects nearest their limit" columns={nearColumns} rows={near.rows} rowKey={(r) => r.projectId} loading={near.loading || (!usage && !usageError)} empty="No project has used AI this month." />
    </>
  );
}

/** Settings → AI: what is happening on top, approved models, limits and policy below, and the full usage figures. */
export function AiAdmin({ initialTab = 'models' }: { initialTab?: 'models' | 'limits' | 'usage' } = {}) {
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [spend, setSpend] = useState<SpendView | null>(null);
  const [usage, setUsage] = useState<OrganisationUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [keyLoaded, setKeyLoaded] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listModels().then(setModels, (e) => setError(errText(e)));
    api.get<SpendView>('/ai/spend').then(setSpend, (e) => setError(errText(e)));
    api.get<OrganisationUsage>('/ai/usage').then((u) => { setUsage(u); setUsageError(null); }, (e) => setUsageError(errText(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api.get<{ protectedKey?: ProtectedKeyStatus }>('/organisation').then((p) => setKeyLoaded(p.protectedKey?.loaded ?? true), () => setKeyLoaded(true));
  }, []);

  const settings = spend?.settings ?? null;
  const limitsItem = (key: LimitsPart, title: string): SettingsPageItem => ({
    key,
    title,
    current: spend ? <LimitsCurrent part={key} settings={settings} /> : <p className="loading" role="status">Loading</p>,
    form: (close) => (spend && limitsFirst(key, settings !== null) ? <LimitsFirst /> : spend ? <LimitsForm part={key} settings={settings} onSaved={() => { load(); close(); }} onCancel={close} /> : null),
  });

  const items: SettingsPageItem[] = [
    {
      key: 'models',
      title: 'Approved models',
      current: models ? <ModelsCurrent models={models} reload={load} /> : <p className="loading" role="status">Loading</p>,
      form: (close) => <ModelEditor bare initial={null} mode="approve" onDone={() => { load(); close(); }} onCancel={close} />,
    },
    limitsItem('spending', 'Spending limits'),
    limitsItem('places', 'AI requests at once'),
    limitsItem('policy', 'Project policy and data handling'),
  ];

  return (
    <main className="page">
      <SettingsPage
        header={{
          crumbs: [{ text: 'Settings', href: '#/settings' }],
          title: 'AI',
          intro: 'Which AI models Kainow may use, how much they may cost and who may use them. The figures are for this month, UTC+8.',
        }}
        glance={
          <>
            {error && <p role="alert" className="error">{error}</p>}
            <Glance spend={spend} models={models} usage={usage} usageError={usageError} keyLoaded={keyLoaded} />
            <details className="usage-details" open={initialTab === 'usage'}>
              <summary>Usage in detail</summary>
              <p className="meta">Counts and amounts only. No prompt, question, source title, answer or key is shown.</p>
              <OrganisationUsageView />
            </details>
          </>
        }
        settings={items}
      />
    </main>
  );
}
