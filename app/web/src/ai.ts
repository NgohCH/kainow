/**
 * AI configuration screens (sub-project 6): approved models, project connections and keys, limits, usage and the words for
 * blocked AI requests. The pure helpers here word what the screens print and shape what the forms send; the server decides
 * every change again. An API key is never kept: the form clears it as it is submitted and nothing here builds a line from it.
 */
import { api } from './api.ts';
import type { Meaning } from './ui/meanings.ts';

// ---------------------------------------------------------------------------------------------------------------
// Connection states and blocked reasons
// ---------------------------------------------------------------------------------------------------------------

export type DisplayState = 'ready' | 'unchecked' | 'key_rejected' | 'disabled' | 'model_withdrawn' | 'waiting_for_key' | 'key_unreadable';

/** The server's display state already follows the precedence (no protected key, unreadable key, withdrawn model, stored state). */
export const STATE_LABELS: Readonly<Record<DisplayState, string>> = {
  ready: 'Ready',
  unchecked: 'Unchecked',
  key_rejected: 'Key rejected',
  disabled: 'Disabled',
  model_withdrawn: 'Model withdrawn',
  waiting_for_key: 'Waiting for the protected key',
  key_unreadable: 'Key unreadable — enter it again',
};

export const connectionBadge = (state: DisplayState): string => STATE_LABELS[state];

/** How a badge looks: only a working connection is calm; the others ask for attention in words as well as colour. */
export const badgeTone = (state: DisplayState): 'ok' | 'quiet' | 'warn' => (state === 'ready' ? 'ok' : state === 'unchecked' || state === 'disabled' ? 'quiet' : 'warn');

/** The same rule as a meaning: Ready is set up, Unchecked and Disabled are not in use, anything else is failing. */
export const connectionMeaning = (state: DisplayState): Meaning => ({ ok: 'ok', quiet: 'off', warn: 'failing' } as const)[badgeTone(state)];

export const BLOCKED_PREFIX = 'Blocked — ';
const UNKNOWN_BLOCK = 'AI could not run this request';

/**
 * The words after "Blocked — ", for the readiness codes (the same words as the analysis status line) and for the spend codes
 * (the same words as the Ask panel's reasons), so every screen says the same thing the server does.
 */
const BLOCKED_REASON: Readonly<Record<string, string>> = {
  ai_not_set_up: 'AI is not set up for this project',
  no_eligible_connection: 'no AI connection in this project can be used for this right now',
  protected_key_missing: 'the protected key is not installed, so no AI key can be opened',
  project_no_allowance: 'this project has no AI allowance',
  project_allowance_used: 'no AI allowance is left for this project',
  spend_not_configured: 'the AI settings have not been approved yet',
  spend_no_allowance: 'there is no AI allowance',
  spend_user_no_allowance: 'you have no personal AI allowance',
  spend_cap_would_be_exceeded: 'not enough AI allowance is left',
  spend_user_cap_would_be_exceeded: 'not enough of your personal AI allowance is left',
  spend_project_not_configured: 'AI is not set up for this project',
  spend_project_no_allowance: 'the project has no AI allowance',
  spend_project_cap_would_be_exceeded: 'not enough of the project AI allowance is left',
  spend_project_daily_no_allowance: 'the project has no daily AI allowance',
  spend_project_daily_cap_would_be_exceeded: 'not enough of the project daily AI allowance is left',
  spend_project_user_no_allowance: 'you have no personal AI allowance in this project',
  spend_project_user_cap_would_be_exceeded: 'not enough of your personal AI allowance in this project is left',
};

export const isBlockedCode = (code: string | null | undefined): boolean => !!code && Object.prototype.hasOwnProperty.call(BLOCKED_REASON, code);

export function blockedText(code: string | null | undefined): string {
  return `${BLOCKED_PREFIX}${isBlockedCode(code) ? BLOCKED_REASON[code as string] : UNKNOWN_BLOCK}`;
}

