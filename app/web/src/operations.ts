// The Operations page (V1.0 sub-project 10a, spec 10): words and shapes for what the server sends. Pure; no paths, keys or
// connection strings ever reach this file (the server sends none).

export type BackupStatus = 'healthy' | 'last_failed' | 'target_exceeded' | 'none';
export type StorageLevel = 'normal' | 'warning' | 'critical' | 'unknown';
export type StorageLocation = 'database_disk' | 'backup_disk' | 'source_area';
export type DrillOutcome = 'running' | 'passed' | 'passed_over_target' | 'failed';

/** The fixed protective-mode texts (spec 7.3, D114) and the restored-email status. */
export const BANNER_EVERYONE = 'Kainow is read-only for now to protect your data. You can read everything; changes are paused.';
export const PROTECTIVE_TEXT = 'Kainow is read-only for now to protect your data. Nothing you have saved is affected.';
export const NOT_SENT_RESTORED = 'Not sent — restored from backup';

/** The scheduled update as the banner route sends it (from approval until the update starts). */
export interface ScheduledInfo {
  startsAt: string;
  expectedMinutes: number;
  text?: string;
}

export interface BannerData {
  protective: boolean;
  /** 'update' while Kainow is in update maintenance (10b spec 7.1). */
  reason?: 'update';
  text?: string;
  scheduled?: ScheduledInfo | null;
  /** For an Enterprise Administrator: the backup and storage line, and the failed-update warning (10b spec 11). */
  admin?: { backups: BackupStatus; storage: StorageLevel; text: string; link: string; recovery?: string | null };
}

export interface DrillCheck {
  name: string;
  result: string;
  detail?: string;
}

export interface BackupRun {
  id: string;
  kind: 'daily' | 'manual' | 'pre_update';
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'succeeded' | 'failed';
  failureCode: string | null;
  failureText: string | null;
  durationSeconds: number | null;
  /** The size of the ENCRYPTED database dump in the set, not of the live database. */
  databaseEncryptedBytes: number | null;
  filesTotal: number | null;
  filesNew: number | null;
  filesNewBytes: number | null;
  filesNotCopied: number | null;
  sourceArea: 'included' | 'not_in_use' | null;
  keyId: string | null;
  expired: boolean;
}

export interface Drill {
  id: string;
  setName: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: DrillOutcome;
  durationSeconds: number | null;
  sampled: boolean;
  checks: DrillCheck[];
  failureCode: string | null;
  failureText: string | null;
  keyId: string | null;
  folderLabel: string | null;
}

export interface StorageRow {
  location: StorageLocation;
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  usedPct: number | null;
  level: StorageLevel;
  at: string | null;
  unavailable: boolean;
}

export interface GrowthRow {
  day: string;
  location: StorageLocation;
  maxUsedBytes: number | null;
  minFreeBytes: number | null;
  totalBytes: number | null;
}

export interface Protective {
  on: boolean;
  reason: 'low_space' | 'restored_from_backup' | 'update' | null;
  since: string | null;
  setTime: string | null;
  setName: string | null;
  text: string;
}

export interface Health {
  database: 'up';
  migrationsCurrent: boolean;
  lastSweepAt: string | null;
  queues: { name: string; queued: number; active: number; failed24h: number }[];
}

export interface OperationsView {
  backups: {
    status: BackupStatus;
    lastSuccess: BackupRun | null;
    lastAttempt: BackupRun | null;
    retentionDays: number;
    folderLabel: string | null;
    keyId: string | null;
    drillAgain: string | null;
    runs: BackupRun[];
  };
  drills: { last: Drill | null; earlier: Drill[]; kept: { name: string; drillId: string }[]; stray: string[] };
  storage: { locations: StorageRow[]; safeFloorGb: number };
  growth: GrowthRow[];
  protective: Protective;
  health: Health;
  updates: UpdatesSummary;
}

