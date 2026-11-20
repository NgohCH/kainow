import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { RequestView } from '../changes.ts';
import {
  type AdjustmentKind,
  CURRENCIES,
  type Currency,
  type EntryView,
  FINANCE_REQUEST_KINDS,
  type FinanceSummary,
  type FinanceView,
  NOT_REQUIRED,
  adjustmentLabel,
  aiSpendText,
  figuresLines,
  money,
  normaliseAmountInput,
  notInTotalsLines,
  pendingLabel,
  validateAmountInput,
  validateRateInput,
} from '../finance.ts';
import { formatWhen, plural } from '../format.ts';
import { type ResourceActions } from '../resources.ts';
import { ChangeRequestPanel, useRequests } from './ChangeRequest.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

export const NON_READER_SENTENCE = "Financial tracking is on; figures are visible to the project's finance readers.";

type Panel = null | 'spending' | 'budget' | 'list';

/**
 * The Finance section of the Resources tab (spec 3.5, 3.6, 4). What the person sees comes from the server's summary: figures
 * only for finance readers while tracking is Enabled; otherwise the tracking value alone.
 */
export function FinanceSection({
  projectId,
  summary,
  actions,
  computedAt,
  onChanged,
}: {
  projectId: string;
  summary: FinanceSummary;
  actions: ResourceActions;
  computedAt: string;
  onChanged: (message: string) => void;
}) {
  if (!('figures' in summary)) {
    if (summary.tracking === 'enabled') {
      return (
        <section aria-labelledby="finance-heading">
          <h2 id="finance-heading">Finance</h2>
          <p>{NON_READER_SENTENCE}</p>
        </section>
      );
    }
    return <NotRequired projectId={projectId} />;
  }
  return <FinanceReader projectId={projectId} summary={summary} actions={actions} computedAt={computedAt} onChanged={onChanged} />;
}