/** A blocked request with a restricted source is worded for that case (spec 9); the code is the same. */
export function blockedRunText(code: string | null, detail: string | null): string {
  if (code === 'no_eligible_connection' && detail !== null && /restricted material/i.test(detail)) {
    return `${BLOCKED_PREFIX}no AI connection approved for restricted material`;
  }
  return blockedText(code);
}

export type AmountKind = 'confirmed' | 'uncertain' | 'reserved';
export const amountLabel = (kind: AmountKind): 'Confirmed' | 'Uncertain' | 'Reserved' =>
  kind === 'confirmed' ? 'Confirmed' : kind === 'uncertain' ? 'Uncertain' : 'Reserved';

// ---------------------------------------------------------------------------------------------------------------
// Routes and small words
// ---------------------------------------------------------------------------------------------------------------

/** Who sees a project's AI tab: the Project Manager, Deputy, Owner and Sponsor, and the Administrator (spec 9). */
export const mayViewAiTab = (roles: string[], isAdmin: boolean): boolean => isAdmin || roles.some((r) => r === 'pm' || r === 'deputy_pm' || r === 'owner' || r === 'sponsor');
/** Usage is for those who run the project's AI use: not the Deputy, and not the Administrator standing alone. */
export const mayViewAiUsage = (roles: string[]): boolean => roles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor');

export const aiTabPath = (projectId: string): string => `#/projects/${projectId}/ai`;

/** The project a page address is inside, or null. */
export function projectIdFromHash(hash: string): string | null {
  return /^#\/projects\/([0-9a-f-]{36})(?:\/|$)/i.exec(hash)?.[1] ?? null;
}

export const sourceText = (s: 'organisation' | 'project'): string => (s === 'project' ? 'this project’s own value' : 'the organisation’s value');

/** Six-decimal strings from the server, shown to two places or more when the amount is smaller. */
export function formatMyr(v: string): string {
  const [whole, frac = ''] = v.split('.');
  let f = frac.replace(/0+$/, '');
  if (f.length < 2) f = f.padEnd(2, '0');
  return `MYR ${whole}.${f}`;
}

/** A decimal without its trailing zeros, for a box that shows what is saved (`4.500000` shows as `4.5`). */
export const trimDecimal = (v: string): string => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

export const includesUncertain = (f: { uncertainMyr: string }): string => (Number(f.uncertainMyr) > 0 ? `includes ${formatMyr(f.uncertainMyr)} uncertain` : '');