/** The Administrator analytics panel `operations` (no run tables). */
export interface OperationsPanelData {
  status: {
    backups: Omit<OperationsView['backups'], 'runs'>;
    lastDrill: Drill | null;
    storage: OperationsView['storage'];
    growth: GrowthRow[];
    protective: Protective;
    health: Health;
    updates: UpdatesSummary;
  };
  period: {
    backups: { total: number; succeeded: number; failed: number };
    drills: { total: number; passed: number; failed: number };
    updates: { total: number; succeeded: number; failed: number; cancelled: number; open: number };
  };
  computedAt: string;
}

export interface OpsSettingsValues {
  backupRetentionDays: number;
  storageWarningPct: number;
  storageCriticalPct: number;
  safeFloorGb: number;
  diagnosticRetentionDays: number;
}

export const SETTING_ROWS: Array<{ key: keyof OpsSettingsValues; label: string; unit: string; hint: string }> = [
  { key: 'backupRetentionDays', label: 'Keep backups for', unit: 'days', hint: 'Older backups are removed by expiry.' },
  { key: 'storageWarningPct', label: 'Storage warning level', unit: '% used', hint: 'Administrators get a warning when a disk reaches this.' },
  { key: 'storageCriticalPct', label: 'Storage critical level', unit: '% used', hint: 'Must be higher than the warning level.' },
  { key: 'safeFloorGb', label: 'Safe floor of free space on the database disk', unit: 'GB', hint: 'Below this, Kainow turns protective read-only mode on.' },
  { key: 'diagnosticRetentionDays', label: 'Keep diagnostic readings for', unit: 'days', hint: 'Storage readings and similar records.' },
];

export interface SettingsData {
  settings: OpsSettingsValues;
  defaults: OpsSettingsValues;
  bounds: Record<keyof OpsSettingsValues, { min: number; max: number }>;
  changes: Array<{ id: string; at: string; reason: string; actor: string; previous: OpsSettingsValues; next: OpsSettingsValues }>;
  rules: { criticalAboveWarning: true; storageCriticalEffectiveMin: number };
}

export interface ResumeChecks {
  protective: boolean;
  checks: Array<{ name: string; passed: boolean }>;
  at: string;
}

export function backupStatusWords(status: BackupStatus): 'Healthy' | 'Last backup failed' | '24-hour recovery target exceeded' | 'No backup yet' {
  switch (status) {
    case 'healthy':
      return 'Healthy';
    case 'last_failed':
      return 'Last backup failed';
    case 'target_exceeded':
      return '24-hour recovery target exceeded';
    default:
      return 'No backup yet';
  }
}

export function levelWords(level: StorageLevel): string {
  switch (level) {
    case 'normal':
      return 'Normal';
    case 'warning':
      return 'Warning';
    case 'critical':
      return 'Critical';
    default:
      return 'No recent reading';
  }
}

const LOCATION_WORDS: Record<StorageLocation, string> = { database_disk: 'Database disk', backup_disk: 'Backup disk', source_area: 'Source area' };
export const locationWords = (l: StorageLocation): string => LOCATION_WORDS[l] ?? String(l).replace(/_/g, ' ');

const RESUME_WORDS: Record<string, string> = {
  reading_fresh: 'The database disk was measured in the last 10 minutes',
  space_above_floor: 'Free space on the database disk is at or above the safe floor',
  database: 'The database answers',
  migrations_current: 'The database is at the migration level this version of Kainow expects',
  no_backup_running: 'No backup is running',
};
export function resumeCheckWords(name: string): string {
  return RESUME_WORDS[name] ?? name.replace(/_/g, ' ');
}

