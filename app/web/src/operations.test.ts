import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPROVAL_HINT,
  NO_FRESH_BACKUP_TEXT,
  RELEASE_CHECK_NOTE,
  UPDATE_TEXT,
  approvalFormProblem,
  protectiveWords,
  scheduledBanner,
  signInLine,
  soonestStartValue,
  stepWords,
  updateStatusWord,
  BANNER_EVERYONE,
  PROTECTIVE_TEXT,
  backupStatusWords,
  bannerLines,
  checkResultWords,
  drillFailureLines,
  drillOutcomeWords,
  formatBytes,
  growthTable,
  levelWords,
  locationWords,
  resumeCheckWords,
} from './operations.ts';

test('every backup status and storage level has words', () => {
  assert.equal(backupStatusWords('healthy'), 'Healthy');
  assert.equal(backupStatusWords('last_failed'), 'Last backup failed');
  assert.equal(backupStatusWords('target_exceeded'), '24-hour recovery target exceeded');
  assert.equal(backupStatusWords('none'), 'No backup yet');
  for (const l of ['normal', 'warning', 'critical', 'unknown'] as const) assert.ok(levelWords(l).length > 0);
  assert.notEqual(levelWords('warning'), levelWords('critical'));
});

test('every location and resume check has words', () => {
  for (const l of ['database_disk', 'backup_disk', 'source_area'] as const) assert.ok(locationWords(l).length > 0);
  for (const c of ['reading_fresh', 'space_above_floor', 'database', 'migrations_current', 'no_backup_running']) {
    assert.ok(resumeCheckWords(c).length > 0);
    assert.notEqual(resumeCheckWords(c), c);
  }
  assert.equal(resumeCheckWords('something_new'), 'something new');
});

test('formatBytes', () => {
  assert.equal(formatBytes(null), 'Unavailable');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1,023 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
});

test('the fixed protective texts are exact', () => {
  assert.equal(BANNER_EVERYONE, 'Kainow is read-only for now to protect your data. You can read everything; changes are paused.');
  assert.equal(PROTECTIVE_TEXT, 'Kainow is read-only for now to protect your data. Nothing you have saved is affected.');
});

test('bannerLines: the protective sentence for everyone, the backup line only for an administrator', () => {
  const b = { protective: true, admin: { backups: 'target_exceeded', storage: 'normal', text: 'Backups: 24-hour recovery target exceeded.', link: '#/admin/operations' } } as const;
  assert.deepEqual(bannerLines({ protective: true }, false), [BANNER_EVERYONE]);
  assert.deepEqual(bannerLines(b, false), [BANNER_EVERYONE]);
  assert.deepEqual(bannerLines(b, true), [BANNER_EVERYONE, 'Backups: 24-hour recovery target exceeded.']);
  assert.deepEqual(bannerLines({ protective: false, admin: { ...b.admin, text: '' } }, true), []);
  assert.deepEqual(bannerLines({ protective: false }, true), []);
  assert.deepEqual(bannerLines({ protective: false, admin: b.admin }, false), []);
});