export const PROVIDER_NAMES: Readonly<Record<string, string>> = { openai: 'OpenAI', anthropic: 'Anthropic' };
export const PURPOSES = ['extraction', 'discussion_analysis', 'minutes_draft', 'question_answer', 'report_draft', 'summary_draft'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PURPOSE_LABELS: Readonly<Record<Purpose, string>> = {
  extraction: 'Extraction',
  discussion_analysis: 'Discussion analysis',
  minutes_draft: 'Minutes drafting',
  question_answer: 'Answering questions',
  report_draft: 'Report drafts',
  summary_draft: 'Summary drafts',
};

/** The bounds of D87, shown beside each number. */
export const BOUNDS = { maxAttempts: [1, 5], timeoutSeconds: [30, 300], concurrency: [1, 10] } as const;
export const boundsText = (b: readonly [number, number]): string => `${b[0]} to ${b[1]}`;

// ---------------------------------------------------------------------------------------------------------------
// Models (Administrator)
// ---------------------------------------------------------------------------------------------------------------

export interface ModelView {
  id: string;
  provider: 'openai' | 'anthropic';
  modelId: string;
  displayName: string;
  prices: { inputUsdPerMillion: string; cachedInputUsdPerMillion: string; cacheWriteUsdPerMillion: string; outputUsdPerMillion: string };
  purposes: Purpose[];
  restrictedOk: boolean;
  dataTerms: string;
  state: 'approved' | 'withdrawn';
}

export interface ModelForm {
  provider: 'openai' | 'anthropic';
  modelId: string;
  displayName: string;
  input: string;
  cached: string;
  cacheWrite: string;
  output: string;
  dataTerms: string;
  purposes: Purpose[];
  restrictedOk: boolean;
  reason: string;
}

export function modelDraft(m: ModelView | null): ModelForm {
  if (!m) {
    return { provider: 'openai', modelId: '', displayName: '', input: '', cached: '', cacheWrite: '0', output: '', dataTerms: '', purposes: [], restrictedOk: false, reason: '' };
  }
  return {
    provider: m.provider,
    modelId: m.modelId,
    displayName: m.displayName,
    input: trimDecimal(m.prices.inputUsdPerMillion),
    cached: trimDecimal(m.prices.cachedInputUsdPerMillion),
    cacheWrite: trimDecimal(m.prices.cacheWriteUsdPerMillion),
    output: trimDecimal(m.prices.outputUsdPerMillion),
    dataTerms: m.dataTerms,
    purposes: [...m.purposes],
    restrictedOk: m.restrictedOk,
    reason: '',
  };
}

export const modelBody = (f: ModelForm) => ({
  provider: f.provider,
  modelId: f.modelId.trim(),
  displayName: f.displayName.trim(),
  inputUsdPerMillion: f.input.trim(),
  cachedInputUsdPerMillion: f.cached.trim(),
  cacheWriteUsdPerMillion: f.cacheWrite.trim() === '' ? '0' : f.cacheWrite.trim(),
  outputUsdPerMillion: f.output.trim(),
  dataTerms: f.dataTerms.trim(),
  purposes: PURPOSES.filter((p) => f.purposes.includes(p)),
  restrictedOk: f.restrictedOk,
  reason: f.reason.trim(),
});

export const listModels = async (): Promise<ModelView[]> => (await api.get<{ models: ModelView[] }>('/ai/models')).models;

// ---------------------------------------------------------------------------------------------------------------
// Project connections and keys
// ---------------------------------------------------------------------------------------------------------------

export interface ConnectionView {
  id: string;
  label: string;
  position: number;
  provider: 'openai' | 'anthropic';
  modelRef: string;
  modelId: string;
  displayName: string;
  state: DisplayState;
  stateLabel: string;
  storedState: 'ready' | 'unchecked' | 'key_rejected' | 'disabled';
  rejectedAt: string | null;
  rejectedStatus: number | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface PickableModel {
  id: string;
  provider: 'openai' | 'anthropic';
  modelId: string;
  displayName: string;
  purposes: Purpose[];
  restrictedOk: boolean;
}

export interface ConnectionsList {
  connections: ConnectionView[];
  editable: boolean;
  /** Disable is open in every project state to a connection manager. */
  mayDisable?: boolean;
  models: PickableModel[];
  protectedKeyLoaded: boolean;
}

export interface CheckResult {
  outcome: 'ok' | 'refused' | 'no_model' | 'unreachable';
  message: string;
}

/** The key box: a password field that the browser is told not to remember. */
export const KEY_INPUT = { type: 'password', autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

export interface AddForm {
  modelRef: string;
  label: string;
  apiKey: string;
  reason: string;
}
export const emptyAddForm = (): AddForm => ({ modelRef: '', label: '', apiKey: '', reason: '' });

/** The form as it is once submitted: the key is gone whether or not the server accepted it. */
export const afterKeySubmit = <T extends { apiKey: string }>(f: T): T => ({ ...f, apiKey: '' });

export const addBody = (f: AddForm) => ({ modelRef: f.modelRef, label: f.label.trim(), apiKey: f.apiKey.trim(), reason: f.reason.trim() });
export const replaceBody = (f: { apiKey: string; reason: string }) => ({ apiKey: f.apiKey.trim(), reason: f.reason.trim() });

/** The whole order after moving one connection a place, or null when it is already at that end. */
export function moveId(ids: string[], id: string, dir: 'up' | 'down'): string[] | null {
  const i = ids.indexOf(id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export const connectionsPath = (projectId: string): string => `/projects/${projectId}/ai/connections`;
export const getConnections = (projectId: string) => api.get<ConnectionsList>(connectionsPath(projectId));

// ---------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------

type Rule = { mode: 'not_applied' } | { mode: 'limit'; limitMyr: string | null };
type Ceiling = { mode: 'not_applied' } | { mode: 'limit'; limitMyr: string };

export interface LimitsView {
  project: { saved: boolean; monthlyLimitMyr: string | null; daily: Rule; userMonthly: Rule; maxAttempts: number | null; timeoutSeconds: number | null };
  organisation: { maxAttempts: number; timeoutSeconds: number; concurrency: number; projectsMaySetLimits: boolean; projectsMayManageConnections: boolean };
  ceiling: Ceiling;
  editable: boolean;
  sources: { maxAttempts: 'organisation' | 'project'; timeoutSeconds: 'organisation' | 'project' };
}

export interface LimitsForm {
  monthly: string;
  dailyMode: 'not_applied' | 'limit';
  daily: string;
  userMode: 'not_applied' | 'limit';
  user: string;
  /** Blank means the organisation's value. */
  attempts: string;
  timeout: string;
  reason: string;
}

const ruleBox = (r: Rule): string => (r.mode === 'limit' && r.limitMyr !== null ? trimDecimal(r.limitMyr) : '');
const ruleBody = (mode: 'not_applied' | 'limit', box: string): Rule => (mode === 'not_applied' ? { mode: 'not_applied' } : { mode: 'limit', limitMyr: box.trim() === '' ? null : box.trim() });

export function limitsDraft(v: LimitsView): LimitsForm {
  const p = v.project;
  return {
    monthly: p.monthlyLimitMyr === null ? '' : trimDecimal(p.monthlyLimitMyr),
    dailyMode: p.daily.mode,
    daily: ruleBox(p.daily),
    userMode: p.userMonthly.mode,
    user: ruleBox(p.userMonthly),
    attempts: p.maxAttempts === null ? '' : String(p.maxAttempts),
    timeout: p.timeoutSeconds === null ? '' : String(p.timeoutSeconds),
    reason: '',
  };
}

/** Blank is sent as null, which means no allowance (or the organisation's number). It is never turned into "unlimited". */
export const limitsBody = (f: LimitsForm) => ({
  monthlyLimitMyr: f.monthly.trim() === '' ? null : f.monthly.trim(),
  daily: ruleBody(f.dailyMode, f.daily),
  userMonthly: ruleBody(f.userMode, f.user),
  maxAttempts: f.attempts.trim() === '' ? null : Number(f.attempts),
  timeoutSeconds: f.timeout.trim() === '' ? null : Number(f.timeout),
  reason: f.reason.trim(),
});

export interface OrgSettings {
  myrPerUsd: string;
  monthlyLimitMyr: string | null;
  daily: Rule;
  userMonthly: Rule;
  projectsMaySetLimits: boolean;
  projectsMayManageConnections: boolean;
  projectCeiling: Ceiling;
  maxAttempts: number;
  timeoutSeconds: number;
  concurrency: number;
}

export interface OrgForm {
  rate: string;
  monthly: string;
  dailyMode: 'not_applied' | 'limit';
  daily: string;
  userMode: 'not_applied' | 'limit';
  user: string;
  ceilingMode: 'not_applied' | 'limit';
  ceiling: string;
  maySetLimits: boolean;
  mayManageConnections: boolean;
  attempts: string;
  timeout: string;
  concurrency: string;
  /** Every change needs one; it is recorded with the previous and new values (spec 7.1). */
  reason: string;
}

export function orgDraft(s: OrgSettings): OrgForm {
  return {
    rate: trimDecimal(s.myrPerUsd),
    monthly: s.monthlyLimitMyr === null ? '' : trimDecimal(s.monthlyLimitMyr),
    dailyMode: s.daily.mode,
    daily: ruleBox(s.daily),
    userMode: s.userMonthly.mode,
    user: ruleBox(s.userMonthly),
    ceilingMode: s.projectCeiling.mode,
    ceiling: s.projectCeiling.mode === 'limit' ? trimDecimal(s.projectCeiling.limitMyr) : '',
    maySetLimits: s.projectsMaySetLimits,
    mayManageConnections: s.projectsMayManageConnections,
    attempts: String(s.maxAttempts),
    timeout: String(s.timeoutSeconds),
    concurrency: String(s.concurrency),
    reason: '',
  };
}

export const orgBody = (f: OrgForm) => ({
  myrPerUsd: f.rate.trim(),
  monthlyLimitMyr: f.monthly.trim() === '' ? null : f.monthly.trim(),
  daily: ruleBody(f.dailyMode, f.daily),
  userMonthly: ruleBody(f.userMode, f.user),
  projectsMaySetLimits: f.maySetLimits,
  projectsMayManageConnections: f.mayManageConnections,
  projectCeiling: f.ceilingMode === 'not_applied' ? { mode: 'not_applied' as const } : { mode: 'limit' as const, limitMyr: f.ceiling.trim() },
  maxAttempts: Number(f.attempts),
  timeoutSeconds: Number(f.timeout),
  concurrency: Number(f.concurrency),
  reason: f.reason.trim(),
});

// ---------------------------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------------------------

export interface Figures {
  confirmedMyr: string;
  uncertainMyr: string;
  reservedMyr: string;
  usedMyr: string;
  requests: number;
  attempts: number;
}
export interface PeriodFigures extends Figures {
  period: { start: string; end: string };
  limitMyr: string | null;
  remainingMyr: string | null;
  dailyLimitApplies?: boolean;
}
export interface ConnectionFigures extends Figures {
  connectionId: string;
  label: string;
  projectId?: string;
  projectName?: string;
  provider: string;
  modelId: string;
  failures: number;
  fallbacks: number;
  chargedFailures: number;
}
export interface ProjectUsage {
  day: PeriodFigures;
  month: PeriodFigures;
  byPerson: Array<Figures & { userId: string; name: string }>;
  system: Array<Figures & { purpose: string }>;
  byConnection: ConnectionFigures[];
}
export interface OrganisationUsage {
  configured: boolean;
  month: PeriodFigures;
  day: PeriodFigures;
  byProject: Array<Figures & { projectId: string; name: string }>;
  byPerson: Array<Figures & { userId: string; name: string }>;
  byConnection: ConnectionFigures[];
  beforeProjects: Figures;
}
export interface MyUsage {
  projects: Array<Figures & { projectId: string; name: string; month: { start: string; end: string }; remaining: { organisationPersonal?: string; projectPersonal?: string } }>;
}

export const purposeLabel = (p: string): string => PURPOSE_LABELS[p as Purpose] ?? p;

// ---------------------------------------------------------------------------------------------------------------
// The header meter
// ---------------------------------------------------------------------------------------------------------------

export interface Meter {
  kind: 'project' | 'personal';
  limitMyr: string | null;
  usedMyr: string;
  remainingMyr: string;
}

/** A meter is only worth showing with its figures (the server sends none before AI settings are saved). */
export const usableMeter = (m: Partial<Meter> | null | undefined): m is Meter =>
  !!m && (m.kind === 'project' || m.kind === 'personal') && typeof m.remainingMyr === 'string' && typeof m.usedMyr === 'string' && (m.limitMyr === null || typeof m.limitMyr === 'string');

export function meterText(m: Meter): string {
  if (m.kind === 'project') {
    return m.limitMyr === null
      ? 'This project has no AI allowance this month'
      : `This project’s AI allowance left this month: ${formatMyr(m.remainingMyr)} of ${formatMyr(m.limitMyr)}`;
  }
  return m.limitMyr === null
    ? 'You have no personal AI allowance in this project this month'
    : `Your AI allowance left in this project this month: ${formatMyr(m.remainingMyr)} of ${formatMyr(m.limitMyr)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Go-live information item
// ---------------------------------------------------------------------------------------------------------------

export interface GoLiveInfo {
  key: string;
  text: string;
  explanation: string;
  link: string;
}

// ---------------------------------------------------------------------------------------------------------------
// The AI page's at-a-glance tables
// ---------------------------------------------------------------------------------------------------------------

const num = (v: string) => Number(v);

export interface ModelRow {
  key: string;
  name: string;
  modelId: string;
  provider: string;
  roles: string;
  projects: string[];
  month: number;
  state: 'approved' | 'withdrawn' | 'unlisted';
}

/** Every approved model, plus any other model used this month, with the projects whose connections used it. */
export function modelRows(models: ModelView[], usage: OrganisationUsage | null): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  const keyOf = (provider: string, modelId: string) => `${provider}:${modelId}`;
  for (const m of models) {
    rows.set(keyOf(m.provider, m.modelId), {
      key: m.id,
      name: m.displayName,
      modelId: m.modelId,
      provider: PROVIDER_NAMES[m.provider] ?? m.provider,
      roles: m.purposes.length === 0 ? 'No kind of work' : m.purposes.map((p) => PURPOSE_LABELS[p]).join(', '),
      projects: [],
      month: 0,
      state: m.state,
    });
  }
  for (const c of usage?.byConnection ?? []) {
    const k = keyOf(c.provider, c.modelId);
    let r = rows.get(k);
    if (!r) {
      r = { key: k, name: c.modelId, modelId: c.modelId, provider: PROVIDER_NAMES[c.provider] ?? c.provider, roles: 'Not on the list', projects: [], month: 0, state: 'unlisted' };
      rows.set(k, r);
    }
    r.month += num(c.usedMyr);
    if (c.projectName && !r.projects.includes(c.projectName)) r.projects.push(c.projectName);
  }
  // A withdrawn model with no use this month is history, not "in use".
  return [...rows.values()].filter((r) => r.state !== 'withdrawn' || r.month > 0 || r.projects.length > 0);
}

export type LimitsPart = 'spending' | 'places' | 'policy';
/** Until the spending limits are saved there is no record for the other boxes to change: they would send a blank exchange rate. */
export const limitsFirst = (part: LimitsPart, saved: boolean): boolean => !saved && part !== 'spending';

/** `unread`: the project's limits could not be read, so `limit` says nothing. */
export interface Near { projectId: string; name: string; used: number; limit: number | null; unread?: boolean }

/** The state of one project against its own monthly limit, in words. */
export function nearLimitState(r: Near): { meaning: 'attention' | 'failing' | 'off' | 'ok'; word: string } {
  if (r.unread) return { meaning: 'attention', word: 'Limit not read' };
  if (r.limit === null) return { meaning: 'off', word: 'No limit saved' };
  const s = r.limit <= 0 ? 1 : r.used / r.limit;
  if (s >= 1) return { meaning: 'failing', word: 'Limit reached' };
  if (s >= 0.8) return { meaning: 'attention', word: 'Near its limit' };
  return { meaning: 'ok', word: 'Within its limit' };
}

/** Projects with use this month, nearest their own monthly limit first; a project with no limit saved comes last. */
export function nearestLimit(rows: Near[]): Near[] {
  const share = (r: Near) => (r.limit === null || r.limit <= 0 ? -1 : r.used / r.limit);
  return [...rows].sort((a, b) => share(b) - share(a) || b.used - a.used);
}

