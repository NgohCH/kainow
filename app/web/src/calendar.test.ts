import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWorkingDayClient, modeLabel, type CalendarSettings } from './calendar.ts';

const weekdays = (days: number[], over: Partial<CalendarSettings> = {}): CalendarSettings => ({ dayCounting: 'working', weekdays: days, holidays: [], ...over });
const MON_FRI = [1, 2, 3, 4, 5];

test('modeLabel names Monday to Friday', () => {
  assert.equal(modeLabel(weekdays(MON_FRI)), 'Working Days, Mon–Fri');
});

test('modeLabel names Monday to Saturday', () => {
  assert.equal(modeLabel(weekdays([1, 2, 3, 4, 5, 6])), 'Working Days, Mon–Sat');
});

test('modeLabel lists days that are not contiguous', () => {
  assert.equal(modeLabel(weekdays([5, 1, 3])), 'Working Days, Mon, Wed, Fri');
  assert.equal(modeLabel(weekdays([1, 2, 4, 5, 6])), 'Working Days, Mon, Tue, Thu–Sat');
  assert.equal(modeLabel(weekdays([7])), 'Working Days, Sun');
});

test('modeLabel in calendar mode ignores the weekdays', () => {
  assert.equal(modeLabel(weekdays(MON_FRI, { dayCounting: 'calendar' })), 'Calendar Days');
});

test('a weekend is not a working day, a weekday is', () => {
  const s = weekdays(MON_FRI);
  assert.equal(isWorkingDayClient(s, '2026-11-13'), true); // Friday
  assert.equal(isWorkingDayClient(s, '2026-11-14'), false); // Saturday
  assert.equal(isWorkingDayClient(s, '2026-11-15'), false); // Sunday
  assert.equal(isWorkingDayClient(weekdays([1, 2, 3, 4, 5, 6]), '2026-11-14'), true);
});

test('a holiday is not a working day', () => {
  const s = weekdays(MON_FRI, { holidays: ['2026-11-12'] });
  assert.equal(isWorkingDayClient(s, '2026-11-12'), false);
  assert.equal(isWorkingDayClient(s, '2026-11-11'), true);
});

test('calendar mode: every day counts, holidays included', () => {
  const s = weekdays(MON_FRI, { dayCounting: 'calendar', holidays: ['2026-11-12'] });
  assert.equal(isWorkingDayClient(s, '2026-11-14'), true);
  assert.equal(isWorkingDayClient(s, '2026-11-12'), true);
});

test('an empty or malformed date is not judged', () => {
  assert.equal(isWorkingDayClient(weekdays(MON_FRI), ''), true);
  assert.equal(isWorkingDayClient(weekdays(MON_FRI), 'soon'), true);
});
