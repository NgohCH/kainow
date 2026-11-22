import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAILURE_TEXT, type FailureCode, OPEN_STATES, type UpdateState, approvalWindowProblem, canTransition, reminderDue,
  stateWords,
} from './states';

const ALL: UpdateState[] = ['approved', 'preparing', 'ready', 'installing', 'succeeded', 'refused', 'failed_before_install',
  'failed_after_migration', 'failed_needs_attention', 'recovered', 'cancelled'];

const ARROWS: Array<[UpdateState, UpdateState]> = [
  ['approved', 'preparing'], ['preparing', 'ready'], ['ready', 'installing'], ['installing', 'succeeded'],
  ['installing', 'failed_before_install'], ['installing', 'failed_after_migration'], ['installing', 'failed_needs_attention'],
  ['failed_after_migration', 'recovered'], ['failed_needs_attention', 'recovered'],
  ['preparing', 'refused'], ['ready', 'refused'], ['preparing', 'failed_before_install'], ['ready', 'failed_before_install'],
  ['approved', 'cancelled'], ['preparing', 'cancelled'], ['ready', 'cancelled'],
];

test('canTransition allows exactly the arrows of the state diagram', () => {
  const allowed = new Set(ARROWS.map(([a, b]) => `${a}>${b}`));
  for (const [a, b] of ARROWS) assert.equal(canTransition(a, b), true, `${a} -> ${b}`);
  for (const a of ALL) for (const b of ALL) {
    if (!allowed.has(`${a}>${b}`)) assert.equal(canTransition(a, b), false, `${a} -> ${b}`);
  }
});

test('succeeded cannot go back; recovered is final; installing cannot be cancelled', () => {
  assert.equal(canTransition('succeeded', 'installing'), false);
  for (const to of ALL) assert.equal(canTransition('recovered', to), false, `recovered -> ${to}`);
  assert.equal(canTransition('installing', 'cancelled'), false);
});

test('OPEN_STATES are the four the unique index covers', () => {
  assert.deepEqual([...OPEN_STATES].sort(), ['approved', 'installing', 'preparing', 'ready']);
});

const CODES: FailureCode[] = ['local_changes', 'not_on_release', 'no_space_to_build', 'settings_missing', 'db_service_changed',
  'manual_install', 'upgrade_path', 'backup_busy', 'fetch_failed', 'not_annotated', 'tag_name_mismatch', 'signature_invalid',
  'commit_mismatch', 'version_mismatch', 'not_newer', 'tag_changed', 'build_failed', 'build_timeout', 'protective_on',
  'backup_failed', 'checkout_failed', 'migration_failed', 'start_failed', 'health_failed', 'rollback_failed',
  'image_version_mismatch', 'window_missed'];

test('every FailureCode has text without a slash or URL', () => {
  assert.deepEqual(Object.keys(FAILURE_TEXT).sort(), [...CODES].sort());
  for (const c of CODES) {
    const t = FAILURE_TEXT[c];
    assert.ok(t.length > 10, c);
    assert.ok(!t.includes('/') && !t.includes('\\') && !t.includes('://'), c);
  }
});

test('every state has words for the page', () => {
  for (const s of ALL) assert.ok(stateWords(s).length > 3, s);
});

const NOW = new Date('2026-11-22T00:00:00Z');
const ahead = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;

test('approvalWindowProblem: start time bounds', () => {
  assert.notEqual(approvalWindowProblem(ahead(14 * MIN + 59_000), NOW, 30), null); // 14:59
  assert.equal(approvalWindowProblem(ahead(15 * MIN), NOW, 30), null);
  assert.equal(approvalWindowProblem(ahead(30 * 24 * 60 * MIN), NOW, 30), null);
  assert.notEqual(approvalWindowProblem(ahead((30 * 24 * 60 + 1) * MIN), NOW, 30), null);
  assert.notEqual(approvalWindowProblem(new Date('invalid'), NOW, 30), null);
});

test('approvalWindowProblem: length bounds', () => {
  assert.notEqual(approvalWindowProblem(ahead(60 * MIN), NOW, 4), null);
  assert.equal(approvalWindowProblem(ahead(60 * MIN), NOW, 5), null);
  assert.equal(approvalWindowProblem(ahead(60 * MIN), NOW, 240), null);
  assert.notEqual(approvalWindowProblem(ahead(60 * MIN), NOW, 241), null);
  assert.notEqual(approvalWindowProblem(ahead(60 * MIN), NOW, 30.5), null);
});

test('reminderDue', () => {
  const starts = new Date('2026-11-25T00:00:00Z');
  const h = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);
  // approved 23 h ahead: no reminder
  assert.equal(reminderDue({ approvedAt: h(starts, -23), startsAt: starts, reminderSentAt: null }, h(starts, -22)), false);
  // approved 48 h ahead
  const u = { approvedAt: h(starts, -48), startsAt: starts, reminderSentAt: null };
  assert.equal(reminderDue(u, h(starts, -24.01)), false);
  assert.equal(reminderDue(u, h(starts, -24)), true);
  assert.equal(reminderDue(u, h(starts, -1)), true);
  assert.equal(reminderDue(u, starts), false);
  assert.equal(reminderDue({ ...u, reminderSentAt: h(starts, -24) }, h(starts, -1)), false);
  // approved exactly 24 h ahead is not "more than 24 h"
  assert.equal(reminderDue({ approvedAt: h(starts, -24), startsAt: starts, reminderSentAt: null }, h(starts, -1)), false);
});
