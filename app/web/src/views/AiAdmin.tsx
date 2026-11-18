import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  type ModelForm,
  type ModelView,
  type OrgForm,
  type OrgSettings,
  BOUNDS,
  PROVIDER_NAMES,
  PURPOSES,
  PURPOSE_LABELS,
  boundsText,
  listModels,
  modelBody,
  modelDraft,
  orgBody,
  orgDraft,
} from '../ai.ts';
import { reasonProblem } from '../history.ts';
import type { ProtectedKeyStatus } from '../quarantine.ts';
import { OrganisationUsageView } from './AiUsage.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** The warning stays on every tab while the protected key is missing: no AI key can be saved or opened without it. */
function KeyBanner() {
  const [status, setStatus] = useState<ProtectedKeyStatus | null>(null);
  useEffect(() => {
    api.get<{ protectedKey?: ProtectedKeyStatus }>('/organisation').then((p) => setStatus(p.protectedKey ?? null), () => setStatus(null));
  }, []);
  if (!status || status.loaded) return null;
  return (
    <p className="warn" role="status">
      Waiting for the protected key. Until it is installed, no project can save or use an AI key and every AI request ends blocked. The same missing key also holds back credential clean-up. See INSTALL.md.
    </p>
  );
}

const money = '^[0-9]+(\\.[0-9]{1,6})?$';

function ModelEditor({ initial, mode, onDone, onCancel }: { initial: ModelView | null; mode: 'approve' | 'change' | 'reapprove'; onDone: () => void; onCancel: () => void }) {
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
    <form className="panel stack" onSubmit={submit} aria-label={title}>
      <h3>{title}</h3>
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

function ModelsPanel() {
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | 'new'; mode: 'approve' | 'change' | 'reapprove' | 'withdraw' } | null>(null);

  const load = useCallback(async () => {
    try {
      setModels(await listModels());
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const done = () => {
    setEditing(null);
    void load();
  };
  if (!models) return error ? <p role="alert" className="error">{error}</p> : <p className="loading" role="status">Loading</p>;
  return (
    <section aria-labelledby="models-heading">
      <div className="row">
        <h2 id="models-heading">Approved models</h2>
        {editing?.id !== 'new' && <button type="button" onClick={() => setEditing({ id: 'new', mode: 'approve' })}>Approve a model</button>}
      </div>
      <p className="meta">A project can connect only to an approved model. An entry is never deleted: a model can be withdrawn and approved again.</p>
      {editing?.id === 'new' && <ModelEditor initial={null} mode="approve" onDone={done} onCancel={() => setEditing(null)} />}
      {models.length === 0 && <p className="empty">No model is approved yet, so no project can use AI.</p>}
      <ul className="model-list" role="list">
        {models.map((m) => (
          <li key={m.id} className="model">
            <div className="row">
              <p><strong>{m.displayName}</strong> <span className="meta">{PROVIDER_NAMES[m.provider]} · {m.modelId}</span></p>
              <span className={`state-badge tone-${m.state === 'approved' ? 'ok' : 'warn'}`}>{m.state === 'approved' ? 'Approved' : 'Withdrawn'}</span>
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
    </section>
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

function LimitsPanel() {
  const [view, setView] = useState<SpendView | null>(null);
  const [f, setF] = useState<OrgForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api.get<SpendView>('/ai/spend');
      setView(v);
      if (v.settings) setF(orgDraft(v.settings));
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!f) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.put('/ai/spend-settings', orgBody(f));
      setSaved(true);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!view) return error ? <p role="alert" className="error">{error}</p> : <p className="loading" role="status">Loading</p>;
  // Nothing saved yet: the form starts from the defaults of D87 and no allowance.
  const form: OrgForm = f ?? { rate: '', monthly: '', dailyMode: 'not_applied', daily: '', userMode: 'not_applied', user: '', ceilingMode: 'not_applied', ceiling: '', maySetLimits: false, mayManageConnections: false, attempts: '3', timeout: '120', concurrency: '2' };
  const set = (patch: Partial<OrgForm>) => setF({ ...form, ...patch });
  const text = (k: keyof OrgForm) => (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<OrgForm>);
  return (
    <section aria-labelledby="limits-policy-heading">
      <h2 id="limits-policy-heading">Limits and policy</h2>
      {!view.configured && <p className="warn">No limits are saved yet, so every AI request is refused. Fill in and save the form below.</p>}
      <form className="panel stack" onSubmit={save} aria-label="Organisation AI limits and policy">
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
        <fieldset>
          <legend>What projects may do themselves</legend>
          <label className="check"><input type="checkbox" checked={form.maySetLimits} onChange={(e) => set({ maySetLimits: e.target.checked })} />Projects may set AI limits</label>
          <label className="check"><input type="checkbox" checked={form.mayManageConnections} onChange={(e) => set({ mayManageConnections: e.target.checked })} />Projects may manage AI connections</label>
          <span className="hint">Turning one off keeps what projects already set. They stay in force, but only an Administrator can change them.</span>
        </fieldset>
        {error && <p role="alert" className="error">{error}</p>}
        {saved && <p role="status" className="ok">Saved. The change is in the audit trail.</p>}
        <button className="primary" disabled={busy}>Save limits and policy</button>
      </form>
    </section>
  );
}

type Tab = 'models' | 'limits' | 'usage';
const TABS: Array<[Tab, string]> = [['models', 'Models'], ['limits', 'Limits and policy'], ['usage', 'Usage']];

/** Administration → AI: approved models, organisation limits and policy, and usage. */
export function AiAdmin() {
  const [tab, setTab] = useState<Tab>('models');
  return (
    <main className="page">
      <h1>AI</h1>
      <KeyBanner />
      <div className="tabs" role="tablist" aria-label="AI settings">
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" id={`ai-tab-${t}`} aria-selected={tab === t} aria-controls={`ai-panel-${t}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`ai-panel-${tab}`} aria-labelledby={`ai-tab-${tab}`}>
        {tab === 'models' && <ModelsPanel />}
        {tab === 'limits' && <LimitsPanel />}
        {tab === 'usage' && (
          <section aria-labelledby="org-usage-heading">
            <h2 id="org-usage-heading">Usage</h2>
            <p className="meta">Counts and amounts only. No prompt, question, source title, answer or key is shown.</p>
            <OrganisationUsageView />
          </section>
        )}
      </div>
    </main>
  );
}
