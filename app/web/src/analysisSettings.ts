// Helpers for the analysis settings screens (pure, so they can be tested). Spec 7.7.
import { api } from './api.ts';

export const QUIET_MESSAGE = 'The quiet period must be a whole number of minutes from 5 to 30.';
export const NOT_DELEGATED = 'The Administrator has not allowed projects to change automatic analysis.';
export const NOT_EDITOR = 'Only a Project Manager, Owner or Sponsor can change the project’s automatic analysis settings.';
export const ROLLING_LIMIT = 2;
export const ROLLING_WINDOW_MINUTES = 20;

export interface SettingsHistoryRow { id: string; field: string; oldValue: string | null; newValue: string | null; reason: string; actor: string; at: string }

export interface OrgAnalysisView { automatic: boolean; quietMinutes: number; projectsMayChange: boolean; history: SettingsHistoryRow[] }

export interface ProjectAnalysisView {
  automatic: boolean;
  quietMinutes: number;
  projectsMayChange: boolean;
  source: { automatic: 'organisation' | 'project'; quietMinutes: 'organisation' | 'project' };
  own: { automatic: boolean | null; quietMinutes: number | null };
  canEdit: boolean;
  history: SettingsHistoryRow[];
}

export const getOrganisationAnalysis = () => api.get<OrgAnalysisView>('/settings/analysis');
export const putOrganisationAnalysis = (body: Record<string, unknown>) => api.put<OrgAnalysisView>('/settings/analysis', body);
export const getProjectAnalysis = (projectId: string) => api.get<ProjectAnalysisView>(`/projects/${projectId}/settings/analysis`);
export const putProjectAnalysis = (projectId: string, body: Record<string, unknown>) => api.put<ProjectAnalysisView>(`/projects/${projectId}/settings/analysis`, body);

/** The sentence the status box shows, from the effective values (same wording as the server). */
export function explanationSentence(s: { automatic: boolean; quietMinutes: number }): string {
  if (!s.automatic) return 'Automatic analysis is off for this project.';
  return `Automatic analysis: after ${s.quietMinutes} minutes without new messages; maximum ${ROLLING_LIMIT} analyses per thread in any rolling ${ROLLING_WINDOW_MINUTES} minutes.`;
}

/** The quiet period typed: a whole number from 5 to 30, else the refusal text. Checked before anything is sent. */
export function quietError(text: string): string | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return QUIET_MESSAGE;
  const n = Number(t);
  return n >= 5 && n <= 30 ? null : QUIET_MESSAGE;
}

export const SOURCE_TEXT = { organisation: 'From the organisation', project: 'Set for this project' } as const;

/** Where each effective value comes from, in words. */
export const inheritanceLines = (v: ProjectAnalysisView): { automatic: string; quietMinutes: string } => ({
  automatic: SOURCE_TEXT[v.source.automatic],
  quietMinutes: SOURCE_TEXT[v.source.quietMinutes],
});

/** Why a project's values cannot be changed by this viewer, or null when they can. */
export function projectReadOnlyMessage(v: Pick<ProjectAnalysisView, 'canEdit' | 'projectsMayChange'>): string | null {
  if (v.canEdit) return null;
  return v.projectsMayChange ? NOT_EDITOR : NOT_DELEGATED;
}

const FIELD_LABEL: Record<string, string> = { automatic: 'automatic analysis', quiet_minutes: 'quiet period', projects_may_change: 'projects may change automatic analysis' };

const valueText = (field: string, v: string | null): string => {
  if (v === null) return 'the organisation’s value';
  if (field === 'quiet_minutes') return `${v} minutes`;
  if (field === 'projects_may_change') return v === 'true' ? 'allowed' : 'not allowed';
  return v === 'true' ? 'on' : v === 'false' ? 'off' : v;
};

export const historyLine = (h: SettingsHistoryRow): { who: string; what: string; reason: string } => ({
  who: h.actor,
  what: `changed ${FIELD_LABEL[h.field] ?? h.field} from ${valueText(h.field, h.oldValue)} to ${valueText(h.field, h.newValue)}`,
  reason: h.reason,
});

export interface OrgDraft { automatic: boolean; quietText: string; projectsMayChange: boolean }
export const orgDraftFrom = (v: OrgAnalysisView): OrgDraft => ({ automatic: v.automatic, quietText: String(v.quietMinutes), projectsMayChange: v.projectsMayChange });

/** The organisation change to send: only what differs. Null when nothing differs (a refused quiet period is caught by `quietError` first). */
export function organisationChange(v: OrgAnalysisView, d: OrgDraft, reason: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (d.automatic !== v.automatic) out.automatic = d.automatic;
  if (d.projectsMayChange !== v.projectsMayChange) out.projectsMayChange = d.projectsMayChange;
  if (quietError(d.quietText) === null && Number(d.quietText.trim()) !== v.quietMinutes) out.quietMinutes = Number(d.quietText.trim());
  return Object.keys(out).length === 0 ? null : { ...out, reason: reason.trim() };
}

export interface ProjectDraft { automatic: boolean; quietText: string; automaticBack: boolean; quietBack: boolean }
export const projectDraftFrom = (v: ProjectAnalysisView): ProjectDraft => ({ automatic: v.automatic, quietText: String(v.quietMinutes), automaticBack: false, quietBack: false });

/** The project change to send: a changed value, or null to return to the organisation's. Null result when nothing differs. */
export function projectChange(v: ProjectAnalysisView, d: ProjectDraft, reason: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (d.automaticBack) {
    if (v.source.automatic === 'project') out.automatic = null;
  } else if (d.automatic !== v.automatic) out.automatic = d.automatic;
  if (d.quietBack) {
    if (v.source.quietMinutes === 'project') out.quietMinutes = null;
  } else if (quietError(d.quietText) === null && Number(d.quietText.trim()) !== v.quietMinutes) out.quietMinutes = Number(d.quietText.trim());
  return Object.keys(out).length === 0 ? null : { ...out, reason: reason.trim() };
}
