import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { CURRENCIES, type Currency, type FinanceSettingsView } from '../finance.ts';
import { formatWhen } from '../format.ts';
import {
  type TurnOffPreview,
  authorityText,
  financeSettingsBody,
  hasChanges,
  nextAction,
  settingsChangeText,
  thresholdProblem,
  thresholdsText,
  turnOffPreviewText,
} from '../resourceScreens.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const FIXED = 'The reporting currency is fixed once figures exist.';

/**
 * Project Settings › Finance (spec 8.2): effective values, who may change them, the turn-off preview, reason and history.
 * `bare` leaves the heading to the settings box around it; `onSaved` tells the page the values in force changed.
 */
export function ProjectFinanceSettings({ projectId, bare = false, onSaved }: { projectId: string; bare?: boolean; onSaved?: () => void }) {
  const [view, setView] = useState<FinanceSettingsView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tracking, setTracking] = useState('not_required');
  const [currency, setCurrency] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [membersRead, setMembersRead] = useState(false);
  const [grantsRead, setGrantsRead] = useState(false);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<TurnOffPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((v: FinanceSettingsView) => {
    setView(v);
    setTracking(v.settings.tracking);
    setCurrency(v.settings.currency ?? '');
    setFirst(v.settings.warnFirstPct === null ? '' : String(v.settings.warnFirstPct));
    setSecond(v.settings.warnSecondPct === null ? '' : String(v.settings.warnSecondPct));
    setMembersRead(v.settings.membersRead);
    setGrantsRead(v.settings.grantsRead);
    setReason('');
    setPreview(null);
  }, []);

  useEffect(() => {
    let stale = false;
    setView(null);
    setHidden(false);
    api.get<FinanceSettingsView>(`/projects/${projectId}/settings/finance`).then(
      (v) => !stale && apply(v),
      (e: unknown) => {
        if (stale) return;
        // A project the person cannot read gives 404; show nothing rather than a false "not found".
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setHidden(true);
        else setError(errText(e));
      },
    );
    return () => {
      stale = true;
    };
  }, [projectId, apply]);

  if (hidden) return null;
  if (!view) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;

  const s = view.settings;
  const editable = view.editable;
  const turningOff = s.tracking === 'enabled' && tracking === 'not_required';
  const body = financeSettingsBody(s, { tracking, currency, first, second, membersRead, grantsRead, reason });
  const thresholdError = thresholdProblem(first, second);
  const currencyLocked = view.currencyFixed;
  const enabledCurrencies = view.organisation.enabledCurrencies;
  // A saved currency the organisation has since disabled stays selectable so the form can still show it.
  const choices: Currency[] = [...new Set([...(s.currency ? [s.currency] : []), ...enabledCurrencies])].filter((c) => (CURRENCIES as readonly string[]).includes(c));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!hasChanges(body)) return setError('Nothing to change.');
    if (thresholdError) return setError(thresholdError);
    if (tracking === 'enabled' && currency === '') return setError('Choose a reporting currency to turn on financial tracking.');
    if (reason.trim() === '') return setError('Give a reason for the change.');
    setBusy(true);
    try {
      // Turning tracking off shows what is kept first, and waits for the person to confirm it.
      if (nextAction({ changed: true, turningOff, previewShown: preview !== null }) === 'preview') {
        setPreview(await api.get<TurnOffPreview>(`/projects/${projectId}/settings/finance/preview`));
        return;
      }
      apply(await api.put<FinanceSettingsView>(`/projects/${projectId}/settings/finance`, body));
      setNotice('Saved. The change is in the history below.');
      onSaved?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="finance-settings-heading" className={bare ? 'stack' : 'panel stack'}>
      <h3 id="finance-settings-heading" className={bare ? 'visually-hidden' : undefined}>Finance</h3>
      <p className="meta">{authorityText(view)}</p>
      <form className="stack" onSubmit={submit} aria-label="Finance settings">
        <fieldset disabled={!editable || busy}>
          <legend>Financial tracking</legend>
          <label className="check">
            <input type="radio" name="tracking" checked={tracking === 'not_required'} onChange={() => { setTracking('not_required'); setPreview(null); }} />
            Not required
          </label>
          <label className="check">
            <input type="radio" name="tracking" checked={tracking === 'enabled'} onChange={() => { setTracking('enabled'); setPreview(null); }} />
            Enabled
          </label>
          <span className="hint">Effective now: {s.tracking === 'enabled' ? 'Enabled' : 'Not required'}.</span>
        </fieldset>

        <label>
          Reporting currency
          <select value={currency} disabled={!editable || busy || currencyLocked} aria-describedby="currency-hint" onChange={(e) => setCurrency(e.target.value)}>
            <option value="">{tracking === 'enabled' ? 'Choose a currency' : 'Not chosen'}</option>
            {choices.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <span id="currency-hint" className="hint">
            {currencyLocked ? FIXED : `Organisation default: ${view.organisation.defaultCurrency}.`}
          </span>
        </label>

        <fieldset disabled={!editable || busy}>
          <legend>Warning thresholds</legend>
          <div className="inline-form">
            <label>
              First warning (%)
              <input inputMode="numeric" value={first} aria-invalid={thresholdError !== null} onChange={(e) => setFirst(e.target.value)} />
            </label>
            <label>
              Second warning (%)
              <input inputMode="numeric" value={second} aria-invalid={thresholdError !== null} onChange={(e) => setSecond(e.target.value)} />
            </label>
          </div>
          <span className="hint">
            {thresholdsText(view.effective)} Leave both empty to follow the organisation's {view.organisation.warnFirstPct}% and {view.organisation.warnSecondPct}%. Warnings are advisory.
          </span>
          {thresholdError && <span role="alert" className="error">{thresholdError}</span>}
        </fieldset>

        <fieldset disabled={!editable || busy}>
          <legend>Who can read financial detail</legend>
          <p className="meta">The Project Manager, Deputies, Owner and Sponsors always can.</p>
          <label className="check">
            <input type="checkbox" checked={membersRead} onChange={(e) => setMembersRead(e.target.checked)} />
            Members
          </label>
          <label className="check">
            <input type="checkbox" checked={grantsRead} onChange={(e) => setGrantsRead(e.target.checked)} />
            Audit and oversight holders
          </label>
        </fieldset>

        {editable && (
          <>
            <label>
              Reason
              <input required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
              <span className="hint">Recorded with the old and new values.</span>
            </label>
            {preview && (
              <div role="alert" className="warn">
                <p>{turnOffPreviewText(preview)}</p>
                <p>Choose Confirm and turn off to save, or Cancel to keep tracking on.</p>
              </div>
            )}
            {error && <p role="alert" className="error">{error}</p>}
            {notice && <p role="status" className="ok">{notice}</p>}
            <div className="decision">
              <button className="primary" disabled={busy}>
                {preview ? 'Confirm and turn off' : turningOff ? 'Review what is kept' : 'Save finance settings'}
              </button>
              {preview && (
                <button type="button" disabled={busy} onClick={() => { setPreview(null); setTracking('enabled'); }}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
        {!editable && error && <p role="alert" className="error">{error}</p>}
      </form>

      <h4>History</h4>
      {view.changes.length === 0 ? (
        <p className="meta">No finance settings changes have been recorded.</p>
      ) : (
        <ul className="plain">
          {view.changes.map((c) => (
            <li key={c.id}>
              {settingsChangeText(c.previous, c.next)}
              <span className="meta"> · {c.actor} · {formatWhen(c.at)} · Reason: {c.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
