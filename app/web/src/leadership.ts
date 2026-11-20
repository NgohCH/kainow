/**
 * Leadership summary, leadership grants and access settings on the web (dashboards spec sections 6 and 9). The shapes
 * mirror what the server sends (app/src/leadership, app/src/organisation/access-settings*): the web cannot import server
 * code. The field catalogue lives in prefs.ts (which mirrors app/src/leadership/leadership-fields.ts) and is re-exported.
 */
import { LEADERSHIP_FIELDS, type Prefs } from './prefs.ts';
import type { Completion, OnTime, PlannedEnd, Severity } from './dashboard.ts';

export { LEADERSHIP_FIELDS };

export type GrantState = 'scheduled' | 'active' | 'ended' | 'revoked';
export type ScopeKind = 'organisation' | 'departments' | 'projects';

export interface Grant {
  id: string;
  userId: string;
  userName: string;
  email: string;
  accountStatus: string;
  scopeKind: ScopeKind;
  startsOn: string;
  expiresOn: string | null;
  reason: string;
  grantedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  departments: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  events: Array<{ id: string; kind: 'granted' | 'end_changed' | 'revoked'; at: string; reason: string }>;
  state: GrantState;
}

export interface LeadershipCard {
  id: string;
  link: boolean;
  name?: string;
  owningDepartment?: string;
  contributingDepartments?: string[];
  projectManager?: string | null;
  status?: string;
  stage?: { stage: string; substage: string | null; days: number } | null;
  taskCompletion?: Completion;
  onTime?: OnTime;
  plannedEnd?: PlannedEnd;
  overdue?: number;
  blocked?: number;
  significantRisks?: { count: number; items: Array<{ description: string; severity: Severity; reviewOn: string | null }> };
  nextDates?: { nextTaskDue: string | null; nextRiskReview: string | null };
  attentionFlags?: { missingRole: boolean; noIndependentEscalation: boolean; deadlineReview: boolean };
  refresh?: string;
}

export interface LeadershipSummary {
  fields: Array<{ key: string; label: string }>;
  cards: LeadershipCard[];
  departments: Array<{ id: string; name: string }>;
  computedAt: string;
}

const STATE_LABEL: Record<GrantState, string> = { scheduled: 'Scheduled', active: 'Active', ended: 'Ended', revoked: 'Revoked' };
export const grantStateLabel = (state: GrantState): string => STATE_LABEL[state];

/** "The whole organisation", "Departments: A, B (includes projects this department owns now and later)" or "Projects: X". */
export function scopeLabel(g: { scopeKind: ScopeKind; departments: Array<{ name: string }>; projects: Array<{ name: string }> }): string {
  if (g.scopeKind === 'organisation') return 'The whole organisation';
  if (g.scopeKind === 'departments') {
    return `Departments: ${g.departments.map((d) => d.name).join(', ')} (includes projects this department owns now and later)`;
  }
  return `Projects: ${g.projects.map((p) => p.name).join(', ')}`;
}

/**
 * The catalogue fields to draw, in the saved order, minus the hidden ones. A required field is shown even if a saved
 * document lists it as hidden; a catalogue field missing from the saved order goes last; an unknown key is dropped.
 */
export function visibleFields<F extends { key: string; required?: true }>(prefs: Pick<Prefs, 'leadership'>, catalogue: readonly F[]): F[] {
  const { order, hidden } = prefs.leadership.fields;
  const byKey = new Map(catalogue.map((f) => [f.key, f]));
  const seen = new Set<string>();
  const ordered: F[] = [];
  for (const k of [...order, ...catalogue.map((f) => f.key)]) {
    const f = byKey.get(k);
    if (f && !seen.has(k)) {
      seen.add(k);
      ordered.push(f);
    }
  }
  return ordered.filter((f) => f.required === true || !hidden.includes(f.key));
}

/** The reason rule of the server (1 to 1,000 characters after trim); null when fine. */
export function reasonProblem(reason: string): string | null {
  const n = Array.from(reason.trim()).length;
  return n >= 1 && n <= 1000 ? null : 'Give a reason (up to 1,000 characters).';
}

export interface AccessValues {
  archiveAfterMonths: number;
  grantDefaultDays: number;
  grantMaxDays: number;
  invitationValidDays: number;
  analyticsExportAllowed: boolean;
  projectExportsAllowed: boolean;
}
export type AccessBounds = Record<'archiveAfterMonths' | 'grantDefaultDays' | 'grantMaxDays' | 'invitationValidDays', { min: number; max: number }>;

export const ACCESS_ROWS: ReadonlyArray<{ key: keyof AccessBounds; label: string; unit: string; hint: string }> = [
  { key: 'archiveAfterMonths', label: 'Automatic archive delay after closing', unit: 'months', hint: 'How long a Closed project stays in lists before it is archived.' },
  { key: 'grantDefaultDays', label: 'Audit/Oversight default grant length', unit: 'days', hint: 'Not above the maximum. Applies to grants requested afterwards.' },
  { key: 'grantMaxDays', label: 'Audit/Oversight maximum length per grant or extension', unit: 'days', hint: 'Existing grants keep their dates.' },
  { key: 'invitationValidDays', label: 'Project invitations', unit: 'days', hint: 'How long a project invitation stays valid, for invitations sent or resent afterwards.' },
];

/** A plain-words problem with the values before they are sent; null when fine. The server checks again. */
export function settingsProblem(v: AccessValues, bounds: AccessBounds): string | null {
  for (const row of ACCESS_ROWS) {
    const { min, max } = bounds[row.key];
    const n = v[row.key];
    if (typeof n !== 'number' || !Number.isInteger(n)) return `${row.label}: enter a whole number.`;
    if (n < min || n > max) return `${row.label} must be ${min}–${max} ${row.unit}.`;
  }
  if (v.grantDefaultDays > v.grantMaxDays) {
    return `Default grant length (${v.grantDefaultDays} days) cannot be longer than the maximum (${v.grantMaxDays} days).`;
  }
  return null;
}

export const DEFAULT_STATUSES = ['planned', 'active', 'deferred'] as const;

/** The query string for `GET /dashboard/leadership`; empty for the defaults. */
export function leadershipQuery(f: { statuses: readonly string[]; department: string; includeArchived: boolean }): string {
  const q = new URLSearchParams();
  const isDefault = f.statuses.length === DEFAULT_STATUSES.length && DEFAULT_STATUSES.every((s) => f.statuses.includes(s));
  if (!isDefault) q.set('status', f.statuses.join(','));
  if (f.department) q.set('department', f.department);
  if (f.includeArchived) q.set('includeArchived', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}
