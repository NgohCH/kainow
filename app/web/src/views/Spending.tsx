import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';

interface Period {
  start: string;
  end: string;
  limitMyr: string | null;
  usedMyr: string;
  reservedMyr: string;
  uncertainMyr: string;
  remainingMyr: string;
}

interface Settings {
  modelId: string;
  inputUsdPerMillion: string;
  cachedInputUsdPerMillion: string;
  outputUsdPerMillion: string;
  myrPerUsd: string;
  monthlyLimitMyr: string | null;
  daily: { mode: 'not_applied' } | { mode: 'limit'; limitMyr: string | null };
  userMonthly: { mode: 'not_applied' } | { mode: 'limit'; limitMyr: string | null };
}

interface View {
  configured: boolean;
  settings: Settings | null;
  month: Period | null;
  day: Period | null;
  mine: Period | null;
}

const myr = (v: string): string => `MYR ${Number(v).toFixed(2)}`;
const trim = (v: string): string => v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

function Figures({ title, p }: { title: string; p: Period }) {
  return (
    <section className="panel" aria-label={title}>
      <h2>{title}</h2>
      <dl className="figures">
        <div><dt>Limit</dt><dd>{p.limitMyr === null ? 'No allowance' : myr(p.limitMyr)}</dd></div>
        <div><dt>Used</dt><dd>{myr(p.usedMyr)}</dd></div>
        <div><dt>Held for requests in progress</dt><dd>{myr(p.reservedMyr)}</dd></div>
        <div><dt>Counted while the outcome is unknown</dt><dd>{myr(p.uncertainMyr)}</dd></div>
        <div><dt>Left</dt><dd><strong>{myr(p.remainingMyr)}</strong></dd></div>
      </dl>
      <p className="meta">From {formatWhen(p.start)} to {formatWhen(p.end)}.</p>
    </section>
  );
}

export function Spending() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ modelId: '', input: '', cached: '', output: '', rate: '', monthly: '', dailyMode: 'not_applied', daily: '', userMode: 'not_applied', user: '' });

  const load = useCallback(async () => {
    try {
      const v = await api.get<View>('/ai/spend');
      setView(v);
      const s = v.settings;
      if (s) {
        setF({
          modelId: s.modelId,
          input: trim(s.inputUsdPerMillion),
          cached: trim(s.cachedInputUsdPerMillion),
          output: trim(s.outputUsdPerMillion),
          rate: trim(s.myrPerUsd),
          monthly: s.monthlyLimitMyr === null ? '' : trim(s.monthlyLimitMyr),
          dailyMode: s.daily.mode,
          daily: s.daily.mode === 'limit' && s.daily.limitMyr !== null ? trim(s.daily.limitMyr) : '',
          userMode: s.userMonthly.mode,
          user: s.userMonthly.mode === 'limit' && s.userMonthly.limitMyr !== null ? trim(s.userMonthly.limitMyr) : '',
        });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load AI spending.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.put('/ai/spend-settings', {
        modelId: f.modelId.trim(),
        inputUsdPerMillion: f.input.trim(),
        cachedInputUsdPerMillion: f.cached.trim(),
        outputUsdPerMillion: f.output.trim(),
        myrPerUsd: f.rate.trim(),
        // Blank is sent as null, which means no allowance. It is never turned into "unlimited".
        monthlyLimitMyr: f.monthly.trim() === '' ? null : f.monthly.trim(),
        daily: f.dailyMode === 'not_applied' ? { mode: 'not_applied' } : { mode: 'limit', limitMyr: f.daily.trim() === '' ? null : f.daily.trim() },
        userMonthly: f.userMode === 'not_applied' ? { mode: 'not_applied' } : { mode: 'limit', limitMyr: f.user.trim() === '' ? null : f.user.trim() },
      });
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The settings were not saved.');
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  if (!view) return error ? <main className="page narrow"><p role="alert" className="error">{error}</p></main> : <p className="loading">Loading</p>;

  return (
    <main className="page narrow">
      <h1>AI spending</h1>
      {!view.configured && <p className="warn">No spend settings are saved yet, so every AI request is refused. Fill in and save the form below.</p>}
      {view.month && <Figures title="This month" p={view.month} />}
      {view.day && <Figures title="Today" p={view.day} />}
      {view.mine && <Figures title="Your use this month" p={view.mine} />}

      <form className="panel stack" onSubmit={save} aria-label="Spend settings">
        <h2>Settings</h2>
        <label>Model<input value={f.modelId} onChange={set('modelId')} required /></label>
        <fieldset>
          <legend>Prices in USD per 1 million tokens</legend>
          <div className="trio">
            <label>Input<input inputMode="decimal" value={f.input} onChange={set('input')} required /></label>
            <label>Cached input<input inputMode="decimal" value={f.cached} onChange={set('cached')} required /></label>
            <label>Output<input inputMode="decimal" value={f.output} onChange={set('output')} required /></label>
          </div>
        </fieldset>
        <label>MYR for 1 USD<input inputMode="decimal" value={f.rate} onChange={set('rate')} required /></label>
        <label>
          Monthly limit in MYR
          <input inputMode="decimal" value={f.monthly} onChange={set('monthly')} />
          <span className="hint">Resets at the start of each calendar month, UTC+8. Leaving this blank means no AI allowance at all: every request is refused. It never means unlimited.</span>
        </label>
        <fieldset>
          <legend>Daily limit</legend>
          <label className="choice"><input type="radio" name="daily" checked={f.dailyMode === 'not_applied'} onChange={() => setF((s) => ({ ...s, dailyMode: 'not_applied' }))} />No daily cap, only the monthly limit applies</label>
          <label className="choice"><input type="radio" name="daily" checked={f.dailyMode === 'limit'} onChange={() => setF((s) => ({ ...s, dailyMode: 'limit' }))} />Daily limit in MYR</label>
          {f.dailyMode === 'limit' && (
            <label>
              Limit in MYR
              <input inputMode="decimal" value={f.daily} onChange={set('daily')} />
              <span className="hint">Blank means no allowance on any day.</span>
            </label>
          )}
        </fieldset>
        <fieldset>
          <legend>Limit for each person, per month</legend>
          <label className="choice"><input type="radio" name="user" checked={f.userMode === 'not_applied'} onChange={() => setF((s) => ({ ...s, userMode: 'not_applied' }))} />No limit per person, only the organisation limits apply</label>
          <label className="choice"><input type="radio" name="user" checked={f.userMode === 'limit'} onChange={() => setF((s) => ({ ...s, userMode: 'limit' }))} />Monthly limit for each person in MYR</label>
          {f.userMode === 'limit' && (
            <label>
              Limit in MYR
              <input inputMode="decimal" value={f.user} onChange={set('user')} />
              <span className="hint">Each person has this amount every month, counted separately. Blank means no personal allowance: nobody can run an extraction.</span>
            </label>
          )}
        </fieldset>
        {error && <p role="alert" className="error">{error}</p>}
        {saved && <p role="status" className="ok">Saved. The change is in the audit trail.</p>}
        <button className="primary" disabled={busy}>Save settings</button>
      </form>
    </main>
  );
}
