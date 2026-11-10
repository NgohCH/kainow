import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kindText, parseLeadDays, previewIsEmpty, previewTitle } from './settings.ts';

test('lead days are read from commas and spaces', () => {
  assert.deepEqual(parseLeadDays('7, 1'), [7, 1]);
  assert.deepEqual(parseLeadDays(' 14 3  1 '), [14, 3, 1]);
  assert.deepEqual(parseLeadDays(''), []);
});

test('a word in the lead days becomes NaN so the server can refuse it', () => {
  assert.ok(Number.isNaN(parseLeadDays('7, soon')[1]));
  assert.ok(Number.isNaN(parseLeadDays('-1')[0]));
});

test('a preview with nothing in it is empty', () => {
  assert.equal(previewIsEmpty({ moved: [], added: [], removed: [] }), true);
  const item = { recordKind: 'task', recordId: 'a', title: 't', kind: 'reminder', from: null, to: null };
  assert.equal(previewIsEmpty({ moved: [], added: [item], removed: [] }), false);
});

test('an unknown notice kind is still readable', () => {
  assert.equal(kindText('assignee_unavailable'), 'assignee unavailable');
  assert.equal(kindText('reminder'), 'Reminder');
});

import { buildChanges, draftFrom, type Current } from './settings.ts';

const start: Current = {
  dayCounting: 'working', weekdays: [1, 2, 3, 4, 5], leadDays: [7, 1], escalationDays: 3, sweepMinutes: 15,
  projectsMayChangeCalendar: false, projectsMayChangeTimings: false, projectsMayChangeDigest: false,
  own: { digestEnabled: false, digestFrequency: null, digestWeekday: null, digestTime: null },
};

test('an untouched form changes nothing', () => {
  assert.deepEqual(buildChanges('organisation', start, draftFrom(start)), {});
  assert.deepEqual(buildChanges('project', start, draftFrom(start)), {});
});

test('only the settings that differ are sent', () => {
  const d = { ...draftFrom(start), leadText: '5, 1', escalation: '4', mayTimings: true };
  assert.deepEqual(buildChanges('organisation', start, d), { leadDays: [5, 1], escalationDays: 4, projectsMayChangeTimings: true });
});

test('a project hands a setting back to the organisation with null', () => {
  const d = draftFrom(start);
  assert.deepEqual(buildChanges('project', start, d, new Set(['leadDays'])), { leadDays: null });
});

test('a project never sends organisation-only settings', () => {
  const d = { ...draftFrom(start), sweep: '30', mayCalendar: true };
  assert.deepEqual(buildChanges('project', start, d), {});
});

test('turning the digest on sends its schedule; weekday only when weekly', () => {
  const daily = { ...draftFrom(start), digestEnabled: true };
  assert.deepEqual(buildChanges('project', start, daily), { digestEnabled: true, digestFrequency: 'daily', digestTime: '09:00' });
  const weekly = { ...daily, digestFrequency: 'weekly' as const, digestWeekday: 3 };
  assert.deepEqual(buildChanges('project', start, weekly), { digestEnabled: true, digestFrequency: 'weekly', digestTime: '09:00', digestWeekday: 3 });
});

test('weekday order does not matter', () => {
  const d = { ...draftFrom(start), weekdays: [5, 4, 3, 2, 1] };
  assert.deepEqual(buildChanges('organisation', start, d), {});
});

import { BLANK_ESCALATION, BLANK_SWEEP, changeErrors } from './settings.ts';

test('a blank escalation delay or sweep interval is refused before sending', () => {
  const d = { ...draftFrom(start), escalation: ' ', sweep: '' };
  assert.deepEqual(changeErrors('organisation', d), [BLANK_ESCALATION, BLANK_SWEEP]);
  assert.deepEqual(changeErrors('project', d), [BLANK_ESCALATION]);
  assert.deepEqual(changeErrors('project', d, new Set(['escalationDays'])), []);
  assert.deepEqual(changeErrors('project', draftFrom(start)), []);
});

test('a preview line without a title names only the record kind and the project', () => {
  const base = { projectId: 'p1', projectName: 'Harbour Works', recordId: 'r1', kind: 'reminder', from: null, to: null };
  assert.equal(previewTitle({ ...base, recordKind: 'task', title: null }), 'A task in Harbour Works');
  assert.equal(previewTitle({ ...base, recordKind: 'risk', title: null }), 'A risk in Harbour Works');
  assert.equal(previewTitle({ ...base, recordKind: 'task', title: 'Write the report' }), 'Write the report');
  assert.equal(previewTitle({ ...base, recordKind: 'task', title: '' }), 'Untitled');
});