/** Sizes in binary units; null is "Unavailable", never zero. */
export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'Unavailable';
  if (n < 1024) return `${Math.round(n).toLocaleString('en-GB')} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * The banner's lines. For an Enterprise Administrator first the failed-update warning; then, for everyone, the update
 * maintenance text (in the protective slot, instead of the protective sentence) or the protective sentence, and the
 * scheduled update until it starts; last the backup and storage line for an Administrator.
 */
export function bannerLines(banner: BannerData, isAdmin: boolean, now: Date = new Date()): string[] {
  const lines: string[] = [];
  if (isAdmin && banner.admin?.recovery) lines.push(banner.admin.recovery);
  const updating = banner.protective && banner.reason === 'update';
  if (banner.protective) lines.push(updating ? UPDATE_TEXT : BANNER_EVERYONE);
  const scheduled = scheduledBanner(banner.scheduled ?? null, now);
  if (scheduled && !updating) lines.push(scheduled);
  if (isAdmin && banner.admin?.text) lines.push(banner.admin.text);
  return lines;
}

/** The table equivalent of the growth chart: one row per day, oldest first (pass the rows of one location). */
export function growthTable(rows: GrowthRow[]): Array<{ day: string; used: string; free: string }> {
  return [...rows]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((r) => ({ day: r.day, used: formatBytes(r.maxUsedBytes), free: formatBytes(r.minFreeBytes) }));
}

export function drillOutcomeWords(o: DrillOutcome): string {
  switch (o) {
    case 'passed':
      return 'Passed';
    case 'passed_over_target':
      return 'Passed, but slower than the 4-hour target';
    case 'failed':
      return 'Failed';
    default:
      return 'Running';
  }
}

const CHECK_NAMES: Record<string, string> = {
  set_checksums: 'Backup checksums',
  migration_level: 'Migration level',
  space: 'Space for the drill',
  decrypt: 'Decryption',
  restore: 'Restore',
  row_counts: 'Row counts',
  source_files: 'Source files',
  duration: 'Duration against 4 hours',
};
export const checkNameWords = (n: string): string => CHECK_NAMES[n] ?? n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function checkResultWords(r: string): string {
  if (r === 'passed') return 'Passed';
  if (r === 'failed') return 'Failed';
  if (r === 'not_tested') return 'Not tested';
  return r.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Why a drill failed. With a failure code, the server's fixed text. A failed drill can have no code: then each failed
 * check is listed by name (with its fixed detail).
 */
export function drillFailureLines(d: Pick<Drill, 'outcome' | 'failureCode' | 'failureText' | 'checks'>): string[] {
  if (d.outcome !== 'failed') return [];
  if (d.failureCode && d.failureText) return [d.failureText];
  const failed = d.checks.filter((c) => c.result === 'failed').map((c) => `${checkNameWords(c.name)}: failed.${c.detail ? ` ${c.detail}` : ''}`);
  if (failed.length > 0) return failed;
  return d.failureText ? [d.failureText] : ['The drill failed. No check is recorded as failed.'];
}

export function durationWords(seconds: number | null): string {
  if (seconds === null) return 'Not finished';
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${seconds % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function runOutcomeWords(r: Pick<BackupRun, 'outcome' | 'expired'>): string {
  const base = r.outcome === 'succeeded' ? 'Succeeded' : r.outcome === 'failed' ? 'Failed' : 'Running';
  return r.expired ? `${base}, removed by expiry` : base;
}

export const KIND_WORDS: Record<BackupRun['kind'], string> = { daily: 'Daily', manual: 'Manual', pre_update: 'Before an update' };

// --- Updates (V1.0 sub-project 10b, spec 6, 7, 11) ---

/** The fixed update texts (globals). */
export const UPDATE_TEXT = 'Kainow is being updated. You can read; changes are paused until the update finishes.';
export const APPROVAL_HINT = 'The update takes its own backup first and stops if that backup fails.';
export const RELEASE_CHECK_NOTE = 'Signature checked before installing.';
export const NO_FRESH_BACKUP_TEXT = 'Updates are refused until a backup succeeds. See Backups above.';

export type UpdateState =
  | 'approved' | 'preparing' | 'ready' | 'installing' | 'succeeded' | 'refused'
  | 'failed_before_install' | 'failed_after_migration' | 'failed_needs_attention' | 'recovered' | 'cancelled';
export const OPEN_UPDATE_STATES: readonly UpdateState[] = ['approved', 'preparing', 'ready', 'installing'];
/** Before the window starts an Administrator may still change the time or cancel. */
export const CHANGEABLE_UPDATE_STATES: readonly UpdateState[] = ['approved', 'preparing', 'ready'];
/**
 * A latest update in one of these still needs the Administrator (approve again, or recover). `recovered` does not: the
 * restore put Kainow back on the previous version and Resume ended it (final review #40).
 */
const FAILED_UPDATE_STATES: readonly UpdateState[] = ['refused', 'failed_before_install', 'failed_after_migration', 'failed_needs_attention'];

export interface UpdateStep {
  step: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'passed' | 'failed' | 'skipped';
  failureCode: string | null;
  failureText: string | null;
}

export interface UpdateView {
  id: string;
  fromVersion: string;
  toVersion: string;
  tag: string;
  commit: string;
  state: UpdateState;
  stateWords: string;
  startsAt: string;
  expectedMinutes: number;
  approvedBy: { id: string; name: string };
  approvedAt: string;
  reason: string;
  cancelledBy: { id: string; name: string } | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  reminderSentAt: string | null;
  releaseNotes: string | null;
  failureCode: string | null;
  failureText: string | null;
  finishedAt: string | null;
  steps: UpdateStep[];
}

export interface LatestCheck {
  latest: {
    at: string;
    trigger: 'daily' | 'manual';
    outcome: 'found' | 'none_newer' | 'failed';
    failureCode: 'unreachable' | 'bad_response' | 'rate_limited' | null;
    newestTag: string | null;
    newestCommit: string | null;
  } | null;
  lastSuccessAt: string | null;
  stale: boolean;
}

/** GET /admin/updates. */
export interface UpdatesData {
  running: string;
  keyFingerprint: string | null;
  lastCheck: LatestCheck;
  available: { tag: string; commit: string; releaseUrl: string } | null;
  current: UpdateView | null;
  history: UpdateView[];
  needsRecovery: boolean;
}

/** The status strip's Updates item, as the Operations view and the analytics panel send it. */
export interface UpdatesSummary {
  /** The latest update's state (newest approval first), null when there has been none. */
  latestState: UpdateState | null;
  latestToVersion: string | null;
  /** The latest update's start time when it is open. */
  startsAt: string | null;
  /** The newest release newer than the running one, if any check found one. */
  available: string | null;
  lastCheckAt: string | null;
  /** Three days without a successful release check. */
  stale: boolean;
}

export type UpdateStatusWord = 'Up to date' | 'Update available' | 'Update scheduled' | 'Update failed' | 'Not checked for 3 days' | 'Not checked yet';

/**
 * One word for the strip: an open update, then a failed one, then a stale check, then an available release; "Up to
 * date" only once a check has run (final review #39).
 */
export function updateStatusWord(u: UpdatesSummary): UpdateStatusWord {
  if (u.latestState && OPEN_UPDATE_STATES.includes(u.latestState)) return 'Update scheduled';
  if (u.latestState && FAILED_UPDATE_STATES.includes(u.latestState)) return 'Update failed';
  if (u.stale) return 'Not checked for 3 days';
  if (u.available) return 'Update available';
  if (!u.lastCheckAt) return 'Not checked yet';
  return 'Up to date';
}

const UTC8_MS = 8 * 3_600_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** { date: 'Mon 30 Nov', time: '22:00' } in UTC+8, as the server's emails and banner. */
export function updateWhen(iso: string): { date: string; time: string } {
  const d = new Date(new Date(iso).getTime() + UTC8_MS);
  return { date: `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, time: d.toISOString().slice(11, 16) };
}