/** Tracking off: the line for everyone, and a Finance history link for people who can read the kept entries. */
function NotRequired({ projectId }: { projectId: string }) {
  const [history, setHistory] = useState<FinanceView | null>(null);
  const [showing, setShowing] = useState(false);
  useEffect(() => {
    let stale = false;
    api.get<FinanceView>(`/projects/${projectId}/finance`).then(
      (v) => !stale && setHistory(v.entries.length > 0 || v.budgetVersions.length > 0 ? v : null),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [projectId]);
  return (
    <section aria-labelledby="finance-heading">
      <h2 id="finance-heading">Finance</h2>
      <p>Financial tracking: {NOT_REQUIRED}</p>
      {history && (
        <>
          <button type="button" className="quiet" aria-expanded={showing} onClick={() => setShowing((s) => !s)}>
            {showing ? 'Hide finance history' : 'Finance history'}
          </button>
          {showing && <FinanceDetail view={history} actions={null} currency={history.currency} requests={[]} onChanged={() => undefined} />}
        </>
      )}
    </section>
  );
}

function FinanceReader({
  projectId,
  summary,
  actions,
  computedAt,
  onChanged,
}: {
  projectId: string;
  summary: Extract<FinanceSummary, { figures: unknown }>;
  actions: ResourceActions;
  computedAt: string;
  onChanged: (message: string) => void;
}) {
  const { currency, figures } = summary;
  const [view, setView] = useState<FinanceView | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { requests, reload: reloadRequests } = useRequests(projectId);
  const load = useCallback(() => {
    api.get<FinanceView>(`/projects/${projectId}/finance`).then(
      (v) => {
        setView(v);
        setLoadError(null);
      },
      (e: unknown) => setLoadError(errText(e)),
    );
  }, [projectId]);
  useEffect(load, [load]);
  const changed = (message: string) => {
    setPanel(null);
    load();
    reloadRequests();
    onChanged(message);
  };
  const financeRequests = requests.filter((r) => (FINANCE_REQUEST_KINDS as readonly string[]).includes(r.kind));
  const budgetRequests = financeRequests.filter((r) => r.kind === 'set_budget');
  const latest = view?.budgetVersions[view.budgetVersions.length - 1] ?? null;
  const ai = view ? aiSpendText(view.aiSpendThisMonth) : null;

  return (
    <section aria-labelledby="finance-heading">
      <div className="row">
        <h2 id="finance-heading">Finance ({currency})</h2>
        <span className="meta">Updated {formatWhen(computedAt)}</span>
      </div>
      <dl className="facts">
        <dt>Budget</dt>
        <dd>
          {money(figures.budget, currency)}
          {latest ? ` (approved ${formatWhen(latest.approvedAt)})` : ''}{' '}
          {actions.proposeBudget && (
            <button type="button" className="quiet" aria-expanded={panel === 'budget'} onClick={() => setPanel(panel === 'budget' ? null : 'budget')}>
              Propose change
            </button>
          )}
        </dd>
        <dt>Spent</dt>
        <dd>{money(figures.spent, currency)}</dd>
      </dl>
      {figuresLines(figures, currency).map((l) => (
        <p key={l} className={l.startsWith('Over budget') || l.includes('(advisory)') ? 'warn' : 'meta'}>
          {l}
        </p>
      ))}
      {figures.budget === null && <p className="meta">No budget is approved yet. Balance based on recorded expenditure is not shown without one.</p>}
      {notInTotalsLines(figures).map((l) => (
        <p key={l} className="meta">{l}</p>
      ))}
      {summary.pendingAdjustments > 0 && <p className="meta">Awaiting approval: {plural(summary.pendingAdjustments, 'correction, refund or conversion', 'corrections, refunds or conversions')}</p>}
      {ai && (
        <p className="meta">
          {ai} <a href={`#/projects/${projectId}/ai`}>Open AI usage</a>
        </p>
      )}
      {budgetRequests.map((r) => (
        <ChangeRequestPanel key={r.id} request={{ ...r, currentTerms: { currency } }} onChanged={changed} />
      ))}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      <div className="decision">
        {actions.recordSpending && (
          <button type="button" aria-expanded={panel === 'spending'} onClick={() => setPanel(panel === 'spending' ? null : 'spending')}>
            Record spending
          </button>
        )}
        <button type="button" aria-expanded={panel === 'list'} onClick={() => setPanel(panel === 'list' ? null : 'list')}>
          Spending list
        </button>
      </div>
      {actions.readOnly && <p className="meta">Finance cannot be changed while the project is Deferred or Closed.</p>}
      {panel === 'spending' && <RecordSpendingForm projectId={projectId} currency={currency} onSaved={changed} onCancel={() => setPanel(null)} />}
      {panel === 'budget' && <BudgetForm projectId={projectId} currency={currency} onSaved={changed} onCancel={() => setPanel(null)} />}
      {panel === 'list' && view && (
        <FinanceDetail
          view={view}
          actions={actions}
          currency={currency}
          requests={financeRequests.filter((r) => r.kind === 'finance_adjustment')}
          projectId={projectId}
          onChanged={changed}
        />
      )}
    </section>
  );
}

/** Spending entries in date order with their adjustments, and (for readers who may) the change actions. Also the history view. */
function FinanceDetail({
  view,
  actions,
  currency,
  requests,
  projectId,
  onChanged,
}: {
  view: FinanceView;
  actions: ResourceActions | null;
  currency: Currency | null;
  requests: RequestView[];
  projectId?: string;
  onChanged: (message: string) => void;
}) {
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const reporting = currency ?? view.currency;
  return (
    <div className="panel">
      <h3>{view.historyOnly ? 'Finance history' : 'Spending list'}</h3>
      {view.notice && <p role="status">{view.notice}</p>}
      {view.budgetVersions.length > 0 && (
        <>
          <h4>Budget versions</h4>
          <ul className="plain">
            {view.budgetVersions.map((b) => (
              <li key={b.id}>
                {money(b.amount, b.currency)} <span className="meta">approved {formatWhen(b.approvedAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {view.entries.length === 0 ? (
        <p className="meta">No spending has been recorded.</p>
      ) : (
        <ul className="plain">
          {view.entries.map((e) => (
            <EntryItem
              key={e.id}
              entry={e}
              reporting={reporting}
              request={requests.find((r) => r.id === e.pending?.id)}
              canAdjust={Boolean(actions?.adjustSpending) && !view.historyOnly && projectId !== undefined}
              adjusting={adjusting === e.id}
              onAdjust={() => setAdjusting(adjusting === e.id ? null : e.id)}
              projectId={projectId}
              onChanged={(m) => {
                setAdjusting(null);
                onChanged(m);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryItem({
  entry: e,
  reporting,
  request,
  canAdjust,
  adjusting,
  onAdjust,
  projectId,
  onChanged,
}: {
  entry: EntryView;
  reporting: Currency | null;
  request: RequestView | undefined;
  canAdjust: boolean;
  adjusting: boolean;
  onAdjust: () => void;
  projectId?: string;
  onChanged: (message: string) => void;
}) {
  return (
    <li className="panel">
      <p>
        <strong>{e.spentOn}</strong> · {money(e.amount, e.currency)} · {e.description}
        {e.reference ? ` (ref ${e.reference})` : ''}
      </p>
      <p className="meta">
        Recorded by {e.recordedBy.name}, {formatWhen(e.recordedAt)}
        {' · '}
        {e.counted !== null && reporting ? `Counted: ${money(e.counted, reporting)}` : `Not in totals`}
      </p>
      {reporting &&
        e.adjustments.map((a) => (
          <p key={a.id} className="meta">
            {adjustmentLabel(a, reporting)}: {a.reason}
          </p>
        ))}
      {e.pending && <p className="warn">{pendingLabel(e.pending)}</p>}
      {request && <ChangeRequestPanel request={{ ...request, currentTerms: reporting ? { currency: reporting } : {} }} onChanged={onChanged} />}
      {canAdjust && !e.pending && reporting && (
        <button type="button" className="quiet" aria-expanded={adjusting} onClick={onAdjust}>
          {adjusting ? 'Close' : 'Propose correction, refund or conversion'}
        </button>
      )}
      {adjusting && projectId && reporting && <AdjustForm projectId={projectId} entry={e} currency={reporting} onSaved={onChanged} onCancel={onAdjust} />}
    </li>
  );
}

/** Shared by the three finance forms: a polite status line and an alert for a refusal. */
function Feedback({ saving, error }: { saving: boolean; error: string | null }) {
  return (
    <>
      <p role="status" aria-live="polite" className="meta">{saving ? 'Saving' : ''}</p>
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

function RecordSpendingForm({ projectId, currency, onSaved, onCancel }: { projectId: string; currency: Currency; onSaved: (m: string) => void; onCancel: () => void }) {
  const [spentOn, setSpentOn] = useState('');
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState<Currency>(currency);
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = !/^\d{4}-\d{2}-\d{2}$/.test(spentOn) ? 'Enter the date the money was spent.' : validateAmountInput(amount) ?? (description.trim() === '' ? 'Enter a description of 1 to 500 characters.' : null);
    if (problem) return setError(problem);
    setError(null);
    setSaving(true);
    try {
      await api.post(`/projects/${projectId}/finance/spending`, { spentOn, amount: normaliseAmountInput(amount), currency: cur, description: description.trim(), reference: reference.trim() });
      onSaved('Spending recorded.');
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  }
  return (
    <form className="panel stack" aria-label="Record spending" onSubmit={(e) => void submit(e)}>
      <h3>Record spending</h3>
      <label>
        Spent on
        <input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} required />
      </label>
      <label>
        Amount
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <label>
        Currency
        <select value={cur} onChange={(e) => setCur(e.target.value as Currency)}>
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        {cur !== currency && <span className="hint">Not in totals until a conversion to {currency} is approved.</span>}
      </label>
      <label>
        Description
        <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} required />
      </label>
      <label>
        Reference (optional)
        <input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />
      </label>
      <Feedback saving={saving} error={error} />
      <div className="decision">
        <button type="submit" className="primary" disabled={saving}>Record spending</button>
        <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}

function BudgetForm({ projectId, currency, onSaved, onCancel }: { projectId: string; currency: Currency; onSaved: (m: string) => void; onCancel: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validateAmountInput(amount, { allowZero: true }) ?? (reason.trim() === '' ? 'Enter a reason.' : null);
    if (problem) return setError(problem);
    setError(null);
    setSaving(true);
    try {
      await api.post(`/projects/${projectId}/finance/budget`, { amount: normaliseAmountInput(amount), reason: reason.trim() });
      onSaved('Budget change proposed. It waits for approval.');
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  }
  return (
    <form className="panel stack" aria-label="Propose a budget change" onSubmit={(e) => void submit(e)}>
      <h3>Propose a budget change</h3>
      <label>
        New budget ({currency})
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <label>
        Reason
        <textarea rows={3} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <Feedback saving={saving} error={error} />
      <div className="decision">
        <button type="submit" className="primary" disabled={saving}>Propose change</button>
        <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}

const ADJUST_LABEL: Record<AdjustmentKind, string> = { correction: 'Correction', refund: 'Refund', conversion: 'Conversion' };

function AdjustForm({ projectId, entry, currency, onSaved, onCancel }: { projectId: string; entry: EntryView; currency: Currency; onSaved: (m: string) => void; onCancel: () => void }) {
  const [type, setType] = useState<AdjustmentKind>('correction');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [rateOn, setRateOn] = useState('');
  const [refundOn, setRefundOn] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    let problem = validateAmountInput(amount, { allowZero: type === 'correction' });
    if (!problem && type === 'conversion') problem = validateRateInput(rate) ?? (/^\d{4}-\d{2}-\d{2}$/.test(rateOn) ? null : 'Enter the date of the rate.');
    if (!problem && type === 'refund' && !/^\d{4}-\d{2}-\d{2}$/.test(refundOn)) problem = 'Enter the date of the refund.';
    if (!problem && reason.trim() === '') problem = 'Enter a reason.';
    if (problem) return setError(problem);
    setError(null);
    setSaving(true);
    try {
      await api.post(`/projects/${projectId}/finance/spending/${entry.id}/adjust`, {
        type,
        amount: normaliseAmountInput(amount),
        reason: reason.trim(),
        ...(type === 'conversion' ? { rate: rate.trim(), rateOn } : {}),
        ...(type === 'refund' ? { refundOn } : {}),
      });
      onSaved('Change proposed. It waits for approval.');
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  }
  return (
    <form className="stack" aria-label="Propose a change to this entry" onSubmit={(e) => void submit(e)}>
      <label>
        Kind
        <select value={type} onChange={(e) => setType(e.target.value as AdjustmentKind)}>
          {(Object.keys(ADJUST_LABEL) as AdjustmentKind[]).map((k) => (
            <option key={k} value={k}>{ADJUST_LABEL[k]}</option>
          ))}
        </select>
      </label>
      <label>
        {type === 'correction' ? `Counted amount (${currency})` : type === 'refund' ? `Refunded amount (${currency})` : `Converted amount (${currency})`}
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      {type === 'conversion' && (
        <>
          <label>
            Rate
            <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required />
          </label>
          <label>
            Rate date
            <input type="date" value={rateOn} onChange={(e) => setRateOn(e.target.value)} required />
          </label>
        </>
      )}
      {type === 'refund' && (
        <label>
          Refund date
          <input type="date" value={refundOn} onChange={(e) => setRefundOn(e.target.value)} required />
        </label>
      )}
      <label>
        Reason
        <textarea rows={2} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <Feedback saving={saving} error={error} />
      <div className="decision">
        <button type="submit" className="primary" disabled={saving}>Propose</button>
        <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}
