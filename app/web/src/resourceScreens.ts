/**
 * Wording and checks for the resources and finance settings, dashboard, leadership and analytics screens (resources-budget
 * spec 5 to 8). The web never works out a figure: it words what the server sent.
 */
import { BASIS_NOTE, type Currency, type FinanceSettingsView, type FinanceSummary, NOT_PROVIDED, NOT_REQUIRED, figuresLines, money } from './finance.ts';
import { plural } from './format.ts';
import type { BudgetCardValue, ResourcesCardValue } from './leadership.ts';
import { LINE_STATUSES, type LineStatus } from './resources.ts';

/** `GET /projects/:id/settings/finance/preview`. */
export interface TurnOffPreview {
  entries: number;
  budgetVersions: number;
  pending: number;
}

/** The sentence shown, and confirmed, before financial tracking is turned off (spec 3.5, 8.2). */
export function turnOffPreviewText(p: TurnOffPreview): string {
  return `Finance sections will be hidden. ${p.entries} entries, ${p.budgetVersions} budget versions and ${p.pending} pending approvals are kept. Finance readers can still open Finance history.`;
}

const THRESHOLD = 'Warning thresholds must be whole percentages from 1 to 200, the first below the second.';

/** The first problem with the two thresholds as typed (both empty means inherit), or null. */
export function thresholdProblem(first: string, second: string): string | null {
  const a = first.trim();
  const b = second.trim();
  if (a === '' && b === '') return null;
  if (!/^\d{1,3}$/.test(a) || !/^\d{1,3}$/.test(b)) return THRESHOLD;
  const x = Number(a);
  const y = Number(b);
  return x >= 1 && y <= 200 && x < y ? null : THRESHOLD;
}

/** "Warnings at 80% and 100%, inherited from the organisation" or "set for this project". */
export function thresholdsText(effective: FinanceSettingsView['effective']): string {
  const [a, b] = effective.thresholds;
  return `Warnings at ${a}% and ${b}% of the approved budget (${effective.inherited ? 'inherited from the organisation' : 'set for this project'}).`;
}

/** Who may change the project's finance settings, for the viewer (Q01). */
export function authorityText(v: Pick<FinanceSettingsView, 'editable' | 'delegated'>): string {
  if (v.editable) return 'You can change these settings.';
  if (!v.delegated) return 'The Administrator has not allowed projects to manage finance settings. Only the Administrator can change them.';
  return 'The Project Manager, Owner or a Sponsor can change these settings, and the Administrator. Deputies and others can only read them.';
}

const yes = (b: unknown) => (b ? 'Yes' : 'No');

const SETTING_LABEL: Record<string, string> = {
  tracking: 'Financial tracking',
  currency: 'Reporting currency',
  warnFirstPct: 'First warning',
  warnSecondPct: 'Second warning',
  membersRead: 'Members read financial detail',
  grantsRead: 'Audit and oversight holders read financial detail',
  projectsMayManageFinance: 'Projects may manage finance settings',
  defaultCurrency: 'Default currency',
  enabledCurrencies: 'Enabled currencies',
};

function settingValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return key.startsWith('warn') ? 'inherited' : 'none';
  if (key === 'tracking') return v === 'enabled' ? 'Enabled' : NOT_REQUIRED;
  if (typeof v === 'boolean') return yes(v);
  if (Array.isArray(v)) return v.join(', ');
  if (key.startsWith('warn')) return `${v}%`;
  return String(v);
}

/** One recorded change in words: each changed setting with previous to new. */
export function settingsChangeText(previous: unknown, next: unknown): string {
  const p = (previous ?? {}) as Record<string, unknown>;
  const n = (next ?? {}) as Record<string, unknown>;
  const parts = Object.keys(n)
    .filter((k) => JSON.stringify(p[k]) !== JSON.stringify(n[k]))
    .map((k) => `${SETTING_LABEL[k] ?? k}: ${settingValue(k, p[k])} to ${settingValue(k, n[k])}`);
  return parts.length > 0 ? parts.join('; ') : 'No setting changed';
}

