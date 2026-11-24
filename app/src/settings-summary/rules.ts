/**
 * The Settings hub's boxes (spec 7.8): one pure function per setting, from plain inputs to what the box shows.
 * Nothing here reads a database. Values are counts and configuration only, never a project's title or wording.
 */

export const SETTING_KEYS = [
  'organisation', 'administrators', 'departments', 'domains', 'leadership',
  'approvals', 'reminders', 'access', 'resources', 'reportTypes', 'stageTemplates',
  'ai', 'emailDelivery', 'storage',
  'operations', 'goLive', 'escalatedFeedback', 'securityReview',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export type SettingState = 'ok' | 'attention' | 'failing' | 'off' | 'unknown';

export interface SettingSummary {
  key: SettingKey;
  state: SettingState;
  stateWord: string;
  /** At most three. */
  values: { label: string; value: string }[];
  note?: string;
}

type Value = SettingSummary['values'][number];

const WORDS: Record<SettingState, string> = {
  ok: 'Set up',
  attention: 'Needs attention',
  failing: 'Failing',
  off: 'Not in use',
  unknown: 'Could not check',
};

function make(key: SettingKey, state: SettingState, values: Value[], note?: string): SettingSummary {
  return { key, state, stateWord: WORDS[state], values: values.slice(0, 3), ...(note ? { note } : {}) };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const yesNo = (b: boolean): string => (b ? 'Yes' : 'No');
const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic' };

/** A setting whose inputs could not be read: the reason is plain words, never an error text. */
export function unknownSetting(key: SettingKey, note: string): SettingSummary {
  return make(key, 'unknown', [], note);
}

export function organisationRule(i: { name: string | null; logosUploaded: number; protectedKeyLoaded: boolean; casesWaitingForKey: number }): SettingSummary {
  const warn = !i.protectedKeyLoaded || i.casesWaitingForKey > 0;
  return make(
    'organisation',
    warn ? 'attention' : 'ok',
    [
      { label: 'Name', value: i.name ?? 'Not set' },
      { label: 'Logos', value: `${i.logosUploaded} of 2 uploaded` },
      { label: 'Protected key', value: i.protectedKeyLoaded ? 'Loaded' : 'Not loaded' },
    ],
    warn ? 'The protected key is missing or held cases are waiting for it. Open the page for the warning.' : undefined,
  );
}

export function administratorsRule(i: { administrators: number; activePeople: number; disabledPeople: number }): SettingSummary {
  return make('administrators', 'ok', [
    { label: 'Administrators', value: String(i.administrators) },
    { label: 'Active people', value: String(i.activePeople) },
    { label: 'Disabled', value: String(i.disabledPeople) },
  ]);
}

export function departmentsRule(i: { active: number; retired: number }): SettingSummary {
  return make('departments', 'ok', [
    { label: 'Active', value: String(i.active) },
    { label: 'Retired', value: String(i.retired) },
  ]);
}

export function domainsRule(i: { domains: number }): SettingSummary {
  return make('domains', 'ok', [{ label: 'Eligible domains', value: String(i.domains) }]);
}

/** `waitingForAction` counts grants that are Active or scheduled but whose person's account is not Active, so the access cannot be used. */
export function leadershipRule(i: { active: number; scheduled: number; waitingForAction: number }): SettingSummary {
  const waiting = i.waitingForAction > 0;
  return make(
    'leadership',
    waiting ? 'attention' : 'ok',
    [
      { label: 'Active', value: String(i.active) },
      { label: 'Scheduled', value: String(i.scheduled) },
      { label: 'Waiting for action', value: String(i.waitingForAction) },
    ],
    waiting ? 'Some access is held by an account that is not Active.' : undefined,
  );
}

export function approvalsRule(i: { required: number; projectsMayOverride: boolean; pending: number }): SettingSummary {
  return make('approvals', 'ok', [
    { label: 'Approvals required', value: String(i.required) },
    { label: 'Projects may change it', value: yesNo(i.projectsMayOverride) },
    { label: 'Requests waiting', value: String(i.pending) },
  ]);
}

export function remindersRule(i: { leadDays: number[]; escalationDays: number; dayCounting: 'working' | 'calendar' }): SettingSummary {
  return make('reminders', 'ok', [
    { label: 'Reminders', value: i.leadDays.length ? `${i.leadDays.join(', ')} days before` : 'None' },
    { label: 'Escalate after', value: plural(i.escalationDays, 'day') },
    { label: 'Counting', value: i.dayCounting === 'working' ? 'Working days' : 'Calendar days' },
  ]);
}

export function accessRule(i: { archiveAfterMonths: number; grantDefaultDays: number; projectExportsAllowed: boolean }): SettingSummary {
  return make('access', 'ok', [
    { label: 'Archive closed projects after', value: plural(i.archiveAfterMonths, 'month') },
    { label: 'Access grants last', value: plural(i.grantDefaultDays, 'day') },
    { label: 'Project exports', value: i.projectExportsAllowed ? 'Allowed' : 'Not allowed' },
  ]);
}

export function resourcesRule(i: { defaultCurrency: string; enabledCurrencies: number; projectsMayManageFinance: boolean }): SettingSummary {
  return make('resources', 'ok', [
    { label: 'Default currency', value: i.defaultCurrency },
    { label: 'Currencies in use', value: String(i.enabledCurrencies) },
    { label: 'Projects manage finance', value: yesNo(i.projectsMayManageFinance) },
  ]);
}

export function reportTypesRule(i: { active: number; retired: number }): SettingSummary {
  return make('reportTypes', 'ok', [
    { label: 'Active', value: String(i.active) },
    { label: 'Retired', value: String(i.retired) },
  ]);
}

/** Active templates in catalogue order: the count, up to three names (then "and N more"), and the retired count. */
export function stageTemplatesRule(i: { activeNames: string[]; retired: number }): SettingSummary {
  const shown = i.activeNames.slice(0, 3);
  const more = i.activeNames.length - shown.length;
  return make('stageTemplates', 'ok', [
    { label: 'Active', value: String(i.activeNames.length) },
    { label: 'Templates', value: shown.length ? `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : 'None' },
    { label: 'Retired', value: String(i.retired) },
  ]);
}

/** Approved models as "<model id> (<Provider>)"; the fallback is each project's own connection order. */
export function aiRule(i: { models: { modelId: string; provider: string }[] }): SettingSummary {
  const names = i.models.map((m) => `${m.modelId} (${PROVIDER_NAMES[m.provider] ?? m.provider})`);
  if (names.length === 0) {
    return make('ai', 'attention', [{ label: 'Approved models', value: 'None' }], 'No model is approved, so AI features cannot run.');
  }
  const shown = names.slice(0, 2);
  const more = names.length - shown.length;
  return make('ai', 'ok', [
    { label: 'Approved models', value: `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}` },
    { label: 'Fallback', value: 'Set in each project' },
  ]);
}

export function emailDeliveryRule(i: { provider: string; failedLast24h: number; waiting: number }): SettingSummary {
  const failing = i.failedLast24h > 0;
  return make(
    'emailDelivery',
    failing ? 'failing' : 'ok',
    [
      { label: 'Provider', value: i.provider === 'log' ? 'Log only (nothing is sent)' : i.provider === 'm365' ? 'Microsoft 365' : 'SMTP' },
      { label: 'Failed in the last 24 hours', value: String(i.failedLast24h) },
      { label: 'Waiting to send', value: String(i.waiting) },
    ],
    failing ? 'At least one email failed in the last 24 hours.' : undefined,
  );
}

export type StorageConnection = 'connected' | 'not_configured' | 'protected_key_missing' | 'refused' | 'unreachable' | 'not_checked';

const CONNECTION_WORDS: Record<StorageConnection, string> = {
  connected: 'Connected',
  not_configured: 'Not set up',
  protected_key_missing: 'Protected key missing',
  refused: 'Refused',
  unreachable: 'Unreachable',
  not_checked: 'Not checked yet',
};

/** Off when no destination is approved; failing when the provider refuses or cannot be reached. */
export function storageRule(i: { approvedDestinations: number; connection: StorageConnection; failedFiles: number; sharingToRepair: number }): SettingSummary {
  const values: Value[] = [
    { label: 'Destinations approved', value: String(i.approvedDestinations) },
    { label: 'Connection', value: CONNECTION_WORDS[i.connection] },
    { label: 'Files failed', value: String(i.failedFiles) },
  ];
  if (i.approvedDestinations === 0) return make('storage', 'off', values);
  if (i.connection === 'refused' || i.connection === 'unreachable') return make('storage', 'failing', values, 'Kainow cannot reach the storage provider.');
  if (i.connection === 'protected_key_missing' || i.failedFiles > 0 || i.sharingToRepair > 0) {
    return make('storage', 'attention', values, 'Some files or folder sharing need attention.');
  }
  return make('storage', 'ok', values);
}

export interface OperationsInput {
  backupStatus: 'healthy' | 'last_failed' | 'target_exceeded' | 'none';
  worstStorageLevel: 'normal' | 'warning' | 'critical' | 'unknown';
  protectiveOn: boolean;
  lastDrill: 'passed' | 'passed_over_target' | 'failed' | 'running' | null;
}

/** The Operations page's own status: protective mode, a failed backup or a critical disk is failing; anything short of healthy needs attention. */
export function operationsRule(i: OperationsInput): SettingSummary {
  const backups = { healthy: 'Healthy', last_failed: 'Last backup failed', target_exceeded: 'Recovery target exceeded', none: 'No backup yet' }[i.backupStatus];
  const disks = { normal: 'Normal', warning: 'Warning', critical: 'Critical', unknown: 'No recent reading' }[i.worstStorageLevel];
  const values: Value[] = [
    { label: 'Backups', value: backups },
    { label: 'Disks', value: disks },
    { label: 'Protective mode', value: i.protectiveOn ? 'On' : 'Off' },
  ];
  if (i.protectiveOn || i.backupStatus === 'last_failed' || i.worstStorageLevel === 'critical') return make('operations', 'failing', values);
  const drillWarn = i.lastDrill === 'failed' || i.lastDrill === 'passed_over_target';
  if (i.backupStatus !== 'healthy' || i.worstStorageLevel !== 'normal' || drillWarn) return make('operations', 'attention', values);
  return make('operations', 'ok', values);
}

/** Ok when the checklist is closed; while it is open the work is not finished. */
export function goLiveRule(i: { open: boolean; done: number; total: number }): SettingSummary {
  return make('goLive', i.open ? 'attention' : 'ok', [
    { label: 'Checklist', value: i.open ? 'Open' : 'Closed' },
    { label: 'Steps done', value: `${i.done} of ${i.total}` },
  ]);
}

export function escalatedFeedbackRule(i: { open: number }): SettingSummary {
  return make('escalatedFeedback', i.open > 0 ? 'attention' : 'ok', [{ label: 'Open', value: String(i.open) }]);
}

export function securityReviewRule(i: { heldCases: number; waitingForKey: number }): SettingSummary {
  const waiting = i.waitingForKey > 0;
  return make(
    'securityReview',
    waiting ? 'attention' : 'ok',
    [
      { label: 'Held cases', value: String(i.heldCases) },
      { label: 'Waiting for the key', value: String(i.waitingForKey) },
    ],
    waiting ? 'Held cases are waiting for the protected key.' : undefined,
  );
}

const COULD_NOT_READ = 'Kainow could not read this setting just now. Open its page to see it.';

/** Runs one setting's read; a failure becomes an "unknown" box, so one broken read never hides the others. */
export async function settle(key: SettingKey, read: () => Promise<SettingSummary>): Promise<SettingSummary> {
  try {
    return await read();
  } catch {
    return unknownSetting(key, COULD_NOT_READ);
  }
}