/** The scheduled-update banner (fixed text), or '' when there is none or it has started. */
export function scheduledBanner(s: Pick<ScheduledInfo, 'startsAt' | 'expectedMinutes'> | null, now: Date): string {
  if (!s) return '';
  const t = Date.parse(s.startsAt);
  if (!Number.isFinite(t) || t <= now.getTime()) return '';
  const { date, time } = updateWhen(s.startsAt);
  return `Kainow will be unavailable on ${date} from ${time} for about ${s.expectedMinutes} minutes for an update.`;
}

/** A datetime-local value ('2026-11-22T10:15') read as UTC+8; NaN when it is not one. */
export function startFromInput(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? new Date(`${value}:00+08:00`) : new Date(NaN);
}

/** A stored time as a datetime-local value in UTC+8. */
export function inputFromStart(iso: string): string {
  return new Date(new Date(iso).getTime() + UTC8_MS).toISOString().slice(0, 16);
}

/**
 * "As soon as possible": now + 15 minutes, rounded up to the next whole minute plus one, so the time is still at least
 * 15 minutes ahead when the form is sent a little later.
 */
export function soonestStartValue(now: Date): string {
  const t = Math.ceil((now.getTime() + 16 * 60_000) / 60_000) * 60_000;
  return inputFromStart(new Date(t).toISOString());
}

