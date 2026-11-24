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