/** The request body for a project's finance settings: only what the person changed, plus the reason. */
export function financeSettingsBody(
  current: FinanceSettingsView['settings'],
  form: { tracking: string; currency: string; first: string; second: string; membersRead: boolean; grantsRead: boolean; reason: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = { reason: form.reason.trim() };
  if (form.tracking !== current.tracking) body.tracking = form.tracking;
  const currency = form.currency === '' ? null : form.currency;
  if (currency !== current.currency) body.currency = currency;
  const first = form.first.trim() === '' ? null : Number(form.first);
  const second = form.second.trim() === '' ? null : Number(form.second);
  if (first !== current.warnFirstPct || second !== current.warnSecondPct) {
    body.warnFirstPct = first;
    body.warnSecondPct = second;
  }
  if (form.membersRead !== current.membersRead) body.membersRead = form.membersRead;
  if (form.grantsRead !== current.grantsRead) body.grantsRead = form.grantsRead;
  return body;
}

/** True when the body changes something besides the reason. */
export const hasChanges = (body: Record<string, unknown>): boolean => Object.keys(body).some((k) => k !== 'reason');

// ---- Dashboard (spec 5) -------------------------------------------------------------------------------------------------

export const FINANCE_NOT_REQUIRED_LINE = `Financial tracking: ${NOT_REQUIRED}`;
export const FINANCE_ON_NON_READER = "Financial tracking is on; figures are visible to the project's finance readers.";

/** Resource counts for the dashboard block, in status order, Finished and Cancelled left out (they are not open needs). */
export function resourceCountsLine(byStatus: Record<LineStatus, number>): string {
  return (['needed', 'arranged', 'in_use'] as const).map((s) => `${LINE_STATUSES[s]} ${byStatus[s]}`).join(' · ');
}

/** The dashboard's finance block as lines of text: figures for readers, the plain tracking sentence for everyone else. */
export function dashboardFinanceLines(f: FinanceSummary): string[] {
  if (f.tracking === 'not_required') return [FINANCE_NOT_REQUIRED_LINE];
  if (!('figures' in f)) return [FINANCE_ON_NON_READER];
  const fig = f.figures;
  const out = [`Approved budget: ${money(fig.budget, f.currency)}`, `Recorded spending: ${money(fig.spent, f.currency)}`, ...figuresLines(fig, f.currency)];
  if (f.pendingAdjustments > 0) out.push(`Awaiting approval: ${plural(f.pendingAdjustments, 'adjustment')}`);
  for (const n of f.notInTotals) out.push(`Not in totals: ${money(n.amount, n.currency)} awaiting conversion`);
  if (fig.budget === null) out.push(BASIS_NOTE);
  return out;
}

// ---- Leadership cards (spec 6) --------------------------------------------------------------------------------------------

export function resourcesCardText(v: ResourcesCardValue): string {
  return `Needed ${v.needed} · Arranged ${v.arranged} · In use ${v.inUse} · Past needed-by date ${v.neededByPassed}`;
}

/** The Budget card field as lines: "Not required", or the figures with "Based on recorded entries.". */
export function budgetCardLines(v: BudgetCardValue): string[] {
  if (v.tracking === 'not_required') return [NOT_REQUIRED];
  const c: Currency = v.currency;
  const out = [`Approved budget: ${v.budget === null ? NOT_PROVIDED : money(v.budget, c)}`, `Recorded spending: ${money(v.spent, c)}`];
  if (v.percentUsed !== null) out.push(`${v.percentUsed}% of the approved budget used`);
  if (v.overBudget) out.push('Over budget');
  if (v.level === 1) out.push('First warning level reached (advisory)');
  if (v.level === 2) out.push('Second warning level reached (advisory)');
  out.push(BASIS_NOTE);
  return out;
}

// ---- Analytics (spec 7) ---------------------------------------------------------------------------------------------------

export const AI_SEPARATE_TITLE = 'AI spending is separate';

/** Bar width as a whole percent of the largest value; 0 when there is nothing to compare. */
export function sharePercent(value: string, max: string): number {
  const v = Number(value);
  const m = Number(max);
  return m > 0 && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round((v / m) * 100))) : 0;
}

// ---- Catalogue (spec 8.1) --------------------------------------------------------------------------------------------------

export interface ItemDraft {
  kind: string;
  reference: string;
  name: string;
  categoryId: string;
  description: string;
}
export const EMPTY_ITEM: ItemDraft = { kind: 'equipment', reference: '', name: '', categoryId: '', description: '' };

/** The first problem with an item as typed, in the server's limits, or null. */
export function itemProblem(d: ItemDraft): string | null {
  if (d.reference.trim().length < 1 || d.reference.trim().length > 30) return 'The reference must be 1 to 30 characters.';
  if (d.name.trim().length < 1 || d.name.trim().length > 120) return 'The name must be 1 to 120 characters.';
  if (d.categoryId === '') return 'Choose an active category.';
  if (d.description.trim().length > 1000) return 'The description must be up to 1,000 characters.';
  return null;
}

// ---- Organisation finance settings (spec 8.1) -------------------------------------------------------------------------------

export interface OrgFinanceForm {
  projectsMayManageFinance: boolean;
  defaultCurrency: string;
  enabledCurrencies: string[];
  first: string;
  second: string;
}

/** The first problem with the organisation's finance settings as typed, or null. */
export function orgSettingsProblem(f: OrgFinanceForm): string | null {
  if (f.enabledCurrencies.length === 0) return 'Enable at least one currency.';
  if (!f.enabledCurrencies.includes(f.defaultCurrency)) return 'The default currency must be one of the enabled currencies.';
  if (f.first.trim() === '' || f.second.trim() === '') return THRESHOLD;
  return thresholdProblem(f.first, f.second);
}