const MIN = 60_000;
/** Instant feedback with the server's bounds and words (spec 6.3); the server stays the judge. */
export function approvalFormProblem(input: { startsAt: string; expectedMinutes: number; reason: string }, now: Date): string | null {
  const t = startFromInput(input.startsAt).getTime();
  if (Number.isNaN(t)) return 'Choose a valid start time.';
  if (t - now.getTime() < 15 * MIN) return 'The start time must be at least 15 minutes from now.';
  if (t - now.getTime() > 30 * 24 * 60 * MIN) return 'The start time must be no more than 30 days from now.';
  const m = input.expectedMinutes;
  if (!Number.isInteger(m) || m < 5 || m > 240) return 'The expected length must be between 5 and 240 minutes.';
  const n = Array.from(input.reason.trim()).length;
  if (n < 1 || n > 1000) return 'Give a reason (up to 1,000 characters).';
  return null;
}

/** Protective mode on the Operations page: update maintenance has its own text and no Resume (only the updater ends it). */
export function protectiveWords(p: Pick<Protective, 'on' | 'reason'>): { text: string; why: string; canResume: boolean } {
  if (!p.on) return { text: '', why: '', canResume: false };
  if (p.reason === 'update') return { text: UPDATE_TEXT, why: 'Kainow is being updated. The update ends this mode itself when it finishes.', canResume: false };
  if (p.reason === 'restored_from_backup') return { text: PROTECTIVE_TEXT, why: 'Kainow was restored from a backup.', canResume: true };
  return { text: PROTECTIVE_TEXT, why: 'Free space on the database disk fell below the safe floor.', canResume: true };
}

/** The sign-in page's line: the update text during update maintenance, the protective sentence otherwise. */
export function signInLine(s: { protective: boolean; reason?: string }): string | null {
  if (!s.protective) return null;
  return s.reason === 'update' ? UPDATE_TEXT : BANNER_EVERYONE;
}

const STEP_WORDS: Record<string, string> = {
  space: 'Free space to prepare',
  working_tree: 'Installation folder unchanged',
  verify: 'Release signature checked',
  staging: 'New version staged',
  compatibility: 'Release can be installed by the updater',
  build: 'New version built',
  recheck: 'Release checked again',
  maintenance_on: 'Changes paused',
  backup: 'Backup before the update',
  stop: 'Kainow stopped',
  switch_code: 'New version put in place',
  migrate: 'Database updated',
  start: 'Kainow started',
  health: 'Health checks',
  maintenance_off: 'Changes allowed again',
  tidy: 'Old versions tidied',
  go_back: 'Gone back to the previous version',
  notice_page: 'Notice page shown',
};
export const stepWords = (s: string): string => STEP_WORDS[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function stepOutcomeWords(o: UpdateStep['outcome']): string {
  return o === 'passed' ? 'Passed' : o === 'failed' ? 'Failed' : o === 'skipped' ? 'Skipped' : 'Running';
}

const CHECK_FAILURE_WORDS: Record<string, string> = {
  unreachable: 'GitHub could not be reached',
  bad_response: 'GitHub gave an answer Kainow could not read',
  rate_limited: 'GitHub asked Kainow to wait before checking again',
};

/** The last release check in words: 'Found v1.3.0', 'No newer release', or 'Last check failed: GitHub could not be reached'. */
export function checkWords(c: LatestCheck['latest']): string {
  if (!c) return 'Not checked yet';
  if (c.outcome === 'failed') return `Last check failed: ${CHECK_FAILURE_WORDS[c.failureCode ?? ''] ?? 'the check did not finish'}`;
  if (c.outcome === 'found') return c.newestTag ? `Found ${c.newestTag}` : 'Found a newer release';
  return 'No newer release';
}