test('growthTable sorts by day ascending and words missing figures', () => {
  const rows = [
    { day: '2026-11-03', location: 'database_disk', maxUsedBytes: 2048, minFreeBytes: 1024, totalBytes: 3072 },
    { day: '2026-11-01', location: 'database_disk', maxUsedBytes: null, minFreeBytes: null, totalBytes: null },
    { day: '2026-11-02', location: 'database_disk', maxUsedBytes: 0, minFreeBytes: 3072, totalBytes: 3072 },
  ] as const;
  const t = growthTable([...rows]);
  assert.deepEqual(t.map((r) => r.day), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.deepEqual(t[0], { day: '2026-11-01', used: 'Unavailable', free: 'Unavailable' });
  assert.deepEqual(t[2], { day: '2026-11-03', used: '2.0 KB', free: '1.0 KB' });
});

test('drill words, and a failed drill without a code names the failed checks', () => {
  assert.equal(drillOutcomeWords('passed'), 'Passed');
  assert.equal(drillOutcomeWords('passed_over_target'), 'Passed, but slower than the 4-hour target');
  assert.equal(drillOutcomeWords('failed'), 'Failed');
  assert.equal(drillOutcomeWords('running'), 'Running');
  assert.equal(checkResultWords('not_tested'), 'Not tested');
  const checks = [
    { name: 'set_checksums', result: 'passed' },
    { name: 'row_counts', result: 'failed', detail: '2 tables differ.' },
    { name: 'source_files', result: 'not_tested' },
  ];
  assert.deepEqual(drillFailureLines({ outcome: 'failed', failureCode: null, failureText: null, checks }), ['Row counts: failed. 2 tables differ.']);
  assert.deepEqual(drillFailureLines({ outcome: 'failed', failureCode: 'dump_failed', failureText: 'The database copy failed.', checks }), ['The database copy failed.']);
  assert.deepEqual(drillFailureLines({ outcome: 'passed', failureCode: null, failureText: null, checks }), []);
});

// --- Updates (10b) ---

const summary = (over: Partial<Parameters<typeof updateStatusWord>[0]> = {}) => ({
  latestState: null,
  latestToVersion: null,
  startsAt: null,
  available: null,
  lastCheckAt: '2026-11-22T00:00:00Z',
  stale: false,
  ...over,
});

test('the fixed update texts are exact', () => {
  assert.equal(UPDATE_TEXT, 'Kainow is being updated. You can read; changes are paused until the update finishes.');
  assert.equal(APPROVAL_HINT, 'The update takes its own backup first and stops if that backup fails.');
  assert.equal(RELEASE_CHECK_NOTE, 'Signature checked before installing.');
  assert.equal(NO_FRESH_BACKUP_TEXT, 'Updates are refused until a backup succeeds. See Backups above.');
});

test('updateStatusWord: each status word', () => {
  assert.equal(updateStatusWord(summary()), 'Up to date');
  assert.equal(updateStatusWord(summary({ available: 'v1.3.0' })), 'Update available');
  for (const s of ['approved', 'preparing', 'ready', 'installing'] as const) {
    assert.equal(updateStatusWord(summary({ latestState: s, available: 'v1.3.0', startsAt: '2026-11-23T00:00:00Z' })), 'Update scheduled');
  }
  for (const s of ['failed_before_install', 'failed_after_migration', 'failed_needs_attention', 'refused'] as const) {
    assert.equal(updateStatusWord(summary({ latestState: s, available: 'v1.3.0' })), 'Update failed');
  }
  // Recovered is settled: the tile is no longer red after recovery and Resume (final review #40).
  assert.equal(updateStatusWord(summary({ latestState: 'recovered', available: 'v1.3.0' })), 'Update available');
  assert.equal(updateStatusWord(summary({ latestState: 'recovered' })), 'Up to date');
  // Never checked is not "Up to date" (final review #39).
  assert.equal(updateStatusWord(summary({ lastCheckAt: null })), 'Not checked yet');
  assert.equal(updateStatusWord(summary({ stale: true, available: 'v1.3.0' })), 'Not checked for 3 days');
  // A finished update is not a status of its own: what is available decides.
  assert.equal(updateStatusWord(summary({ latestState: 'succeeded' })), 'Up to date');
  assert.equal(updateStatusWord(summary({ latestState: 'cancelled', available: 'v1.3.0' })), 'Update available');
  // A failed update outranks a stale check.
  assert.equal(updateStatusWord(summary({ latestState: 'failed_before_install', stale: true })), 'Update failed');
});

test('scheduledBanner: the fixed sentence with the UTC+8 date and time, only before the start', () => {
  const s = { startsAt: '2026-11-30T14:00:00Z', expectedMinutes: 45 };
  const now = new Date('2026-11-22T00:00:00Z');
  assert.equal(scheduledBanner(s, now), 'Kainow will be unavailable on Mon 30 Nov from 22:00 for about 45 minutes for an update.');
  // 16:30 UTC is 00:30 the next day in UTC+8.
  assert.equal(scheduledBanner({ startsAt: '2026-11-30T16:30:00Z', expectedMinutes: 30 }, now), 'Kainow will be unavailable on Tue 1 Dec from 00:30 for about 30 minutes for an update.');
  assert.equal(scheduledBanner(s, new Date('2026-11-30T14:00:00Z')), '');
  assert.equal(scheduledBanner(null, now), '');
});

test('approvalFormProblem mirrors the server bounds: 15 minutes to 30 days ahead, 5 to 240 minutes, a reason', () => {
  const now = new Date('2026-11-22T02:00:00Z'); // 10:00 in UTC+8
  const ok = { startsAt: '2026-11-22T10:15', expectedMinutes: 30, reason: 'Security fix' };
  assert.equal(approvalFormProblem(ok, now), null);
  assert.equal(approvalFormProblem({ ...ok, startsAt: '2026-11-22T10:14' }, now), 'The start time must be at least 15 minutes from now.');
  assert.equal(approvalFormProblem({ ...ok, startsAt: '2026-12-22T10:00' }, now), null); // exactly 30 days
  assert.equal(approvalFormProblem({ ...ok, startsAt: '2026-12-22T10:01' }, now), 'The start time must be no more than 30 days from now.');
  assert.equal(approvalFormProblem({ ...ok, startsAt: '' }, now), 'Choose a valid start time.');
  assert.equal(approvalFormProblem({ ...ok, expectedMinutes: 4 }, now), 'The expected length must be between 5 and 240 minutes.');
  assert.equal(approvalFormProblem({ ...ok, expectedMinutes: 241 }, now), 'The expected length must be between 5 and 240 minutes.');
  assert.equal(approvalFormProblem({ ...ok, expectedMinutes: 5 }, now), null);
  assert.equal(approvalFormProblem({ ...ok, expectedMinutes: 240 }, now), null);
  assert.equal(approvalFormProblem({ ...ok, expectedMinutes: 30.5 }, now), 'The expected length must be between 5 and 240 minutes.');
  assert.equal(approvalFormProblem({ ...ok, reason: '  ' }, now), 'Give a reason (up to 1,000 characters).');
});

test('soonestStartValue: UTC+8, a whole minute, never less than 15 minutes ahead when sent', () => {
  const now = new Date('2026-11-22T02:00:20Z');
  const v = soonestStartValue(now);
  assert.equal(v, '2026-11-22T10:17');
  assert.equal(approvalFormProblem({ startsAt: v, expectedMinutes: 30, reason: 'x' }, new Date(now.getTime() + 30_000)), null);
});

test('maintenance for an update shows the update text, not the protective one, and no Resume', () => {
  const upd = protectiveWords({ on: true, reason: 'update' });
  assert.equal(upd.text, UPDATE_TEXT);
  assert.equal(upd.canResume, false);
  const low = protectiveWords({ on: true, reason: 'low_space' });
  assert.equal(low.text, PROTECTIVE_TEXT);
  assert.equal(low.canResume, true);
  assert.equal(protectiveWords({ on: true, reason: 'restored_from_backup' }).canResume, true);
  assert.equal(protectiveWords({ on: false, reason: null }).canResume, false);

  // The banner for everyone.
  const banner = { protective: true, reason: 'update' as const, text: UPDATE_TEXT, scheduled: null };
  assert.deepEqual(bannerLines(banner, false), [UPDATE_TEXT]);
  assert.ok(!bannerLines(banner, true).includes(BANNER_EVERYONE));
  // The sign-in line.
  assert.equal(signInLine({ protective: true, reason: 'update' }), UPDATE_TEXT);
  assert.equal(signInLine({ protective: true }), BANNER_EVERYONE);
  assert.equal(signInLine({ protective: false }), null);
});

test('bannerLines: the scheduled update for everyone; the recovery warning for an administrator only', () => {
  const now = new Date('2026-11-22T00:00:00Z');
  const scheduled = { startsAt: '2026-11-30T14:00:00Z', expectedMinutes: 30, text: 'ignored' };
  const line = 'Kainow will be unavailable on Mon 30 Nov from 22:00 for about 30 minutes for an update.';
  assert.deepEqual(bannerLines({ protective: false, scheduled }, false, now), [line]);
  assert.deepEqual(bannerLines({ protective: false, scheduled }, false, new Date('2026-11-30T14:00:01Z')), []);
  const recovery = 'The update to v1.3.0 failed. Kainow is on the notice page for everyone else; the server operator must run the recovery command (INSTALL.md, \'After a failed update\').';
  const admin = { backups: 'healthy', storage: 'normal', text: '', link: '#/admin/operations', recovery } as const;
  assert.deepEqual(bannerLines({ protective: true, scheduled: null, admin }, true, now), [recovery, BANNER_EVERYONE]);
  assert.deepEqual(bannerLines({ protective: true, scheduled: null, admin }, false, now), [BANNER_EVERYONE]);
});

const STEP_NAMES = ['space', 'working_tree', 'verify', 'staging', 'compatibility', 'build', 'recheck', 'maintenance_on', 'backup', 'stop'];
const MORE_STEPS = ['switch_code', 'migrate', 'start', 'health', 'maintenance_off', 'tidy', 'go_back', 'notice_page'];

test('every update step has words', () => {
  for (const s of [...STEP_NAMES, ...MORE_STEPS]) assert.notEqual(stepWords(s), s);
  assert.equal(stepWords('new_step'), 'New step');
});
