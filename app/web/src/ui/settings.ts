/** What GET /admin/settings/summary returns, and how a setting's state shows (spec 7.8). Task 11 adds the catalogue here. */
import type { Meaning } from './meanings.ts';

export type SettingKey =
  | 'organisation' | 'administrators' | 'departments' | 'domains' | 'leadership' | 'approvals' | 'reminders' | 'access'
  | 'resources' | 'reportTypes' | 'stageTemplates' | 'ai' | 'emailDelivery' | 'storage' | 'operations' | 'goLive'
  | 'escalatedFeedback' | 'securityReview';

export type SettingState = 'ok' | 'attention' | 'failing' | 'off' | 'unknown';

export interface SettingSummary {
  key: SettingKey;
  state: SettingState;
  stateWord: string;
  values: { label: string; value: string }[];
  note?: string;
}

/** ok, attention and failing show as themselves; off and unknown both show as "not in use" grey. */
export function settingMeaning(state: SettingState): Meaning {
  return state === 'off' || state === 'unknown' ? 'off' : state;
}

export type SettingGroup = 'Organisation and people' | 'Work rules' | 'Connections' | 'Running Kainow';
export interface SettingEntry { key: SettingKey; group: SettingGroup; title: string; purpose: string; href: string; reviewerOnly?: true }

/** The 18 organisation-wide settings, in the order of spec 7.8, with the address each one keeps. */
export const SETTINGS_CATALOGUE: SettingEntry[] = [
  { key: 'organisation', group: 'Organisation and people', title: 'Organisation', purpose: 'Name, logos, colour and recovery custodian.', href: '#/organisation' },
  { key: 'administrators', group: 'Organisation and people', title: 'Administrators', purpose: 'Who can administer Kainow, and their accounts.', href: '#/people' },
  { key: 'departments', group: 'Organisation and people', title: 'Departments', purpose: 'The list projects choose their owning department from.', href: '#/departments' },
  { key: 'domains', group: 'Organisation and people', title: 'Email domains', purpose: 'The email domains people may be invited at.', href: '#/domains' },
  { key: 'leadership', group: 'Organisation and people', title: 'Leadership access', purpose: 'Who sees leadership summaries, for which projects, until when.', href: '#/leadership-grants' },
  { key: 'approvals', group: 'Work rules', title: 'Approvals', purpose: 'Who approves changes and how long approvals wait.', href: '#/approvals' },
  { key: 'reminders', group: 'Work rules', title: 'Reminders and email', purpose: 'When Kainow reminds people and which emails it sends.', href: '#/notifications-settings' },
  { key: 'access', group: 'Work rules', title: 'Access and records', purpose: 'Sign-in, sessions and how long records are kept.', href: '#/access-settings' },
  { key: 'resources', group: 'Work rules', title: 'Resources and finance', purpose: 'Resource types, rates and finance rules.', href: '#/resources-admin' },
  { key: 'reportTypes', group: 'Work rules', title: 'Report types', purpose: 'The kinds of report projects can produce.', href: '#/report-types' },
  { key: 'stageTemplates', group: 'Work rules', title: 'Stage templates', purpose: 'Ready-made stage lists for new projects.', href: '#/stage-templates' },
  { key: 'ai', group: 'Connections', title: 'AI', purpose: 'Approved models, roles and usage limits.', href: '#/ai' },
  { key: 'emailDelivery', group: 'Connections', title: 'Email delivery', purpose: 'Whether Kainow emails are being delivered.', href: '#/deliveries' },
  { key: 'storage', group: 'Connections', title: 'Storage', purpose: 'Where files and backups are kept.', href: '#/storage' },
  { key: 'operations', group: 'Running Kainow', title: 'Operations', purpose: 'Backups, disk space and the health of Kainow.', href: '#/admin/operations' },
  { key: 'goLive', group: 'Running Kainow', title: 'Go-live checklist', purpose: 'What is left to do before people use Kainow.', href: '#/go-live' },
  { key: 'escalatedFeedback', group: 'Running Kainow', title: 'Escalated feedback', purpose: 'Feedback passed up to administrators.', href: '#/escalated-feedback' },
  { key: 'securityReview', group: 'Running Kainow', title: 'Security review', purpose: 'Held cases and grant requests for designated reviewers.', href: '#/security/cases', reviewerOnly: true },
];

/** Settings whose title or purpose contains the query, ignoring case; an empty query keeps all. */
export function filterSettings<T extends { title: string; purpose: string }>(catalogue: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q === '' ? catalogue : catalogue.filter((s) => s.title.toLowerCase().includes(q) || s.purpose.toLowerCase().includes(q));
}

/** How many settings are in each state; unknown counts as off. */
export function summaryCounts(summaries: { state: SettingState }[]): { ok: number; attention: number; failing: number; off: number } {
  const n = { ok: 0, attention: 0, failing: 0, off: 0 };
  for (const s of summaries) n[s.state === 'unknown' ? 'off' : s.state] += 1;
  return n;
}
