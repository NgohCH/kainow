/** Update states, failure codes and approval rules (10b spec 5.8, 6.1, 6.3, 6.4, 9). Pure; no database. */
export type UpdateState =
  | 'approved' | 'preparing' | 'ready' | 'installing' | 'succeeded' | 'refused'
  | 'failed_before_install' | 'failed_after_migration' | 'failed_needs_attention' | 'recovered' | 'cancelled';

/** The states the `updates_one_open` index covers. */
export const OPEN_STATES: readonly UpdateState[] = ['approved', 'preparing', 'ready', 'installing'];

const NEXT: Record<UpdateState, readonly UpdateState[]> = {
  approved: ['preparing', 'failed_before_install', 'cancelled'], // window_missed from the ops sweep (D125)
  preparing: ['ready', 'refused', 'failed_before_install', 'cancelled'],
  ready: ['installing', 'refused', 'failed_before_install', 'cancelled'],
  installing: ['succeeded', 'failed_before_install', 'failed_after_migration', 'failed_needs_attention'],
  succeeded: [],
  refused: [],
  failed_before_install: [],
  failed_after_migration: ['recovered'],
  failed_needs_attention: ['recovered'],
  recovered: [],
  cancelled: [],
};

/** Every state, as the 0034 CHECK lists them (schema.db.test compares the two). */
export const UPDATE_STATES = Object.keys(NEXT) as UpdateState[];

export const canTransition = (from: UpdateState, to: UpdateState): boolean => NEXT[from].includes(to);

export type FailureCode =
  | 'local_changes' | 'not_on_release' | 'no_space_to_build' | 'settings_missing' | 'db_service_changed'
  | 'manual_install' | 'upgrade_path' | 'backup_busy' | 'fetch_failed' | 'not_annotated' | 'tag_name_mismatch'
  | 'signature_invalid' | 'commit_mismatch' | 'version_mismatch' | 'not_newer' | 'tag_changed' | 'build_failed'
  | 'build_timeout' | 'protective_on' | 'backup_failed' | 'checkout_failed' | 'migration_failed' | 'start_failed'
  | 'health_failed' | 'rollback_failed' | 'image_version_mismatch' | 'window_missed';

/** Fixed sentences only: never command output, paths or URLs. */
export const FAILURE_TEXT: Record<FailureCode, string> = {
  local_changes: 'The installation folder has changes that are not part of a release.',
  not_on_release: 'The installation folder is not on a released version.',
  no_space_to_build: 'There is not enough free disk space to prepare the update.',
  settings_missing: 'A required setting for the updater is missing.',
  db_service_changed: 'The database service definition differs in the new release, which an update cannot change.',
  manual_install: 'This release needs steps that must be done by hand; follow the installation guide.',
  upgrade_path: 'This release cannot be reached directly from the running version.',
  backup_busy: 'A backup or restore was running and did not finish in time.',
  fetch_failed: 'The release could not be fetched.',
  not_annotated: 'The release tag is not a signed, annotated tag.',
  tag_name_mismatch: 'The name inside the signed tag does not match the release tag.',
  signature_invalid: 'The release signature could not be verified.',
  commit_mismatch: 'The release tag points at a different commit than the one approved.',
  version_mismatch: 'The version inside the release does not match its tag.',
  not_newer: 'The release is not newer than the running version.',
  tag_changed: 'The release tag changed after it was approved.',
  build_failed: 'The new version could not be built.',
  build_timeout: 'Preparing the new version took too long.',
  protective_on: 'Kainow was in read-only protection, so the update did not start.',
  backup_failed: 'The backup taken before the update failed.',
  checkout_failed: 'The new version could not be put in place.',
  migration_failed: 'The database update failed.',
  start_failed: 'Kainow did not start on the new version.',
  health_failed: 'Kainow did not pass its health checks on the new version.',
  rollback_failed: 'Going back to the previous version failed.',
  image_version_mismatch:
    "The new release's image names do not carry its version, so building it would replace the running version's images.",
  window_missed:
    'The update could not start within an hour of its start time (the updater did not run in time), so it was not installed. Approve it again with a new start time.',
};

/**
 * How late an update may still start (D125, C107): a `ready` row is installed, and an `approved` row prepared, only
 * within 60 minutes of its start time; later it ends `failed_before_install` with `window_missed`. Also the preparation's
 * limit (spec 5.4).
 */
export const WINDOW_GRACE_MS = 60 * 60_000;

/** True when `startsAt` is more than WINDOW_GRACE_MS before `now`. */
export const windowMissed = (startsAt: Date, now: Date): boolean => now.getTime() - startsAt.getTime() > WINDOW_GRACE_MS;

const WORDS: Record<UpdateState, string> = {
  approved: 'Approved, waiting to be prepared',
  preparing: 'Preparing',
  ready: 'Ready, waiting for the start time',
  installing: 'Installing',
  succeeded: 'Succeeded',
  refused: 'Refused before installing',
  failed_before_install: 'Failed before installing; nothing changed',
  failed_after_migration: 'Failed after the database update started; recovery needed',
  failed_needs_attention: 'Failed; needs attention',
  recovered: 'Recovered from backup',
  cancelled: 'Cancelled',
};

export const stateWords = (s: UpdateState): string => WORDS[s];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** null when the window is acceptable (spec 6.3), otherwise a fixed message. */
export function approvalWindowProblem(startsAt: Date, now: Date, minutes: number): string | null {
  const t = startsAt.getTime();
  if (Number.isNaN(t)) return 'Choose a valid start time.';
  if (t - now.getTime() < 15 * MIN) return 'The start time must be at least 15 minutes from now.';
  if (t - now.getTime() > 30 * DAY) return 'The start time must be no more than 30 days from now.';
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) return 'The expected length must be between 5 and 240 minutes.';
  return null;
}

/** Day-before email (spec 6.4): once, from 24 h before the start, only when approved more than 24 h ahead. */
export function reminderDue(
  update: { approvedAt: Date; startsAt: Date; reminderSentAt: Date | null },
  now: Date,
): boolean {
  if (update.reminderSentAt) return false;
  const start = update.startsAt.getTime();
  if (start - update.approvedAt.getTime() <= DAY) return false;
  const t = now.getTime();
  return t >= start - DAY && t < start;
}
