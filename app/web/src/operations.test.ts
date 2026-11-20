import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
