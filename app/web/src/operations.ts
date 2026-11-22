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

export interface BannerData {
  protective: boolean;
  admin?: { backups: BackupStatus; storage: StorageLevel; text: string; link: string };
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
  reason: 'low_space' | 'restored_from_backup' | null;
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
  };
  period: {
    backups: { total: number; succeeded: number; failed: number };
    drills: { total: number; passed: number; failed: number };
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

/** The banner's lines: the protective sentence for everyone; the backup and storage line for an Enterprise Administrator only. */
export function bannerLines(banner: BannerData, isAdmin: boolean): string[] {
  const lines: string[] = [];
  if (banner.protective) lines.push(BANNER_EVERYONE);
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
