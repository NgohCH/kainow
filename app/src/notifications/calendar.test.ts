import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Calendar, addWorkingDays, deadlineOf, escalationAt, isWorkingDay, nextSlot,
  reminderAt, riskDueAt, riskMissedAt, slotOn, stepBackWorking,
} from './calendar';

const working: Calendar = { dayCounting: 'working', weekdays: [1, 2, 3, 4, 5], holidays: new Set(['2026-11-20']) };
const noHoliday: Calendar = { ...working, holidays: new Set() };
const calendar: Calendar = { ...working, dayCounting: 'calendar' };
const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');

test('working day rules', () => {
  assert.equal(isWorkingDay(working, '2026-11-19'), true);
  assert.equal(isWorkingDay(working, '2026-11-20'), false); // holiday
  assert.equal(isWorkingDay(working, '2026-11-21'), false); // Saturday
  assert.equal(isWorkingDay(working, '2026-11-22'), false); // Sunday
  assert.equal(isWorkingDay(calendar, '2026-11-20'), true);
  assert.equal(isWorkingDay(calendar, '2026-11-21'), true);
});

test('stepping and adding working days', () => {
  assert.equal(stepBackWorking(working, '2026-11-23', 1), '2026-11-19');
  assert.equal(stepBackWorking(working, '2026-11-21', 1), '2026-11-19');
  assert.equal(stepBackWorking(calendar, '2026-11-21', 1), '2026-11-20');
  assert.equal(stepBackWorking(working, '2026-11-23', 0), '2026-11-23');
  assert.equal(addWorkingDays(working, '2026-11-16', 3), '2026-11-19');
  assert.equal(addWorkingDays(working, '2026-11-13', 3), '2026-11-18');
  assert.equal(addWorkingDays(calendar, '2026-11-16', 3), '2026-11-19');
});

test('slot and deadline instants are UTC+8', () => {
  assert.equal(iso(slotOn('2026-11-16')), '2026-11-16T01:00:00Z');
  assert.equal(iso(deadlineOf('2026-11-16')), '2026-11-16T15:59:59Z');
});

test('reminders', () => {
  assert.equal(iso(reminderAt(working, '2026-11-16', 1)), '2026-11-13T01:00:00Z');
  assert.equal(iso(reminderAt(working, '2026-11-21', 1)), '2026-11-19T01:00:00Z');
  assert.equal(iso(reminderAt(working, '2026-11-23', 7)), '2026-11-11T01:00:00Z');
  assert.equal(iso(reminderAt(calendar, '2026-11-21', 1)), '2026-11-20T01:00:00Z');
});

test('escalations', () => {
  assert.equal(iso(escalationAt(working, '2026-11-16', 3)), '2026-11-23T01:00:00Z');
  assert.equal(iso(escalationAt(noHoliday, '2026-11-16', 3)), '2026-11-20T01:00:00Z');
  assert.equal(iso(escalationAt(working, '2026-11-13', 3)), '2026-11-19T01:00:00Z');
  assert.equal(iso(escalationAt(calendar, '2026-11-16', 3)), '2026-11-20T01:00:00Z');
});

test('next slot', () => {
  assert.equal(iso(nextSlot(working, new Date('2026-11-14T03:00:00Z'))), '2026-11-16T01:00:00Z');
  assert.equal(iso(nextSlot(working, new Date('2026-11-16T01:00:00Z'))), '2026-11-16T01:00:00Z');
  assert.equal(iso(nextSlot(working, new Date('2026-11-16T01:00:01Z'))), '2026-11-17T01:00:00Z');
  assert.equal(iso(nextSlot(working, new Date('2026-11-15T17:00:00Z'))), '2026-11-16T01:00:00Z'); // Mon 01:00 UTC+8
});

test('risk review notices', () => {
  assert.equal(iso(riskDueAt(working, '2026-11-22')), '2026-11-19T01:00:00Z');
  assert.equal(iso(riskDueAt(working, '2026-11-17')), '2026-11-17T01:00:00Z');
  assert.equal(iso(riskMissedAt(working, '2026-11-17')), '2026-11-18T01:00:00Z');
});

test('a calendar with no working day is an error', () => {
  const none: Calendar = { dayCounting: 'working', weekdays: [], holidays: new Set() };
  assert.throws(() => stepBackWorking(none, '2026-11-16', 1));
  assert.throws(() => nextSlot(none, new Date('2026-11-16T00:00:00Z')));
});
