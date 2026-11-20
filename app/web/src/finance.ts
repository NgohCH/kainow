/**
 * Finance on the web (resources-budget spec 3.5, 5). The types mirror what the server sends (app/src/finance/finance.service.ts,
 * money.ts, finance-settings.service.ts); the web cannot import server code and never works out a figure: it words and
 * formats what the server gave.
 */
export const CURRENCIES = ['MYR', 'SGD', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const NOT_PROVIDED = 'Not provided';
export const NOT_REQUIRED = 'Not required';
export const BASIS_NOTE = 'Based on recorded entries.';
export const BALANCE_LABEL = 'Balance based on recorded expenditure';
export const OVER_BUDGET = 'Over budget';
export const NOT_IN_TOTALS = 'Not in totals';

export type Tracking = 'not_required' | 'enabled';

export interface FiguresView {
  budget: string | null;
  spent: string;
  balance: string | null;
  percentUsed: number | null;
  overBudget: boolean;
  level: 0 | 1 | 2;
  notInTotals: { currency: Currency; amount: string }[];
  warnThresholds: [number, number];
}

/** Figures only for financial-detail readers; the tracking value alone for anyone else. */
export type FinanceSummary =
  | { tracking: Tracking }
  | { tracking: 'enabled'; currency: Currency; figures: FiguresView; pendingAdjustments: number; notInTotals: FiguresView['notInTotals'] };

export type Person = { id: string; name: string };
export type AdjustmentKind = 'correction' | 'refund' | 'conversion';

export interface AdjView {
  id: string;
  kind: AdjustmentKind;
  amount: string;
  rate: string | null;
  rateOn: string | null;
  refundOn: string | null;
  reason: string;
  changeRequestId: string;
  approvedAt: string;
}

export interface PendingView {
  id: string;
  kind: 'set_budget' | 'finance_adjustment';
  targetId: string;
  submittedAt: string;
  submittedBy: Person;
  terms: { type?: AdjustmentKind; amount?: string; reason?: string; rate?: string; rateOn?: string; refundOn?: string } | null;
}

export interface EntryView {
  id: string;
  spentOn: string;
  amount: string;
  currency: Currency;
  description: string;
  reference: string;
  recordedBy: Person;
  recordedAt: string;
  /** In the reporting currency; null for a foreign entry not yet converted. */
  counted: string | null;
  adjustments: AdjView[];
  pending: PendingView | null;
}

export interface BudgetVersion {
  id: string;
  amount: string;
  currency: Currency;
  changeRequestId: string;
  approvedAt: string;
}

/** `GET /projects/:id/finance`. */
export interface FinanceView {
  tracking: Tracking;
  currency: Currency | null;
  figures: FiguresView | null;
  budgetVersions: BudgetVersion[];
  entries: EntryView[];
  pending: PendingView[];
  historyOnly: boolean;
  notice?: string;
  aiSpendThisMonth?: unknown;
}

export interface FinanceSettings {
  tracking: Tracking;
  currency: Currency | null;
  warnFirstPct: number | null;
  warnSecondPct: number | null;
  membersRead: boolean;
  grantsRead: boolean;
}

/** `GET /projects/:id/finance/settings`. */
export interface FinanceSettingsView {
  settings: FinanceSettings;
  effective: { thresholds: [number, number]; inherited: boolean };
  organisation: { defaultCurrency: Currency; enabledCurrencies: Currency[]; warnFirstPct: number; warnSecondPct: number };
  editable: boolean;
  delegated: boolean;
  currencyFixed: boolean;
  changes: { id: string; at: string; reason: string; actorId: string; actor: string; previous: unknown; next: unknown }[];
}

/** What the person typed, as the server accepts it: spaces and thousands commas removed. */
export function normaliseAmountInput(s: string): string {
  return s.replace(/[\s,]/g, '');
}

/** "120000.00" gives "120,000.00" (a decimal string; never floating point). Anything that is not one is returned as is. */
function grouped(amount: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) return amount;
  const whole = m[2].replace(/\B(?=(\d{3})+$)/g, ',');
  return `${m[1]}${whole}.${(m[3] ?? '').padEnd(2, '0')}`;
}

