import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Calendar } from '../notifications/calendar';
import { dueSoonEnd } from './due-soon';

const working: Calendar = { dayCounting: 'working', weekdays: [1, 2, 3, 4, 5], holidays: new Set() };

test('seven working days on, a holiday shifts it, calendar mode counts plain days', () => {
  assert.equal(dueSoonEnd('2026-11-19', working), '2026-11-30');
  assert.equal(dueSoonEnd('2026-11-19', { ...working, holidays: new Set(['2026-11-25']) }), '2026-12-01');
  assert.equal(dueSoonEnd('2026-11-19', { ...working, dayCounting: 'calendar' }), '2026-11-26');
});

test('a calendar with no working day for a year falls back to plain days instead of throwing', () => {
  const holidays = new Set<string>();
  for (let i = 0; i < 400; i++) holidays.add(new Date(Date.UTC(2026, 10, 1) + i * 86_400_000).toISOString().slice(0, 10));
  assert.equal(dueSoonEnd('2026-11-19', { ...working, holidays }), '2026-11-26');
});
