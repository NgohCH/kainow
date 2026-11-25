import assert from 'node:assert/strict';
import { test } from 'node:test';
import { departmentName, departmentOptions, departmentToSave, endedText, sinceText, untilText } from './profile.ts';

const active = [{ id: 'a', name: 'Finance', status: 'active' as const }, { id: 'b', name: 'Operations', status: 'active' as const }];

test('a department shows its name, marked when retired, or None', () => {
  assert.equal(departmentName(null), 'None');
  assert.equal(departmentName({ id: 'a', name: 'Finance', retired: false }), 'Finance');
  assert.equal(departmentName({ id: 'z', name: 'Archive', retired: true }), 'Archive (retired)');
});

test('the choices are none and the active departments; a retired one only while it is held', () => {
  assert.deepEqual(departmentOptions(active, null), [{ id: '', label: 'None' }, { id: 'a', label: 'Finance' }, { id: 'b', label: 'Operations' }]);
  assert.deepEqual(departmentOptions(active, { id: 'a', name: 'Finance', retired: false }).map((o) => o.id), ['', 'a', 'b']);
  assert.deepEqual(departmentOptions(active, { id: 'z', name: 'Archive', retired: true }).at(-1), { id: 'z', label: 'Archive (retired)' });
  // Retired since the page loaded: gone from the active list, still held, so still offered as the current choice.
  assert.deepEqual(departmentOptions(active, { id: 'y', name: 'Old', retired: false }).at(-1), { id: 'y', label: 'Old (retired)' });
});

test('before the list has loaded only what is held shows, marked when retired', () => {
  assert.deepEqual(departmentOptions(null, null), [{ id: '', label: 'None' }]);
  assert.deepEqual(departmentOptions(null, { id: 'a', name: 'Finance', retired: false }), [{ id: 'a', label: 'Finance' }]);
  assert.deepEqual(departmentOptions(null, { id: 'z', name: 'Archive', retired: true }), [{ id: 'z', label: 'Archive (retired)' }]);
});

test('an unchanged department is never sent, retired or not; a change sends its id or null', () => {
  const retired = { id: 'z', name: 'Archive', retired: true };
  assert.equal(departmentToSave(retired, 'z'), undefined);
  assert.equal(departmentToSave(null, ''), undefined);
  assert.equal(departmentToSave(retired, ''), null);
  assert.equal(departmentToSave(retired, 'a'), 'a');
  assert.equal(departmentToSave(null, 'b'), 'b');
});

test('role dates: no end date, starts later, ended, and never started', () => {
  assert.equal(untilText(null), 'No end date');
  assert.equal(untilText('2026-12-31'), '31 Dec 2026');
  assert.equal(sinceText('2026-11-25', '2026-11-25'), '25 Nov 2026');
  assert.equal(sinceText('2026-12-01', '2026-11-25'), 'Starts 1 Dec 2026');
  assert.equal(endedText('2026-01-01', '2026-03-02'), '2 Mar 2026');
  assert.equal(endedText('2026-01-01', '2026-01-01'), '1 Jan 2026');
  assert.equal(endedText('2026-12-01', '2026-11-20'), 'Never started (withdrawn 20 Nov 2026)');
});