/** A money value for display. A missing budget reads "Not provided"; zero stays "0.00". `opts.code: false` leaves the currency off. */
export function money(amount: string | null, currency: Currency | string, opts: { code?: boolean } = {}): string {
  if (amount === null) return NOT_PROVIDED;
  const text = grouped(amount);
  return opts.code === false ? text : `${currency} ${text}`;
}

/**
 * The lines under the figures: balance, "Over budget", percentage used, the advisory warning and the basis note. Nothing
 * when no budget is approved: there is no balance without a budget.
 */
export function figuresLines(f: FiguresView, currency: Currency): string[] {
  if (f.budget === null || f.balance === null) return [];
  const out = [`${BALANCE_LABEL}: ${money(f.balance, currency)}`];
  if (f.overBudget) out.push(OVER_BUDGET);
  if (f.percentUsed !== null) out.push(`${f.percentUsed}% of the approved budget used`);
  if (f.level > 0) {
    out.push(
      f.percentUsed === null
        ? 'Recorded spending is over the approved budget (advisory).'
        : `Recorded spending reached ${f.warnThresholds[f.level - 1]}% of the approved budget (advisory).`,
    );
  }
  out.push(BASIS_NOTE);
  return out;
}

/** Foreign entries awaiting conversion, one per currency. */
export function notInTotalsLines(f: Pick<FiguresView, 'notInTotals'>): string[] {
  return f.notInTotals.map((n) => `${NOT_IN_TOTALS}: ${money(n.amount, n.currency)} awaiting conversion`);
}

/** One approved adjustment in the spending list; amounts are in the reporting currency. */
export function adjustmentLabel(a: Pick<AdjView, 'kind' | 'amount' | 'rate' | 'rateOn' | 'refundOn'>, currency: Currency): string {
  const amount = money(a.amount, currency);
  if (a.kind === 'correction') return `Correction: counted amount set to ${amount}`;
  if (a.kind === 'refund') return `Refund of ${amount}${a.refundOn ? ` on ${a.refundOn}` : ''}`;
  return `Conversion: ${amount}${a.rate ? ` at rate ${a.rate}` : ''}${a.rateOn ? ` on ${a.rateOn}` : ''}`;
}

/** A pending finance request awaiting approval. */
export function pendingLabel(p: Pick<PendingView, 'kind' | 'terms'>): string {
  if (p.kind === 'set_budget') return 'Awaiting approval: budget';
  return `Awaiting approval: ${p.terms?.type ?? 'adjustment'}`;
}

const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;
const RATE_RE = /^\d{1,10}(\.\d{1,8})?$/;

/** The first problem with an amount the person typed (after removing spaces and commas), or null. */
export function validateAmountInput(raw: string, opts: { allowZero?: boolean } = {}): string | null {
  const s = normaliseAmountInput(raw);
  if (!AMOUNT_RE.test(s)) return 'Enter an amount of up to 12 digits with at most 2 decimal places.';
  if (!opts.allowZero && /^0+(\.0+)?$/.test(s)) return 'Enter an amount above 0.';
  return null;
}

export function validateRateInput(raw: string): string | null {
  const s = raw.trim();
  if (!RATE_RE.test(s) || /^0+(\.0+)?$/.test(s)) return 'Enter a rate above 0 with at most 8 decimal places.';
  return null;
}

/** Kinds of finance requests the Resources tab lists for approval. */
export const FINANCE_REQUEST_KINDS = ['set_budget', 'finance_adjustment'] as const;

/** The project's AI spend this month as the finance view sends it (micro-ringgit strings), trimmed to 2 decimals when the rest is zero. */
export function aiSpendText(v: unknown): string | null {
  const used = (v as { usedMyr?: unknown } | null | undefined)?.usedMyr;
  if (typeof used !== 'string' || !/^\d+(\.\d+)?$/.test(used)) return null;
  const [whole, frac = ''] = used.split('.');
  const cut = /^0*$/.test(frac.slice(2)) ? frac.slice(0, 2).padEnd(2, '0') : frac.replace(/0+$/, '');
  return `AI spending this month (separate, not included): MYR ${whole}.${cut}`;
}
